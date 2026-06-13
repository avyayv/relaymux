import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { runCommandAsync } from "./async-process.js";
import { CLOUD_BASE_PROTOCOL } from "./cloud-base.js";
import { quoteArgv } from "./command.js";
import { resolveStateDir } from "./config.js";
import { expandPath, ensureDirectory } from "./paths.js";
import {
  ensureTokenFile,
  fileMode,
  httpError,
  httpJson,
  makeProtocolId,
  parseBearerToken,
  readJsonRequestBody,
  readTokenFile,
  tokenMatches,
  writeJson,
} from "./remote.js";

export const HANDS_PROTOCOL = "relaymux.hands.v1";
const DEFAULT_HANDS_PORT = 47773;

export async function handleHandsCommand({ flags, positionals, configInfo, stateDir, io }) {
  const subcommand = String(positionals[0] || "help");
  const rest = positionals.slice(1);

  switch (subcommand) {
    case "help":
    case "--help":
      io.stdout.write(handsHelpText());
      return 0;
    case "status":
      return handleHandsStatus({ flags, config: configInfo.config, stateDir, io });
    case "run":
    case "worker":
      return await runHandsWorkerCommand({ flags, config: configInfo.config, stateDir, io });
    case "serve-dev":
    case "dev-server":
      return await runHandsDevServerCommand({ flags, config: configInfo.config, stateDir, io });
    case "enqueue":
      return await enqueueHandsTaskCommand({ flags, rest, config: configInfo.config, stateDir, io });
    default:
      throw new Error(`Unknown hands subcommand "${subcommand}"`);
  }
}

export function resolveHandsConnectionConfig(config, { flags = {}, stateDir, env = process.env }: any = {}) {
  const cloudHands = config.cloudHands || {};
  const resolvedStateDir = stateDir || resolveStateDir(config, env);
  return {
    enabled: Boolean(cloudHands.enabled),
    endpoint: String(flags.endpoint || cloudHands.endpoint || "").replace(/\/+$/, ""),
    tokenFile: expandPath(flags.tokenFile || cloudHands.tokenFile || path.join(resolvedStateDir, "hands-token")),
    requestTimeoutMs: Number(flags.timeoutMs || cloudHands.requestTimeoutMs || 30000),
  };
}

export function resolveHandsRuntimeConfig(config, { flags = {}, stateDir, env = process.env }: any = {}) {
  const cloudHands = config.cloudHands || {};
  const connection = resolveHandsConnectionConfig(config, { flags, stateDir, env });
  const flagWorkspace = flags.workspace ? [parseWorkspaceFlag(flags.workspace, flags)] : null;
  const workspaces = normalizeHandsWorkspaces(flagWorkspace || cloudHands.workspaces || []);

  return {
    ...connection,
    workerId: String(flags.workerId || cloudHands.workerId || defaultWorkerId()),
    pollMs: positiveNumber(flags.pollMs || cloudHands.pollMs, 2000),
    leaseMs: positiveNumber(flags.leaseMs || cloudHands.leaseMs, 60000),
    maxCommandOutputBytes: positiveNumber(flags.maxCommandOutputBytes || cloudHands.maxCommandOutputBytes, 200000),
    workspaces,
  };
}

export function resolveHandsDevServerConfig(config, { flags = {}, stateDir, env = process.env }: any = {}) {
  const cloudHands = config.cloudHands || {};
  const dev = cloudHands.devServer || {};
  const resolvedStateDir = stateDir || resolveStateDir(config, env);
  const host = String(flags.host || dev.host || "127.0.0.1");
  const port = Number(flags.port || dev.port || DEFAULT_HANDS_PORT);
  return {
    host,
    port,
    stateFile: expandPath(flags.stateFile || dev.stateFile || path.join(resolvedStateDir, "hands-dev-server.json")),
    tokenFile: expandPath(flags.tokenFile || cloudHands.tokenFile || path.join(resolvedStateDir, "hands-token")),
    maxBodyBytes: positiveNumber(flags.maxBodyBytes || dev.maxBodyBytes, 1024 * 1024),
  };
}

