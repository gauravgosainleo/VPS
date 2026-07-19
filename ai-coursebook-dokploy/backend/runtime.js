"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const FILES_DIR = path.join(DATA_DIR, "files");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const SHEETS_DIR = path.join(DATA_DIR, "spreadsheets");
const LOCKS_DIR = path.join(DATA_DIR, "locks");
const HTTP_TMP_DIR = path.join(DATA_DIR, "tmp");

for (const directory of [FILES_DIR, CACHE_DIR, SHEETS_DIR, LOCKS_DIR, HTTP_TMP_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

const RPC_METHODS = new Set([
  "fetchLogoBase64",
  "fetchEmployeeList",
  "fetchRmsCourseList",
  "fetchEmpCodeByEmail",
  "generateTOCFromTopic",
  "generateSingleImage",
  "initializeGeneration",
  "processNextChunk",
  "getGeneratedHTML",
  "initializePdfCleanJob",
  "uploadPdfCleanPageBatch",
  "processNextPdfCleanChunk",
  "finalizeCoursebookPdf",
  "savePdfToDrive",
  "logStoppedGeneration",
  "logDownloadEvent",
  "cleanupCompletedJob",
  "fetchUserDashboardData",
  "getResumeConfig",
  "markRowRestarted",
  "checkJobInCache",
  "getJobResumeData",
  "getHtmlBackupInfoForClient",
  "loadBackupHtmlChunkForClient"
]);

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safeSegment(value) {
  return String(value || "local").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180);
}

function sleep(milliseconds) {
  const delay = Math.max(0, Number(milliseconds) || 0);
  if (!delay) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, delay);
}

class LocalBlob {
  constructor(bytes, contentType, name) {
    this.buffer = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes || []);
    this.contentType = contentType || "application/octet-stream";
    this.name = name || "";
  }
  getBytes() { return Buffer.from(this.buffer); }
  getContentType() { return this.contentType; }
  getName() { return this.name; }
  setName(name) { this.name = String(name || ""); return this; }
  getDataAsString() { return this.buffer.toString("utf8"); }
}

class LocalIterator {
  constructor(items) { this.items = items; this.index = 0; }
  hasNext() { return this.index < this.items.length; }
  next() {
    if (!this.hasNext()) throw new Error("Iterator exhausted");
    return this.items[this.index++];
  }
}

function folderIdFor(folderPath) {
  const relative = path.relative(FILES_DIR, folderPath).replace(/\\/g, "/");
  return relative ? `local:${Buffer.from(relative).toString("base64url")}` : "local-root";
}

function resolveFolderId(id) {
  const value = String(id || "");
  if (!value || value === "local-root" || value === process.env.DRIVE_FOLDER_ID) return FILES_DIR;
  if (!value.startsWith("local:")) {
    // Google folder IDs from the old deployment intentionally map to the VPS root.
    return FILES_DIR;
  }
  let relative;
  try { relative = Buffer.from(value.slice(6), "base64url").toString("utf8"); }
  catch { throw new Error("Invalid local folder ID"); }
  const resolved = path.resolve(FILES_DIR, relative);
  if (resolved !== FILES_DIR && !resolved.startsWith(`${FILES_DIR}${path.sep}`)) {
    throw new Error("Invalid local folder path");
  }
  return resolved;
}

class LocalFile {
  constructor(filePath) { this.filePath = filePath; }
  getName() { return path.basename(this.filePath); }
  getId() { return crypto.createHash("sha256").update(this.filePath).digest("hex").slice(0, 24); }
  getBlob() {
    const ext = path.extname(this.filePath).toLowerCase();
    const mime = ext === ".pdf" ? "application/pdf" : ext === ".json" ? "application/json" : "text/plain";
    return new LocalBlob(fs.readFileSync(this.filePath), mime, this.getName());
  }
  setContent(content) {
    fs.writeFileSync(this.filePath, String(content ?? ""), "utf8");
    return this;
  }
  setTrashed(trashed) {
    if (trashed) {
      try { fs.unlinkSync(this.filePath); } catch {}
    }
    return this;
  }
  setSharing() { return this; }
  getUrl() {
    const base = String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
    return `${base}/files/${encodeURIComponent(this.getName())}`;
  }
}

