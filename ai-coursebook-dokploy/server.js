"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const TMP_DIR = path.join(DATA_DIR, "tmp");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 100 * 1024 * 1024);
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_CONCURRENT_RPCS = Math.max(1, Number(process.env.MAX_CONCURRENT_RPCS || 4));

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "files"), { recursive: true });

let activeRpcs = 0;
const rpcQueue = [];

function acquireRpcSlot() {
  return new Promise((resolve) => {
    if (activeRpcs < MAX_CONCURRENT_RPCS) {
      activeRpcs += 1;
      resolve();
      return;
    }
    rpcQueue.push(resolve);
  });
}

function releaseRpcSlot() {
  const next = rpcQueue.shift();
  if (next) {
    next();
  } else {
    activeRpcs = Math.max(0, activeRpcs - 1);
  }
}

function setCommonHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isAuthorized(req) {
  const username = process.env.APP_USERNAME || "";
  const password = process.env.APP_PASSWORD || "";
  if (!username || !password) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let supplied;
  try {
    supplied = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const expected = `${username}:${password}`;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
  }[ext] || "application/octet-stream";
}

function serveStatic(res, filePath, downloadName) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { success: false, message: "Not found" });
    return;
  }
  const stat = fs.statSync(filePath);
  const headers = {
    "Content-Type": contentType(filePath),
    "Content-Length": stat.size,
    "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
  };
  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename="${downloadName.replace(/["\r\n]/g, "_")}"`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

async function runRpc(method, args) {
  await acquireRpcSlot();
  const id = crypto.randomUUID();
  const requestPath = path.join(TMP_DIR, `${id}.request.json`);
  const responsePath = path.join(TMP_DIR, `${id}.response.json`);
  fs.writeFileSync(requestPath, JSON.stringify({ method, args }), { mode: 0o600 });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(path.join(ROOT, "rpc-worker.js"), [requestPath, responsePath], {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch (error) {
      for (const file of [requestPath, responsePath]) {
        try { fs.unlinkSync(file); } catch {}
      }
      releaseRpcSlot();
      reject(error);
      return;
    }
    let stderr = "";
    let settled = false;

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16000) stderr += chunk.toString("utf8");
    });

    const cleanup = () => {
      clearTimeout(timer);
      for (const file of [requestPath, responsePath]) {
        try { fs.unlinkSync(file); } catch {}
      }
      releaseRpcSlot();
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Object.assign(new Error("The server operation timed out. You can pause and resume the job safely."), { statusCode: 504 }));
    }, RPC_TIMEOUT_MS);

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (settled) return;
      try {
        const payload = JSON.parse(fs.readFileSync(responsePath, "utf8"));
        if (payload.ok) finish(null, payload.result);
        else finish(Object.assign(new Error(payload.error || "Server operation failed."), { details: payload.stack }));
      } catch (error) {
        finish(new Error(stderr.trim() || `RPC worker exited with code ${code}. ${error.message}`));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  setCommonHeaders(res);

  if (!isAuthorized(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="AI Coursebook Generator", charset="UTF-8"');
    sendJson(res, 401, { success: false, message: "Authentication required" });
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    sendJson(res, 400, { success: false, message: "Invalid URL" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "ai-coursebook-generator" });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/files/")) {
    let filename;
    try { filename = path.basename(decodeURIComponent(url.pathname.slice(7))); }
    catch { filename = ""; }
    if (!filename || !/\.pdf$/i.test(filename)) {
      sendJson(res, 404, { success: false, message: "File not found" });
      return;
    }
    serveStatic(res, path.join(DATA_DIR, "files", filename), filename);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/rpc/")) {
    const method = url.pathname.slice("/api/rpc/".length);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(method)) {
      sendJson(res, 400, { success: false, message: "Invalid method" });
      return;
    }
    try {
      const raw = await readRequestBody(req);
      const parsed = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const args = Array.isArray(parsed.args) ? parsed.args : [];
      const result = await runRpc(method, args);
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
      sendJson(res, status, { success: false, message: error.message || String(error) });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { success: false, message: "Method not allowed" });
    return;
  }

  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  try { pathname = decodeURIComponent(pathname); }
  catch {
    sendJson(res, 400, { success: false, message: "Invalid path" });
    return;
  }
  const target = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(res, 403, { success: false, message: "Forbidden" });
    return;
  }
  serveStatic(res, target);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Coursebook Generator listening on port ${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
