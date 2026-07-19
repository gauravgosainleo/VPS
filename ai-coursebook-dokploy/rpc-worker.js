"use strict";

const fs = require("node:fs");
const { createRuntime, RPC_METHODS } = require("./backend/runtime");

const requestPath = process.argv[2];
const responsePath = process.argv[3];

function write(payload) {
  const temporary = `${responsePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(temporary, responsePath);
}

try {
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (!RPC_METHODS.has(request.method)) {
    throw new Error(`RPC method is not allowed: ${request.method}`);
  }
  const runtime = createRuntime();
  const fn = runtime[request.method];
  if (typeof fn !== "function") throw new Error(`RPC method is unavailable: ${request.method}`);
  const result = fn.apply(null, Array.isArray(request.args) ? request.args : []);
  write({ ok: true, result });
  process.exitCode = 0;
} catch (error) {
  write({
    ok: false,
    error: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : "",
  });
  process.exitCode = 1;
}