class LocalFolder {
  constructor(folderPath) {
    this.folderPath = folderPath;
    fs.mkdirSync(folderPath, { recursive: true });
  }
  getId() { return folderIdFor(this.folderPath); }
  createFolder(name) {
    const target = path.join(this.folderPath, safeSegment(name));
    fs.mkdirSync(target, { recursive: true });
    return new LocalFolder(target);
  }
  getFoldersByName(name) {
    const target = path.join(this.folderPath, safeSegment(name));
    const items = fs.existsSync(target) && fs.statSync(target).isDirectory() ? [new LocalFolder(target)] : [];
    return new LocalIterator(items);
  }
  createFile(nameOrBlob, content, contentType) {
    if (nameOrBlob instanceof LocalBlob) {
      const filename = safeSegment(nameOrBlob.getName() || `file_${Date.now()}`);
      const target = path.join(this.folderPath, filename);
      fs.writeFileSync(target, nameOrBlob.getBytes());
      return new LocalFile(target);
    }
    const filename = safeSegment(nameOrBlob);
    const target = path.join(this.folderPath, filename);
    if (Buffer.isBuffer(content)) fs.writeFileSync(target, content);
    else fs.writeFileSync(target, String(content ?? ""), "utf8");
    return new LocalFile(target, contentType);
  }
  getFilesByName(name) {
    const target = path.join(this.folderPath, safeSegment(name));
    const items = fs.existsSync(target) && fs.statSync(target).isFile() ? [new LocalFile(target)] : [];
    return new LocalIterator(items);
  }
  getFiles() {
    const items = fs.readdirSync(this.folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => new LocalFile(path.join(this.folderPath, entry.name)));
    return new LocalIterator(items);
  }
}

function createPropertiesService() {
  const propertiesPath = path.join(DATA_DIR, "properties.json");
  const read = () => safeReadJson(propertiesPath, {});
  const aliases = {
    USER_LOGS_SPREADSHEET_ID: "local-user-logs",
    EMPLOYEE_SPREADSHEET_ID: "local-employees",
    DRIVE_FOLDER_ID: "local-root",
  };
  const store = {
    getProperty(key) {
      if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
      const values = read();
      if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
      return aliases[key] || null;
    },
    setProperty(key, value) {
      const values = read();
      values[key] = String(value);
      atomicWriteJson(propertiesPath, values);
      return store;
    },
    deleteProperty(key) {
      const values = read();
      delete values[key];
      atomicWriteJson(propertiesPath, values);
      return store;
    }
  };
  return { getScriptProperties: () => store };
}

function createCacheService() {
  function cachePath(key) {
    return path.join(CACHE_DIR, `${crypto.createHash("sha256").update(String(key)).digest("hex")}.json`);
  }
  const cache = {
    put(key, value, seconds) {
      atomicWriteJson(cachePath(key), {
        value: String(value),
        expiresAt: seconds ? Date.now() + Number(seconds) * 1000 : 0,
      });
    },
    get(key) {
      const filePath = cachePath(key);
      const entry = safeReadJson(filePath, null);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        try { fs.unlinkSync(filePath); } catch {}
        return null;
      }
      return entry.value;
    },
    remove(key) {
      try { fs.unlinkSync(cachePath(key)); } catch {}
    }
  };
  return { getScriptCache: () => cache };
}

function workbookPath(id) {
  return path.join(SHEETS_DIR, `${safeSegment(id)}.json`);
}

function employeeWorkbook() {
  let employees = [];
  try {
    if (process.env.EMPLOYEES_JSON) employees = JSON.parse(process.env.EMPLOYEES_JSON);
    else employees = safeReadJson(path.join(DATA_DIR, "employees.json"), []);
  } catch {
    employees = [];
  }
  const rows = [["Name", "Unused", "Email"]];
  for (const employee of employees) {
    if (employee && employee.name) rows.push([employee.name, "", employee.email || ""]);
  }
  return { sheets: { "All Employee": rows }, activeSheet: "All Employee" };
}

