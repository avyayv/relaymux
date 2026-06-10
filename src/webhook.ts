import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { expandPath, ensureDirectory } from "./paths.js";

export function webhookConfig(config) {
  const daemon = config.daemon || {};
  return {
    host: daemon.host || "127.0.0.1",
    port: Number(daemon.port || 47761),
    tokenFile: expandPath(daemon.tokenFile || "~/.local/state/agentmux/webhook-token"),
    maxBodyBytes: Number(daemon.maxBodyBytes || 65536),
  };
}

export function webhookStatus(config) {
  const resolved = webhookConfig(config);
  let tokenFileExists = false;
  let tokenFileMode = null;
  try {
    const stat = fs.statSync(resolved.tokenFile);
    tokenFileExists = stat.isFile();
    tokenFileMode = `0${(stat.mode & 0o777).toString(8)}`;
  } catch {}
  const hostForUrl = formatHostForUrl(resolved.host);
  return {
    ...resolved,
    tokenFileExists,
    tokenFileMode,
    endpoints: {
      health: `http://${hostForUrl}:${resolved.port}/health`,
      message: `http://${hostForUrl}:${resolved.port}/message`,
      agentMessage: `http://${hostForUrl}:${resolved.port}/agent-message`,
    },
  };
}

export function ensureWebhookToken(tokenFile) {
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

export function normalizeCompletionBody(body, requestId, receivedAt = new Date().toISOString()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "JSON object body is required");

  const rawText = body.text ?? body.message;
  if (typeof rawText !== "string" || !rawText.trim()) throw httpError(400, "text or message string is required");

  const metadata = body.metadata === undefined ? {} : body.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw httpError(400, "metadata must be an object when provided");

  const replyMode = body.replyMode === undefined ? "imessage" : String(body.replyMode);
  if (!["imessage", "none"].includes(replyMode)) throw httpError(400, "replyMode must be imessage or none");

  const rawSource = body.from ?? body.source ?? "local-subagent";
  const source = String(rawSource || "local-subagent").slice(0, 200);
  const idempotencyKey = body.idempotencyKey === undefined || body.idempotencyKey === null || body.idempotencyKey === ""
    ? null
    : String(body.idempotencyKey);
  if (idempotencyKey && idempotencyKey.length > 512) throw httpError(400, "idempotencyKey is too long");

  return {
    type: "webhook",
    requestId,
    source,
    text: rawText,
    metadata,
    idempotencyKey,
    replyMode,
    receivedAt,
  };
}

export function rememberWebhookIdempotencyKey(state, key, { max = 1000 } = {}) {
  if (!key) return { duplicate: false };
  const seen = new Set((state.seenWebhookIdempotencyKeys || []).map(String));
  if (seen.has(String(key))) return { duplicate: true };
  seen.add(String(key));
  state.seenWebhookIdempotencyKeys = Array.from(seen).slice(-max);
  state.lastWebhookAt = new Date().toISOString();
  return { duplicate: false };
}

export async function createCompletionWebhookServer({ config, state, saveState, enqueue, getStatus, io = console }: any) {
  const resolved = webhookConfig(config);
  if (!isLocalWebhookHost(resolved.host)) {
    io.warn?.(`agentmux daemon: refusing to bind non-loopback webhook host ${resolved.host}`);
    return null;
  }
  if (!isValidWebhookPort(resolved.port)) {
    io.warn?.(`agentmux daemon: invalid webhook port ${resolved.port}`);
    return null;
  }

  let token;
  try {
    token = ensureWebhookToken(resolved.tokenFile);
  } catch (error) {
    io.warn?.(`agentmux daemon: failed to initialize webhook token: ${error.message}`);
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://agentmux.local");
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, {
          ok: true,
          time: new Date().toISOString(),
          webhook: webhookStatus(config),
          status: getStatus(),
        });
        return;
      }

      if ((url.pathname === "/message" || url.pathname === "/agent-message") && req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }

      if (req.method === "POST" && (url.pathname === "/message" || url.pathname === "/agent-message")) {
        const suppliedToken = parseBearerToken(req.headers.authorization);
        if (!tokenMatches(token, suppliedToken)) {
          writeJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }

        const body = await readJsonRequestBody(req, resolved.maxBodyBytes);
        const requestId = makeRequestId("wh");
        const job = normalizeCompletionBody(body, requestId);
        if (job.idempotencyKey) {
          const result = rememberWebhookIdempotencyKey(state, job.idempotencyKey);
          if (result.duplicate) {
            writeJson(res, 202, { ok: true, duplicate: true, queued: false, requestId, idempotencyKey: job.idempotencyKey });
            return;
          }
          saveState();
        }

        enqueue(job);
        writeJson(res, 202, { ok: true, queued: true, requestId, replyMode: job.replyMode });
        return;
      }

      writeJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const statusCode = error?.statusCode || 500;
      if (statusCode >= 500) io.warn?.(`agentmux daemon webhook failed: ${error.stack || error.message}`);
      if (!res.headersSent) writeJson(res, statusCode, { ok: false, error: error.message || String(error) });
      else res.end();
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return new Promise((resolve) => {
    const onError = (error) => {
      io.warn?.(`agentmux daemon: local webhook unavailable: ${error.message}`);
      resolve(null);
    };
    const onListening = () => {
      server.off("error", onError);
      server.on("error", (error) => io.warn?.(`agentmux daemon webhook error: ${error.message}`));
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(resolved.port, resolved.host);
  });
}

export function makeRequestId(prefix = "req") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

export function formatHostForUrl(host) {
  const value = String(host || "").trim();
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

export function isLocalWebhookHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

function isValidWebhookPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonRequestBody(req, maxBodyBytes) {
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
  if (!raw) throw httpError(400, "JSON body is required");
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "invalid JSON body");
  }
}

function parseBearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ""));
  return match ? match[1].trim() : null;
}

function tokenMatches(expected, supplied) {
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function httpError(statusCode, message) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  return error;
}
