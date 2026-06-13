import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { ensureDirectory } from "./paths.js";

const DEFAULT_HTTP_JSON_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function ensureTokenFile(tokenFile) {
  ensureDirectory(path.dirname(tokenFile));
  try {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (existing) {
      try { fs.chmodSync(tokenFile, 0o600); } catch {}
      return existing;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(tokenFile, 0o600); } catch {}
  return token;
}

export function readTokenFile(tokenFile) {
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error(`Token file is empty: ${tokenFile}`);
  return token;
}

export async function httpJson({ endpoint, path: requestPath, method = "POST", token, body, timeoutMs = 0, maxResponseBytes = DEFAULT_HTTP_JSON_MAX_RESPONSE_BYTES }) {
  const base = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new Error(`Unsupported endpoint protocol ${base.protocol}; use http or https`);
  }

  const url = new URL(String(requestPath || "/").replace(/^\/+/, ""), base);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  }

  const transport = url.protocol === "https:" ? https : http;
  return new Promise<any>((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (tooLarge) {
          reject(new Error(`remote JSON response exceeds ${maxResponseBytes} bytes`));
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          reject(new Error(`remote returned non-JSON response (${res.statusCode}): ${raw.slice(0, 500)}`));
          return;
        }
        if ((res.statusCode || 500) >= 400) {
          const error: any = new Error(parsed.error || `remote request failed with HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.body = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", (error) => reject(new Error(`Could not reach ${endpoint}: ${error.message}`)));
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms waiting for ${endpoint}`)));
    }
    if (payload) req.end(payload);
    else req.end();
  });
}

export async function readJsonRequestBody(req, maxBodyBytes = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw httpError(413, `JSON body exceeds ${maxBodyBytes} bytes`);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "invalid JSON body");
  }
}

export function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

export function parseBearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ""));
  return match ? match[1].trim() : null;
}

export function tokenMatches(expected, supplied) {
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(String(expected));
  const suppliedBuffer = Buffer.from(String(supplied));
  if (expectedBuffer.length !== suppliedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function httpError(statusCode, message) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function makeProtocolId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

export function fileMode(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `0${(stat.mode & 0o777).toString(8)}` : null;
  } catch {
    return null;
  }
}