function ensureWorkbook(id) {
  const filePath = workbookPath(id);
  if (!fs.existsSync(filePath)) {
    const initial = id === "local-employees" || id === process.env.EMPLOYEE_SPREADSHEET_ID
      ? employeeWorkbook()
      : { sheets: {}, activeSheet: "" };
    atomicWriteJson(filePath, initial);
  }
  return filePath;
}

function loadWorkbook(id) {
  if (id === "local-employees" || (process.env.EMPLOYEE_SPREADSHEET_ID && id === process.env.EMPLOYEE_SPREADSHEET_ID)) {
    return employeeWorkbook();
  }
  const data = safeReadJson(ensureWorkbook(id), { sheets: {}, activeSheet: "" });
  if (!data.sheets || typeof data.sheets !== "object") data.sheets = {};
  return data;
}

function saveWorkbook(id, data) {
  atomicWriteJson(workbookPath(id), data);
}

function ensureCell(rows, rowIndex, columnIndex) {
  while (rows.length <= rowIndex) rows.push([]);
  while (rows[rowIndex].length <= columnIndex) rows[rowIndex].push("");
}

class LocalRange {
  constructor(workbookId, sheetName, row, column, rowCount, columnCount) {
    this.workbookId = workbookId;
    this.sheetName = sheetName;
    this.row = Math.max(1, Number(row) || 1);
    this.column = Math.max(1, Number(column) || 1);
    this.rowCount = Math.max(1, Number(rowCount) || 1);
    this.columnCount = Math.max(1, Number(columnCount) || 1);
  }
  getValues() {
    const workbook = loadWorkbook(this.workbookId);
    const rows = workbook.sheets[this.sheetName] || [];
    const result = [];
    for (let r = 0; r < this.rowCount; r += 1) {
      const values = [];
      for (let c = 0; c < this.columnCount; c += 1) {
        values.push((rows[this.row - 1 + r] || [])[this.column - 1 + c] ?? "");
      }
      result.push(values);
    }
    return result;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    const workbook = loadWorkbook(this.workbookId);
    const rows = workbook.sheets[this.sheetName] || (workbook.sheets[this.sheetName] = []);
    for (let r = 0; r < this.rowCount; r += 1) {
      for (let c = 0; c < this.columnCount; c += 1) {
        const rr = this.row - 1 + r;
        const cc = this.column - 1 + c;
        ensureCell(rows, rr, cc);
        rows[rr][cc] = values && values[r] ? (values[r][c] ?? "") : "";
      }
    }
    saveWorkbook(this.workbookId, workbook);
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  setFontWeight() { return this; }
}

class LocalSheet {
  constructor(workbookId, name) {
    this.workbookId = workbookId;
    this.name = name;
  }
  getRange(row, column, rowCount, columnCount) {
    return new LocalRange(this.workbookId, this.name, row, column, rowCount, columnCount);
  }
  getLastRow() {
    const rows = (loadWorkbook(this.workbookId).sheets[this.name] || []);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if ((rows[i] || []).some((value) => value !== "" && value !== null && value !== undefined)) return i + 1;
    }
    return 0;
  }
  getDataRange() {
    const rows = (loadWorkbook(this.workbookId).sheets[this.name] || []);
    const columns = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
    return new LocalRange(this.workbookId, this.name, 1, 1, Math.max(1, rows.length), Math.max(1, columns));
  }
  appendRowWithIndex(values) {
    const row = this.getLastRow() + 1;
    new LocalRange(this.workbookId, this.name, row, 1, 1, Math.max(1, (values || []).length)).setValues([values || []]);
    return row;
  }
}