function handleHandsStatus({ flags, config, stateDir, io }) {
  const runtime = resolveHandsRuntimeConfig(config, { flags, stateDir, env: io.env });
  const dev = resolveHandsDevServerConfig(config, { flags, stateDir, env: io.env });
  const status = {
    protocol: HANDS_PROTOCOL,
    enabled: runtime.enabled,
    endpoint: runtime.endpoint,
    tokenFile: runtime.tokenFile,
    tokenFileMode: fileMode(runtime.tokenFile),
    workerId: runtime.workerId,
    pollMs: runtime.pollMs,
    leaseMs: runtime.leaseMs,
    workspaces: runtime.workspaces.map(formatWorkspaceStatus),
    devServer: {
      endpoint: `http://${formatHostForUrl(dev.host)}:${dev.port}`,
      stateFile: dev.stateFile,
      tokenFile: dev.tokenFile,
      tokenFileMode: fileMode(dev.tokenFile),
    },
  };

  if (flags.json) {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  io.stdout.write(`Hands protocol: ${status.protocol}\n`);
  io.stdout.write(`Cloud endpoint: ${status.endpoint || "not configured"}; worker ${status.workerId}; token ${status.tokenFileMode || "missing"} at ${status.tokenFile}\n`);
  io.stdout.write(`Poll ${status.pollMs}ms; lease ${status.leaseMs}ms; configured workspaces: ${status.workspaces.length}\n`);
  for (const workspace of status.workspaces) {
    io.stdout.write(`- ${workspace.name}: ${workspace.path} (${workspace.permissions.join(",") || "no permissions"})\n`);
  }
  io.stdout.write(`Dev server default: ${status.devServer.endpoint}; state ${status.devServer.stateFile}; token ${status.devServer.tokenFileMode || "missing"}\n`);
  return 0;
}

async function runHandsWorkerCommand({ flags, config, stateDir, io }) {
  const runtime = resolveHandsRuntimeConfig(config, { flags, stateDir, env: io.env });
  validateHandsRuntime(runtime);

  if (flags.dryRun) {
    io.stdout.write(JSON.stringify({
      protocol: HANDS_PROTOCOL,
      endpoint: runtime.endpoint,
      workerId: runtime.workerId,
      tokenFile: runtime.tokenFile,
      pollMs: runtime.pollMs,
      leaseMs: runtime.leaseMs,
      workspaces: runtime.workspaces.map(formatWorkspaceStatus),
    }, null, 2) + "\n");
    return 0;
  }

  const token = readTokenFile(runtime.tokenFile);
  const log = (...args) => io.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
  const warn = (...args) => io.stderr.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
  let stopping = false;
  const stop = (signal) => {
    stopping = true;
    log(`stopping hands worker (${signal})`);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  log(`starting hands worker ${runtime.workerId}; endpoint ${runtime.endpoint}; workspaces ${runtime.workspaces.map((w) => w.name).join(",")}`);
  while (!stopping) {
    try {
      const task = await pollHandsTask(runtime, token);
      if (!task) {
        if (flags.once) break;
        await sleep(runtime.pollMs);
        continue;
      }

      log(`claimed task ${task.id} (${task.kind}) workspace=${task.workspace}`);
      const result = await executeHandsTask(task, runtime);
      await postHandsResult(runtime, token, task, result);
      log(`reported task ${task.id}: ${result.ok ? "ok" : "failed"}`);
      if (flags.once) break;
    } catch (error) {
      warn(`hands worker error: ${error.message || String(error)}`);
      if (flags.once) return 1;
      await sleep(runtime.pollMs);
    }
  }
  return 0;
}

async function runHandsDevServerCommand({ flags, config, stateDir, io }) {
  const dev = resolveHandsDevServerConfig(config, { flags, stateDir, env: io.env });
  if (!isLocalDevServerHost(dev.host) && !flags.allowRemoteDevServer) {
    throw new Error(`hands serve-dev refuses to bind non-loopback host ${dev.host}; pass --allow-remote-dev-server only for intentional private-network testing`);
  }
  if (flags.dryRun) {
    io.stdout.write(JSON.stringify({
      protocol: HANDS_PROTOCOL,
      endpoint: `http://${formatHostForUrl(dev.host)}:${dev.port}`,
      stateFile: dev.stateFile,
      tokenFile: dev.tokenFile,
      endpoints: handsDevServerEndpoints(dev.host, dev.port),
    }, null, 2) + "\n");
    return 0;
  }

  const server = await createHandsDevServer({ ...dev, io });
  const address: any = server.address();
  const port = typeof address === "object" && address ? address.port : dev.port;
  io.stdout.write(`relaymux hands dev server listening on http://${formatHostForUrl(dev.host)}:${port}\n`);
  io.stdout.write(`state: ${dev.stateFile}\n`);
  io.stdout.write(`token file: ${dev.tokenFile}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = (signal) => {
      io.stdout.write(`stopping hands dev server (${signal})\n`);
      server.close(() => resolve());
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
  return 0;
}

async function enqueueHandsTaskCommand({ flags, rest, config, stateDir, io }) {
  const connection = resolveHandsConnectionConfig(config, { flags, stateDir, env: io.env });
  if (!connection.endpoint) throw new Error("hands enqueue requires --endpoint or cloudHands.endpoint");
  const token = readTokenFile(connection.tokenFile);
  const task = buildTaskFromFlags(flags, rest);
  const response = await httpJson({
    endpoint: connection.endpoint,
    path: "/v1/tasks",
    method: "POST",
    token,
    timeoutMs: connection.requestTimeoutMs,
    body: task,
  });

  if (flags.json) io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  else io.stdout.write(`Queued hands task ${response.task?.id || response.id}\n`);
  return 0;
}

export async function pollHandsTask(runtime, token) {
  const response = await httpJson({
    endpoint: runtime.endpoint,
    path: "/v1/hands/poll",
    method: "POST",
    token,
    timeoutMs: runtime.requestTimeoutMs,
    body: {
      protocol: HANDS_PROTOCOL,
      workerId: runtime.workerId,
      leaseMs: runtime.leaseMs,
      capabilities: workerCapabilities(runtime),
    },
  });
  if (response.ok === false) throw new Error(response.error || "hands poll failed");
  return response.task || null;
}

export async function postHandsResult(runtime, token, task, result) {
  const response = await httpJson({
    endpoint: runtime.endpoint,
    path: "/v1/hands/result",
    method: "POST",
    token,
    timeoutMs: runtime.requestTimeoutMs,
    body: {
      protocol: HANDS_PROTOCOL,
      workerId: runtime.workerId,
      taskId: task.id,
      leaseId: task.leaseId,
      result,
    },
  });
  if (response.ok === false) throw new Error(response.error || "hands result failed");
  return response;
}

export async function executeHandsTask(task, runtime) {
  const startedAt = new Date().toISOString();
  try {
    const normalized = normalizeTaskForExecution(task);
    if (normalized.kind === "readFile") {
      const target = resolveWorkspacePath(runtime.workspaces, normalized.workspace, normalized.args.path, "read");
      const stat = fs.statSync(target.realPath);
      if (!stat.isFile()) throw new Error("readFile target must be a file");
      const text = fs.readFileSync(target.realPath, "utf8");
      return taskResult(true, normalized, startedAt, { path: target.relativePath, bytes: Buffer.byteLength(text), text });
    }

    if (normalized.kind === "writeFile") {
      const target = resolveWorkspacePath(runtime.workspaces, normalized.workspace, normalized.args.path, "write");
      const content = String(normalized.args.content ?? "");
      ensureDirectory(path.dirname(target.absPath));
      if (normalized.args.append) fs.appendFileSync(target.absPath, content);
      else fs.writeFileSync(target.absPath, content);
      return taskResult(true, normalized, startedAt, { path: target.relativePath, bytes: Buffer.byteLength(content) });
    }

    if (normalized.kind === "listDir") {
      const target = resolveWorkspacePath(runtime.workspaces, normalized.workspace, normalized.args.path || ".", "read");
      const stat = fs.statSync(target.realPath);
      if (!stat.isDirectory()) throw new Error("listDir target must be a directory");
      const entries = fs.readdirSync(target.realPath, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return taskResult(true, normalized, startedAt, { path: target.relativePath, entries });
    }

    if (normalized.kind === "shell") {
      const cwd = resolveWorkspacePath(runtime.workspaces, normalized.workspace, normalized.args.cwd || ".", "shell");
      const argv = shellArgv(normalized.args);
      const result = await runCommandAsync(argv[0], argv.slice(1), {
        cwd: cwd.realPath,
        env: process.env,
        allowFailure: true,
        timeoutMs: Number(normalized.args.timeoutMs || 0),
        maxBuffer: runtime.maxCommandOutputBytes,
      });
      return taskResult(result.status === 0, normalized, startedAt, {
        cwd: cwd.relativePath || ".",
        argv,
        command: quoteArgv(argv),
        exitCode: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    throw new Error(`unsupported hands task kind ${normalized.kind}`);
  } catch (error) {
    return {
      ok: false,
      taskId: task.id,
      kind: task.kind,
      workspace: task.workspace,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error.message || String(error),
    };
  }
}

export function resolveWorkspacePath(workspaces, workspaceName, requestedPath = ".", operation = "read") {
  const workspace = findWorkspace(workspaces, workspaceName);
  if (!workspace) throw new Error(`Workspace "${workspaceName}" is not allowed by this hands worker`);
  assertWorkspacePermission(workspace, operation);

  const rootPath = expandPath(workspace.path);
  const rootReal = fs.realpathSync(rootPath);
  const raw = String(requestedPath || ".");
  const absPath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootReal, raw);
  if (!isPathInside(rootReal, absPath)) {
    throw new Error(`Path escapes workspace "${workspace.name}"`);
  }
  let realPath = absPath;

  if (operation === "write") {
    if (fs.existsSync(absPath)) {
      realPath = fs.realpathSync(absPath);
    } else {
      const parentReal = fs.realpathSync(nearestExistingAncestor(path.dirname(absPath)));
      if (!isPathInside(rootReal, parentReal)) throw new Error(`Path escapes workspace "${workspace.name}"`);
    }
  } else {
    realPath = fs.realpathSync(absPath);
  }

  if (!isPathInside(rootReal, realPath) || !isPathInside(rootReal, absPath)) {
    throw new Error(`Path escapes workspace "${workspace.name}"`);
  }

  return {
    workspace,
    root: rootReal,
    absPath,
    realPath,
    relativePath: path.relative(rootReal, absPath) || ".",
  };
}

export function parseWorkspaceFlag(value, flags: any = {}) {
  const text = String(value || "").trim();
  if (!text) throw new Error("--workspace requires <name=path> or <path>");
  const eq = text.indexOf("=");
  const explicitName = eq > 0 ? text.slice(0, eq).trim() : "";
  const workspacePath = eq > 0 ? text.slice(eq + 1).trim() : text;
  const name = sanitizeWorkspaceName(explicitName || path.basename(expandPath(workspacePath)) || "workspace");
  return {
    name,
    path: workspacePath,
    read: flags.read === undefined ? true : Boolean(flags.read),
    write: flags.readOnly ? false : Boolean(flags.allowWrite),
    shell: flags.readOnly ? false : Boolean(flags.allowShell),
  };
}

export function normalizeHandsWorkspaces(workspaces) {
  if (!Array.isArray(workspaces)) return [];
  return workspaces.map((workspace, index) => {
    if (typeof workspace === "string") workspace = parseWorkspaceFlag(workspace);
    if (!workspace || typeof workspace !== "object") throw new Error(`cloudHands.workspaces[${index}] must be an object or path string`);
    const name = sanitizeWorkspaceName(workspace.name || path.basename(expandPath(workspace.path || "")) || `workspace-${index + 1}`);
    if (!workspace.path) throw new Error(`cloudHands.workspaces[${index}] is missing path`);
    return {
      name,
      path: String(workspace.path),
      read: workspace.read !== false,
      write: workspace.write === true,
      shell: workspace.shell === true,
    };
  });
}

export async function createHandsDevServer({ host = "127.0.0.1", port = DEFAULT_HANDS_PORT, stateFile, tokenFile, maxBodyBytes = 1024 * 1024, io = console }: any) {
  const token = ensureTokenFile(tokenFile);
  let state = readHandsServerState(stateFile);
  const saveState = () => writeHandsServerState(stateFile, state);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, {
          ok: true,
          protocol: HANDS_PROTOCOL,
          cloudBaseProtocol: CLOUD_BASE_PROTOCOL,
          time: new Date().toISOString(),
          counts: summarizeHandsServerState(state),
        });
        return;
      }

      if (!tokenMatches(token, parseBearerToken(req.headers.authorization))) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/base/turns") {
        const body = await readJsonRequestBody(req, maxBodyBytes);
        const turn = normalizeCloudBaseTurn(body);
        state.turns.push(turn);
        saveState();
        writeJson(res, 200, {
          ok: true,
          protocol: CLOUD_BASE_PROTOCOL,
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          reply: `mock cloud base accepted ${turn.requestId || turn.turnId}; no production model is attached to relaymux hands serve-dev`,
        });
        return;
      }

      const turnMatch = /^\/v1\/base\/turns\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && turnMatch) {
        const turn = state.turns.find((item) => item.turnId === decodeURIComponent(turnMatch[1]));
        if (!turn) throw httpError(404, "turn not found");
        writeJson(res, 200, { ok: true, turn });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/tasks") {
        const body = await readJsonRequestBody(req, maxBodyBytes);
        const task = normalizeTaskForQueue(body);
        state.tasks.push(task);
        saveState();
        writeJson(res, 202, { ok: true, task });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/tasks") {
        writeJson(res, 200, { ok: true, tasks: state.tasks });
        return;
      }

      const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && taskMatch) {
        const task = state.tasks.find((item) => item.id === decodeURIComponent(taskMatch[1]));
        if (!task) throw httpError(404, "task not found");
        writeJson(res, 200, { ok: true, task });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/hands/poll") {
        const body = await readJsonRequestBody(req, maxBodyBytes);
        const workerId = String(body.workerId || "").slice(0, 200);
        if (!workerId) throw httpError(400, "workerId is required");
        const leaseMs = Number(body.leaseMs || 60000);
        const task = leaseNextTask(state, {
          workerId,
          leaseMs: Number.isFinite(leaseMs) ? leaseMs : 60000,
          capabilities: body.capabilities || {},
        });
        saveState();
        writeJson(res, 200, { ok: true, task });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/hands/result") {
        const body = await readJsonRequestBody(req, maxBodyBytes);
        const task = completeLeasedTask(state, body);
        saveState();
        writeJson(res, 200, { ok: true, task });
        return;
      }

      writeJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const statusCode = error?.statusCode || 500;
      if (statusCode >= 500) io.stderr?.write?.(`hands dev server error: ${error.stack || error.message}\n`);
      if (!res.headersSent) writeJson(res, statusCode, { ok: false, error: error.message || String(error) });
      else res.end();
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return new Promise<any>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      server.on("error", (error) => io.stderr?.write?.(`hands dev server error: ${error.message}\n`));
      resolve(server);
    });
    server.listen(port, host);
  });
}

export function readHandsServerState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      version: 1,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      turns: Array.isArray(parsed.turns) ? parsed.turns : [],
    };
  } catch {
    return { version: 1, tasks: [], turns: [] };
  }
}

export function writeHandsServerState(stateFile, state) {
  ensureDirectory(path.dirname(stateFile));
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, tasks: state.tasks || [], turns: state.turns || [] }, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function normalizeTaskForQueue(body) {
  const normalized = normalizeTaskForExecution({ ...body, id: body.id || makeProtocolId("task") });
  return {
    protocol: HANDS_PROTOCOL,
    id: normalized.id,
    kind: normalized.kind,
    workspace: normalized.workspace,
    args: normalized.args,
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
}

function normalizeTaskForExecution(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("hands task must be an object");
  const kind = normalizeTaskKind(task.kind || task.type);
  const workspace = String(task.workspace || task.workspaceName || "").trim();
  if (!workspace) throw new Error("hands task requires workspace");
  const args = task.args && typeof task.args === "object" && !Array.isArray(task.args)
    ? { ...task.args }
    : { ...task };
  delete args.id;
  delete args.kind;
  delete args.type;
  delete args.workspace;
  delete args.workspaceName;

  if (kind === "readFile" || kind === "writeFile" || kind === "listDir") {
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error(`${kind} task requires args.path`);
  }
  if (kind === "writeFile" && args.content === undefined) throw new Error("writeFile task requires args.content");
  if (kind === "shell") shellArgv(args);

  return {
    id: String(task.id || ""),
    leaseId: task.leaseId ? String(task.leaseId) : undefined,
    kind,
    workspace,
    args,
  };
}

function normalizeTaskKind(kind) {
  const value = String(kind || "").trim();
  const aliases = {
    read: "readFile",
    "read-file": "readFile",
    readFile: "readFile",
    write: "writeFile",
    "write-file": "writeFile",
    writeFile: "writeFile",
    list: "listDir",
    "list-dir": "listDir",
    listDir: "listDir",
    shell: "shell",
    command: "shell",
  };
  const normalized = aliases[value];
  if (!normalized) throw new Error(`Unsupported hands task kind "${value}"`);
  return normalized;
}

function buildTaskFromFlags(flags, rest) {
  const kind = normalizeTaskKind(flags.kind || rest[0]);
  const workspace = String(flags.workspaceName || flags.workspace || "").trim();
  if (!workspace) throw new Error("hands enqueue requires --workspace <name>");
  const args: any = {};
  if (flags.cwd) args.cwd = String(flags.cwd);
  if (flags.timeoutMs) args.timeoutMs = Number(flags.timeoutMs);

  if (kind === "shell") {
    if (flags.argvJson) {
      args.argv = parseJsonArray(flags.argvJson, "--argv-json");
    } else if (flags.command) {
      args.command = String(flags.command);
    } else if (rest.length > 1) {
      args.command = rest.slice(1).join(" ");
    } else {
      throw new Error("shell enqueue requires --command <text> or --argv-json <array>");
    }
  } else {
    if (!flags.path) throw new Error(`${kind} enqueue requires --path <relative-path>`);
    args.path = String(flags.path);
    if (kind === "writeFile") {
      if (flags.contentFile) args.content = fs.readFileSync(expandPath(flags.contentFile), "utf8");
      else if (flags.content !== undefined) args.content = String(flags.content);
      else throw new Error("write-file enqueue requires --content or --content-file");
      if (flags.append) args.append = true;
    }
  }

  return { protocol: HANDS_PROTOCOL, kind, workspace, args };
}

function leaseNextTask(state, { workerId, leaseMs, capabilities }) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  for (const task of state.tasks) {
    if (task.status === "succeeded" || task.status === "failed") continue;
    const expired = task.status === "leased" && Date.parse(task.leaseExpiresAt || "") <= now;
    if (task.status !== "queued" && !expired) continue;
    if (!workerCanRunTask(capabilities, task)) continue;

    task.status = "leased";
    task.workerId = workerId;
    task.leaseId = makeProtocolId("lease");
    task.leaseExpiresAt = new Date(now + leaseMs).toISOString();
    task.leasedAt = nowIso;
    task.attempts = Number(task.attempts || 0) + 1;
    return task;
  }
  return null;
}

function completeLeasedTask(state, body) {
  const taskId = String(body.taskId || "");
  const leaseId = String(body.leaseId || "");
  const workerId = String(body.workerId || "");
  if (!taskId || !leaseId || !workerId) throw httpError(400, "taskId, leaseId, and workerId are required");
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw httpError(404, "task not found");
  if (task.status !== "leased" || task.leaseId !== leaseId || task.workerId !== workerId) {
    throw httpError(409, "task lease no longer belongs to this worker");
  }
  const result = body.result && typeof body.result === "object" ? body.result : { ok: false, error: "missing result" };
  task.status = result.ok ? "succeeded" : "failed";
  task.completedAt = new Date().toISOString();
  task.result = result;
  delete task.leaseExpiresAt;
  return task;
}

function workerCanRunTask(capabilities, task) {
  const workspaces = Array.isArray(capabilities?.workspaces) ? capabilities.workspaces : [];
  const workspace = workspaces.find((item) => item.name === task.workspace);
  if (!workspace) return false;
  if (task.kind === "shell") return workspace.shell === true;
  if (task.kind === "writeFile") return workspace.write === true;
  return workspace.read === true;
}

function workerCapabilities(runtime) {
  return {
    protocol: HANDS_PROTOCOL,
    workerId: runtime.workerId,
    workspaces: runtime.workspaces.map((workspace) => ({
      name: workspace.name,
      read: workspace.read,
      write: workspace.write,
      shell: workspace.shell,
    })),
  };
}

function normalizeCloudBaseTurn(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "JSON object body is required");
  if (body.protocol && body.protocol !== CLOUD_BASE_PROTOCOL) throw httpError(400, `unsupported cloud base protocol ${body.protocol}`);
  const prompt = String(body.prompt || "");
  if (!prompt.trim()) throw httpError(400, "prompt is required");
  const turnId = makeProtocolId("turn");
  return {
    protocol: CLOUD_BASE_PROTOCOL,
    turnId,
    sessionId: String(body.sessionId || "default"),
    requestId: String(body.requestId || turnId),
    prompt,
    promptFile: body.promptFile ? String(body.promptFile) : "",
    configPath: body.configPath ? String(body.configPath) : "",
    receivedAt: new Date().toISOString(),
    status: "succeeded",
  };
}

function shellArgv(args) {
  if (Array.isArray(args.argv)) {
    if (!args.argv.length || !args.argv.every((part) => typeof part === "string")) {
      throw new Error("shell args.argv must be a non-empty string array");
    }
    return args.argv;
  }
  if (typeof args.command === "string" && args.command.trim()) {
    return ["/bin/sh", "-lc", args.command];
  }
  throw new Error("shell task requires args.argv or args.command");
}

function taskResult(ok, task, startedAt, fields) {
  return {
    ok,
    taskId: task.id,
    kind: task.kind,
    workspace: task.workspace,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...fields,
  };
}

function validateHandsRuntime(runtime) {
  if (!runtime.endpoint) throw new Error("hands run requires --endpoint or cloudHands.endpoint");
  if (!runtime.workspaces.length) throw new Error("hands run requires at least one explicit workspace (cloudHands.workspaces or --workspace <name=path>)");
  for (const workspace of runtime.workspaces) {
    const root = expandPath(workspace.path);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`hands workspace "${workspace.name}" must be an existing directory: ${root}`);
    }
    if (!workspace.read && !workspace.write && !workspace.shell) {
      throw new Error(`hands workspace "${workspace.name}" has no enabled permissions`);
    }
  }
}

function findWorkspace(workspaces, name) {
  return workspaces.find((workspace) => workspace.name === name);
}

function assertWorkspacePermission(workspace, operation) {
  if (operation === "read" && workspace.read !== true) throw new Error(`Workspace "${workspace.name}" does not allow reads`);
  if (operation === "write" && workspace.write !== true) throw new Error(`Workspace "${workspace.name}" does not allow writes`);
  if (operation === "shell" && workspace.shell !== true) throw new Error(`Workspace "${workspace.name}" does not allow shell commands`);
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExistingAncestor(value) {
  let current = value;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function sanitizeWorkspaceName(value) {
  return String(value || "workspace")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}

function formatWorkspaceStatus(workspace) {
  const permissions = [];
  if (workspace.read) permissions.push("read");
  if (workspace.write) permissions.push("write");
  if (workspace.shell) permissions.push("shell");
  return {
    name: workspace.name,
    path: expandPath(workspace.path),
    permissions,
  };
}

function summarizeHandsServerState(state) {
  const counts: any = { tasks: state.tasks.length, turns: state.turns.length };
  for (const task of state.tasks) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }
  return counts;
}

function handsDevServerEndpoints(host, port) {
  const base = `http://${formatHostForUrl(host)}:${port}`;
  return {
    health: `${base}/health`,
    cloudBaseTurns: `${base}/v1/base/turns`,
    enqueueTask: `${base}/v1/tasks`,
    pollHands: `${base}/v1/hands/poll`,
    postHandsResult: `${base}/v1/hands/result`,
  };
}

function defaultWorkerId() {
  return `${os.hostname() || "local"}-${process.pid}`.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 120);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseJsonArray(raw, flagName) {
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string")) {
      throw new Error("must be an array of strings");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${flagName} ${error.message}`);
  }
}

function formatHostForUrl(host) {
  const value = String(host || "").trim();
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function isLocalDevServerHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handsHelpText() {
  return `relaymux hands - local filesystem/tool worker for a cloud-resident base agent

Usage:
  relaymux hands status [--json]
  relaymux hands run --endpoint <url> --token-file <path> --workspace <name=path> [--allow-write] [--allow-shell]
  relaymux hands serve-dev [--host 127.0.0.1] [--port 47773] [--state-file <path>] [--token-file <path>]
  relaymux hands enqueue <shell|read-file|write-file|list-dir> --endpoint <url> --token-file <path> --workspace <name> [...]

Worker options:
  --workspace <name=path>   Explicit local workspace root for this worker (one via CLI; use config for many)
  --allow-write             Permit write-file tasks in the workspace
  --allow-shell             Permit shell tasks in the workspace
  --read-only               Force read-only even if allow flags are present
  --worker-id <id>          Stable worker id (defaults to host-pid)
  --poll-ms <ms>            Poll interval when no task is available
  --lease-ms <ms>           Task lease duration before another worker can reclaim it
  --once                    Poll/process at most one task, then exit
  --dry-run                 Print resolved worker/dev-server configuration without connecting
  --allow-remote-dev-server Permit serve-dev to bind a non-loopback host for private-network testing

Task enqueue examples:
  relaymux hands enqueue read-file --workspace app --path package.json
  relaymux hands enqueue shell --workspace app --cwd . --command "npm test"

This command never grants whole-machine access by default. Workspaces are allowlisted, writes and shell are opt-in, and every task path is resolved under its workspace root.
`;
}