class LocalSpreadsheet {
  constructor(id) {
    this.id = id;
    ensureWorkbook(id);
  }
  getSheetByName(name) {
    const workbook = loadWorkbook(this.id);
    return Object.prototype.hasOwnProperty.call(workbook.sheets, name) ? new LocalSheet(this.id, name) : null;
  }
  insertSheet(name) {
    const workbook = loadWorkbook(this.id);
    workbook.sheets[name] = workbook.sheets[name] || [];
    if (!workbook.activeSheet) workbook.activeSheet = name;
    saveWorkbook(this.id, workbook);
    return new LocalSheet(this.id, name);
  }
  getActiveSheet() {
    const workbook = loadWorkbook(this.id);
    let name = workbook.activeSheet || Object.keys(workbook.sheets)[0];
    if (!name) {
      name = "Sheet1";
      workbook.sheets[name] = [];
      workbook.activeSheet = name;
      saveWorkbook(this.id, workbook);
    }
    return new LocalSheet(this.id, name);
  }
}

function hasMySqlConfiguration() {
  return Boolean(
    process.env.MYSQL_HOST &&
    process.env.MYSQL_DATABASE &&
    process.env.MYSQL_USER &&
    process.env.MYSQL_PASSWORD
  );
}

let mysqlSchemaReady = false;

function mysqlIdentifierValue(value) {
  return `'${Buffer.from(String(value ?? ""), "utf8").toString("base64")}'`;
}

function mysqlTextExpression(value) {
  return `CONVERT(FROM_BASE64(${mysqlIdentifierValue(value)}) USING utf8mb4)`;
}

function runMySql(sql) {
  const executable = process.env.MYSQL_CLIENT_BIN || "mariadb";
  const args = [
    "--protocol=tcp",
    "--host", process.env.MYSQL_HOST,
    "--port", String(process.env.MYSQL_PORT || 3306),
    "--user", process.env.MYSQL_USER,
    "--database", process.env.MYSQL_DATABASE,
    "--default-character-set=utf8mb4",
    "--connect-timeout", String(process.env.MYSQL_CONNECT_TIMEOUT_SECONDS || 10),
    "--batch",
    "--raw",
    "--skip-column-names",
    "--execute", sql,
  ];
  if (String(process.env.MYSQL_SSL || "").toLowerCase() === "false") args.splice(1, 0, "--skip-ssl");

  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: Number(process.env.MYSQL_MAX_BUFFER_BYTES || 32 * 1024 * 1024),
    windowsHide: true,
    env: { ...process.env, MYSQL_PWD: process.env.MYSQL_PASSWORD },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "MySQL command failed").trim());
  }
  return String(result.stdout || "").trimEnd();
}

function ensureMySqlSchema() {
  if (mysqlSchemaReady) return;
  runMySql(`
    CREATE TABLE IF NOT EXISTS app_spreadsheet_sheets (
      workbook_id VARCHAR(128) NOT NULL,
      sheet_name VARCHAR(128) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workbook_id, sheet_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS app_spreadsheet_cells (
      workbook_id VARCHAR(128) NOT NULL,
      sheet_name VARCHAR(128) NOT NULL,
      row_num INT UNSIGNED NOT NULL,
      col_num INT UNSIGNED NOT NULL,
      value_text LONGTEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (workbook_id, sheet_name, row_num, col_num),
      CONSTRAINT fk_app_sheet
        FOREIGN KEY (workbook_id, sheet_name)
        REFERENCES app_spreadsheet_sheets (workbook_id, sheet_name)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS app_employees (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(320) NOT NULL DEFAULT '',
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_app_employees_active_name (active, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  mysqlSchemaReady = true;
}

function seedMySqlEmployeesFromEnvironment() {
  if (!process.env.EMPLOYEES_JSON) return;
  const existing = Number(runMySql("SELECT COUNT(*) FROM app_employees")) || 0;
  if (existing > 0) return;
  let employees;
  try {
    employees = JSON.parse(process.env.EMPLOYEES_JSON);
  } catch {
    throw new Error("EMPLOYEES_JSON is not valid JSON.");
  }
  if (!Array.isArray(employees) || !employees.length) return;
  const rows = employees
    .filter((employee) => employee && String(employee.name || "").trim())
    .map((employee) =>
      `(${mysqlTextExpression(String(employee.name).trim())},${mysqlTextExpression(String(employee.email || "").trim())},1)`
    );
  if (!rows.length) return;
  runMySql(`
    INSERT INTO app_employees (name, email, active)
    VALUES ${rows.join(",")}
  `);
}

function listMySqlEmployees() {
  ensureMySqlSchema();
  seedMySqlEmployeesFromEnvironment();
  const output = runMySql(`
    SELECT
      REPLACE(TO_BASE64(CONVERT(name USING utf8mb4)), CHAR(10), ''),
      REPLACE(TO_BASE64(CONVERT(email USING utf8mb4)), CHAR(10), '')
    FROM app_employees
    WHERE active=1
    ORDER BY name
  `);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return {
      name: Buffer.from(parts[0] || "", "base64").toString("utf8"),
      email: Buffer.from(parts[1] || "", "base64").toString("utf8"),
    };
  });
}

function mysqlSheetWhere(workbookId, sheetName) {
  return `workbook_id=${mysqlTextExpression(workbookId)} AND sheet_name=${mysqlTextExpression(sheetName)}`;
}

class MySqlRange {
  constructor(workbookId, sheetName, row, column, rowCount, columnCount) {
    this.workbookId = String(workbookId);
    this.sheetName = String(sheetName);
    this.row = Math.max(1, Number(row) || 1);
    this.column = Math.max(1, Number(column) || 1);
    this.rowCount = Math.max(1, Number(rowCount) || 1);
    this.columnCount = Math.max(1, Number(columnCount) || 1);
  }
  getValues() {
    ensureMySqlSchema();
    const result = Array.from({ length: this.rowCount }, () => Array(this.columnCount).fill(""));
    const rowEnd = this.row + this.rowCount - 1;
    const columnEnd = this.column + this.columnCount - 1;
    const output = runMySql(`
      SELECT row_num, col_num, REPLACE(TO_BASE64(CONVERT(value_text USING utf8mb4)), CHAR(10), '')
      FROM app_spreadsheet_cells
      WHERE ${mysqlSheetWhere(this.workbookId, this.sheetName)}
        AND row_num BETWEEN ${this.row} AND ${rowEnd}
        AND col_num BETWEEN ${this.column} AND ${columnEnd}
      ORDER BY row_num, col_num
    `);
    if (!output) return result;
    for (const line of output.split(/\r?\n/)) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const rowIndex = Number(parts[0]) - this.row;
      const columnIndex = Number(parts[1]) - this.column;
      if (rowIndex < 0 || columnIndex < 0 || rowIndex >= this.rowCount || columnIndex >= this.columnCount) continue;
      result[rowIndex][columnIndex] = Buffer.from(parts.slice(2).join("\t"), "base64").toString("utf8");
    }
    return result;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    ensureMySqlSchema();
    const workbook = mysqlTextExpression(this.workbookId);
    const sheet = mysqlTextExpression(this.sheetName);
    runMySql(`
      INSERT INTO app_spreadsheet_sheets (workbook_id, sheet_name, is_active)
      VALUES (${workbook}, ${sheet}, 0)
      ON DUPLICATE KEY UPDATE sheet_name=VALUES(sheet_name)
    `);
    const tuples = [];
    for (let r = 0; r < this.rowCount; r += 1) {
      for (let c = 0; c < this.columnCount; c += 1) {
        const value = values && values[r] ? (values[r][c] ?? "") : "";
        tuples.push(`(${workbook},${sheet},${this.row + r},${this.column + c},${mysqlTextExpression(value)})`);
      }
    }
    if (tuples.length) {
      runMySql(`
        INSERT INTO app_spreadsheet_cells
          (workbook_id, sheet_name, row_num, col_num, value_text)
        VALUES ${tuples.join(",")}
        ON DUPLICATE KEY UPDATE value_text=VALUES(value_text)
      `);
    }
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  setFontWeight() { return this; }
}

class MySqlSheet {
  constructor(workbookId, name) {
    this.workbookId = String(workbookId);
    this.name = String(name);
  }
  getRange(row, column, rowCount, columnCount) {
    return new MySqlRange(this.workbookId, this.name, row, column, rowCount, columnCount);
  }
  getLastRow() {
    ensureMySqlSchema();
    const output = runMySql(`
      SELECT COALESCE(MAX(row_num),0)
      FROM app_spreadsheet_cells
      WHERE ${mysqlSheetWhere(this.workbookId, this.name)}
        AND COALESCE(value_text,'') <> ''
    `);
    return Number(output || 0);
  }
  getDataRange() {
    ensureMySqlSchema();
    const output = runMySql(`
      SELECT COALESCE(MAX(row_num),1), COALESCE(MAX(col_num),1)
      FROM app_spreadsheet_cells
      WHERE ${mysqlSheetWhere(this.workbookId, this.name)}
    `);
    const parts = String(output || "1\t1").split("\t");
    return new MySqlRange(this.workbookId, this.name, 1, 1, Number(parts[0]) || 1, Number(parts[1]) || 1);
  }
  appendRowWithIndex(values) {
    ensureMySqlSchema();
    const workbook = mysqlTextExpression(this.workbookId);
    const sheet = mysqlTextExpression(this.name);
    const lockName = `coursebook_${crypto.createHash("sha256").update(`${this.workbookId}\n${this.name}`).digest("hex").slice(0, 32)}`;
    const entries = (values || []).map((value, index) =>
      `(${workbook},${sheet},@next_row,${index + 1},${mysqlTextExpression(value)})`
    );
    const output = runMySql(`
      INSERT INTO app_spreadsheet_sheets (workbook_id, sheet_name, is_active)
      VALUES (${workbook}, ${sheet}, 0)
      ON DUPLICATE KEY UPDATE sheet_name=VALUES(sheet_name);
      SET @lock_ok=GET_LOCK(${mysqlTextExpression(lockName)}, 15);
      SET @next_row=(
        SELECT COALESCE(MAX(row_num),0)+1
        FROM app_spreadsheet_cells
        WHERE ${mysqlSheetWhere(this.workbookId, this.name)}
      );
      INSERT INTO app_spreadsheet_cells
        (workbook_id, sheet_name, row_num, col_num, value_text)
      VALUES ${entries.length ? entries.join(",") : `(${workbook},${sheet},@next_row,1,'')`}
      ON DUPLICATE KEY UPDATE value_text=VALUES(value_text);
      SELECT @next_row;
      SET @released=RELEASE_LOCK(${mysqlTextExpression(lockName)})
    `);
    const lines = String(output || "").split(/\r?\n/).filter(Boolean);
    return Number(lines[lines.length - 1]) || this.getLastRow();
  }
}

class MySqlSpreadsheet {
  constructor(id) {
    this.id = String(id);
    ensureMySqlSchema();
  }
  getSheetByName(name) {
    const output = runMySql(`
      SELECT 1 FROM app_spreadsheet_sheets
      WHERE ${mysqlSheetWhere(this.id, name)}
      LIMIT 1
    `);
    return output ? new MySqlSheet(this.id, name) : null;
  }
  insertSheet(name) {
    const workbook = mysqlTextExpression(this.id);
    const sheet = mysqlTextExpression(name);
    runMySql(`
      INSERT INTO app_spreadsheet_sheets (workbook_id, sheet_name, is_active)
      VALUES (${workbook}, ${sheet}, 1)
      ON DUPLICATE KEY UPDATE is_active=VALUES(is_active);
      UPDATE app_spreadsheet_sheets
      SET is_active=CASE WHEN sheet_name=${sheet} THEN 1 ELSE 0 END
      WHERE workbook_id=${workbook}
    `);
    return new MySqlSheet(this.id, name);
  }
  getActiveSheet() {
    let output = runMySql(`
      SELECT REPLACE(TO_BASE64(CONVERT(sheet_name USING utf8mb4)), CHAR(10), '')
      FROM app_spreadsheet_sheets
      WHERE workbook_id=${mysqlTextExpression(this.id)}
      ORDER BY is_active DESC, created_at ASC
      LIMIT 1
    `);
    if (!output) return this.insertSheet("Sheet1");
    return new MySqlSheet(this.id, Buffer.from(output, "base64").toString("utf8"));
  }
}

function createSpreadsheetApp() {
  return {
    openById(id) {
      const workbookId = String(id || "local-user-logs");
      const employeeId = process.env.EMPLOYEE_SPREADSHEET_ID || "local-employees";
      if (workbookId === "local-employees" || workbookId === employeeId) {
        return new LocalSpreadsheet(workbookId);
      }
      if (String(process.env.MYSQL_REQUIRED || "").toLowerCase() === "true" && !hasMySqlConfiguration()) {
        throw new Error("MySQL is required, but MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER, or MYSQL_PASSWORD is missing.");
      }
      if (hasMySqlConfiguration()) return new MySqlSpreadsheet(workbookId);
      return new LocalSpreadsheet(workbookId);
    },
    flush() {}
  };
}

class HttpResponse {
  constructor(status, body, contentType) {
    this.status = status;
    this.body = Buffer.from(body || []);
    this.contentType = contentType || "application/octet-stream";
  }
  getResponseCode() { return this.status; }
  getContentText() { return this.body.toString("utf8"); }
  getBlob() { return new LocalBlob(this.body, this.contentType); }
}

function createUrlFetchApp() {
  return {
    fetch(url, options) {
      const opts = options || {};
      const method = String(opts.method || (opts.payload !== undefined ? "post" : "get")).toUpperCase();
      const requestId = `${process.pid}-${crypto.randomUUID()}`;
      const headerPath = path.join(HTTP_TMP_DIR, `${requestId}.headers`);
      const uploadPaths = [];
      const args = [
        "--silent", "--show-error", "--location",
        "--max-time", String(Number(process.env.HTTP_TIMEOUT_SECONDS || 300)),
        "--request", method,
        "--dump-header", headerPath,
      ];

      const headers = { ...(opts.headers || {}) };
      if (opts.contentType && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["Content-Type"] = opts.contentType;
      }
      for (const [key, value] of Object.entries(headers)) args.push("--header", `${key}: ${value}`);

      if (opts.payload !== undefined && opts.payload !== null) {
        if (typeof opts.payload === "string" || Buffer.isBuffer(opts.payload)) {
          args.push("--data-binary", Buffer.isBuffer(opts.payload) ? opts.payload.toString("utf8") : opts.payload);
        } else if (typeof opts.payload === "object") {
          // Curl supplies the multipart boundary; remove an explicitly supplied non-multipart content type.
          for (let i = args.length - 2; i >= 0; i -= 1) {
            if (args[i] === "--header" && /^Content-Type:/i.test(args[i + 1])) args.splice(i, 2);
          }
          for (const [key, value] of Object.entries(opts.payload)) {
            if (value instanceof LocalBlob) {
              const uploadPath = path.join(HTTP_TMP_DIR, `${requestId}-${safeSegment(value.getName() || key)}`);
              fs.writeFileSync(uploadPath, value.getBytes());
              uploadPaths.push(uploadPath);
              args.push("--form", `${key}=@${uploadPath};type=${value.getContentType()};filename=${value.getName() || "upload.bin"}`);
            } else {
              args.push("--form-string", `${key}=${String(value)}`);
            }
          }
        }
      }

      args.push("--write-out", "\n__COURSEBOOK_HTTP_STATUS__:%{http_code}", String(url));
      const result = spawnSync(process.env.CURL_BIN || "curl", args, {
        encoding: null,
        maxBuffer: Number(process.env.HTTP_MAX_BUFFER_BYTES || 120 * 1024 * 1024),
        windowsHide: true,
      });

      for (const uploadPath of uploadPaths) {
        try { fs.unlinkSync(uploadPath); } catch {}
      }

      if (result.error) {
        try { fs.unlinkSync(headerPath); } catch {}
        throw result.error;
      }
      if (result.status !== 0) {
        try { fs.unlinkSync(headerPath); } catch {}
        throw new Error((result.stderr || Buffer.from("Network request failed")).toString("utf8").trim());
      }

      const marker = Buffer.from("\n__COURSEBOOK_HTTP_STATUS__:");
      const output = Buffer.from(result.stdout || []);
      const markerAt = output.lastIndexOf(marker);
      if (markerAt < 0) throw new Error("Could not read HTTP status from curl response.");
      const status = Number(output.subarray(markerAt + marker.length).toString("ascii").trim()) || 599;
      const body = output.subarray(0, markerAt);
      let contentType = "application/octet-stream";
      try {
        const rawHeaders = fs.readFileSync(headerPath, "utf8");
        const matches = [...rawHeaders.matchAll(/^content-type:\s*([^;\r\n]+)/gim)];
        if (matches.length) contentType = matches[matches.length - 1][1].trim();
      } catch {}
      try { fs.unlinkSync(headerPath); } catch {}
      return new HttpResponse(status, body, contentType);
    }
  };
}

function createLockService() {
  const lockPath = path.join(LOCKS_DIR, "script.lock");
  return {
    getScriptLock() {
      let locked = false;
      return {
        waitLock(timeoutMs) {
          const deadline = Date.now() + Number(timeoutMs || 30000);
          while (Date.now() <= deadline) {
            try {
              const descriptor = fs.openSync(lockPath, "wx");
              fs.writeFileSync(descriptor, `${process.pid}\n${Date.now()}`);
              fs.closeSync(descriptor);
              locked = true;
              return;
            } catch (error) {
              if (error.code !== "EEXIST") throw error;
              try {
                const age = Date.now() - fs.statSync(lockPath).mtimeMs;
                if (age > 10 * 60 * 1000) fs.unlinkSync(lockPath);
              } catch {}
              sleep(100);
            }
          }
          throw new Error("Could not acquire script lock.");
        },
        releaseLock() {
          if (locked) {
            try { fs.unlinkSync(lockPath); } catch {}
            locked = false;
          }
        }
      };
    }
  };
}

function formatDate(date, pattern) {
  const value = new Date(date);
  const pad = (number) => String(number).padStart(2, "0");
  if (pattern === "yyyy-MM-dd_HH-mm-ss") {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}_${pad(value.getHours())}-${pad(value.getMinutes())}-${pad(value.getSeconds())}`;
  }
  return value.toISOString();
}

function createRuntime() {
  const PropertiesService = createPropertiesService();
  const DatabaseService = {
    isConfigured: hasMySqlConfiguration,
    listEmployees() {
      if (!hasMySqlConfiguration()) {
        return { success: false, message: "MySQL is not configured.", employees: [] };
      }
      const employees = listMySqlEmployees();
      return {
        success: true,
        employees,
        message: employees.length ? "" : "No active employees found in app_employees.",
      };
    },
  };
  const context = vm.createContext({
    console,
    Buffer,
    PropertiesService,
    DatabaseService,
    CacheService: createCacheService(),
    DriveApp: {
      getFolderById(id) { return new LocalFolder(resolveFolderId(id)); },
      Access: { ANYONE_WITH_LINK: "ANYONE_WITH_LINK" },
      Permission: { VIEW: "VIEW" },
    },
    SpreadsheetApp: createSpreadsheetApp(),
    UrlFetchApp: createUrlFetchApp(),
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep,
      base64Encode: (bytes) => Buffer.from(bytes || []).toString("base64"),
      base64Decode: (value) => Buffer.from(String(value || ""), "base64"),
      newBlob: (bytes, contentType, name) => new LocalBlob(bytes, contentType, name),
      formatDate: (date, _timezone, pattern) => formatDate(date, pattern),
    },
    Session: {
      getScriptTimeZone: () => process.env.TZ || "UTC",
    },
    LockService: createLockService(),
    Logger: {
      log: (...args) => console.error(...args),
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      createHtmlOutputFromFile() {
        return {
          setTitle() { return this; },
          setXFrameOptionsMode() { return this; },
        };
      },
    },
  });

  const source = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");
  vm.runInContext(source, context, { filename: "Code.gs", timeout: Number(process.env.CODE_LOAD_TIMEOUT_MS || 30000) });

  const runtime = {};
  for (const method of RPC_METHODS) {
    runtime[method] = context[method];
  }
  return runtime;
}

module.exports = { createRuntime, RPC_METHODS };
