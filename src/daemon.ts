import fs from "node:fs";
import path from "node:path";

import { createCompletionWebhookServer } from "./webhook.js";
import { buildIncomingOrchestratorPrompt, buildTerminalOrchestratorPrompt, buildWebhookOrchestratorPrompt, runOrchestrator } from "./orchestrator.js";
import { formatIncomingForPrompt, isIncomingUserMessage, receiveMessages, sendMessage } from "./message-io.js";
import { ensureDirectory } from "./paths.js";
import { validateSessionName } from "./tmux.js";

export async function runDaemon({ flags, configInfo, stateDir, io = defaultIo() }) {
  const sessionOverride = flags.session || io.env?.RELAYMUX_SESSION;
  if (sessionOverride) {
    validateSessionName(String(sessionOverride));
  }
  const config = sessionOverride
    ? { ...configInfo.config, session: String(sessionOverride) }
    : configInfo.config;
  ensureDirectory(stateDir);
  const stateFile = path.join(stateDir, "daemon-state.json");
  const state = readDaemonState(stateFile);
  const queue = [];
  const queuedIncomingIds = new Set();
  let processing = false;
  let scheduled = false;

  const log = (...args) => io.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
  const warn = (...args) => io.stderr.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
  const saveState = () => writeDaemonState(stateFile, state);

  function queueStatus() {
    return {
      queueLength: queue.length,
      processing,
      scheduled,
      queuedIncomingIds: queuedIncomingIds.size,
      initialized: state.initialized,
      lastProcessedAt: state.lastProcessedAt,
      lastWebhookAt: state.lastWebhookAt,
    };
  }

  function scheduleProcessQueue() {
    if (processing || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      processQueue().catch((error) => warn("queue processor failed:", describeError(error)));
    });
  }

  function enqueueIncoming(messages) {
    if (!messages.length) return;
    const ids = messages.map((message) => String(message.id));
    for (const id of ids) queuedIncomingIds.add(id);
    queue.push({ type: "imessage", requestId: `imsg-${Date.now().toString(36)}`, messages, ids, enqueuedAt: new Date().toISOString() });
    log(`queued incoming message(s): ${ids.join(",")}`);
    scheduleProcessQueue();
  }

  function enqueueWebhook(job) {
    queue.push(job);
    log(`queued local completion ${job.requestId} from ${job.source}; replyMode=${job.replyMode}`);
    scheduleProcessQueue();
  }

  function enqueueTerminalRequest(job) {
    queue.push(job);
    log(`queued terminal request ${job.requestId} from ${job.source}; replyMode=${job.replyMode}; wait=${job.wait ? "yes" : "no"}`);
    scheduleProcessQueue();
  }

  function enqueueJob(job) {
    if (job.type === "request") enqueueTerminalRequest(job);
    else enqueueWebhook(job);
  }

  async function processIncomingJob(job) {
    log(`processing incoming message(s): ${job.ids.join(",")}`);
    let marked = false;
    const markSeen = () => {
      if (marked) return;
      rememberSeen(state, job.ids);
      saveState();
      marked = true;
    };

    try {
      const prompt = buildIncomingOrchestratorPrompt({
        config,
        configPath: configInfo.path,
        incomingText: formatIncomingForPrompt(job.messages),
      });
      const reply = await runOrchestrator(config, { prompt, stateDir, configPath: configInfo.path, requestId: job.requestId });
      await sendMessage(config, reply, io);
      markSeen();
      log(`replied to ${job.ids.join(",")}`);
    } catch (error) {
      warn(`failed processing incoming ${job.ids.join(",")}:`, describeError(error));
      try {
        await sendMessage(config, `relaymux orchestrator hit an error: ${error.message || String(error)}`, io);
      } catch (sendError) {
        warn("also failed to send error message:", describeError(sendError));
      }
      markSeen();
    } finally {
      for (const id of job.ids) queuedIncomingIds.delete(id);
    }
  }

  async function processWebhookJob(job) {
    log(`processing local completion ${job.requestId} from ${job.source}`);
    try {
      const prompt = buildWebhookOrchestratorPrompt({ config, configPath: configInfo.path, job });
      const reply = await runOrchestrator(config, { prompt, stateDir, configPath: configInfo.path, requestId: job.requestId });
      if (job.replyMode === "imessage") {
        await sendMessage(config, reply, io);
        log(`sent completion reply for ${job.requestId}`);
      } else {
        log(`processed quiet completion ${job.requestId}: ${oneLine(reply).slice(0, 240)}`);
      }
    } catch (error) {
      warn(`failed processing local completion ${job.requestId}:`, describeError(error));
      if (job.replyMode === "imessage") {
        try {
          await sendMessage(config, `relaymux orchestrator hit an error processing ${job.source}: ${error.message || String(error)}`, io);
        } catch (sendError) {
          warn("also failed to send completion error message:", describeError(sendError));
        }
      }
    }
  }

  async function processTerminalRequestJob(job) {
    log(`processing terminal request ${job.requestId} from ${job.source}`);
    try {
      const prompt = buildTerminalOrchestratorPrompt({ config, configPath: configInfo.path, job });
      const reply = await runOrchestrator(config, { prompt, stateDir, configPath: configInfo.path, requestId: job.requestId });
      if (job.replyMode === "imessage") {
        await sendMessage(config, reply, io);
        log(`sent terminal request reply for ${job.requestId}`);
      } else {
        log(`processed terminal request ${job.requestId}: ${oneLine(reply).slice(0, 240)}`);
      }
      job.deferred?.resolve({ ok: true, queued: false, reply });
    } catch (error) {
      const message = `relaymux orchestrator hit an error processing ${job.source}: ${error.message || String(error)}`;
      warn(`failed processing terminal request ${job.requestId}:`, describeError(error));
      if (job.replyMode === "imessage") {
        try {
          await sendMessage(config, message, io);
        } catch (sendError) {
          warn("also failed to send terminal request error message:", describeError(sendError));
        }
      }
      job.deferred?.resolve({ ok: false, queued: false, error: message });
    }
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        if (job.type === "imessage") await processIncomingJob(job);
        else if (job.type === "webhook") await processWebhookJob(job);
        else if (job.type === "request") await processTerminalRequestJob(job);
        else warn("dropping unknown job:", JSON.stringify(job));
      }
    } finally {
      processing = false;
      if (queue.length > 0) scheduleProcessQueue();
    }
  }

  async function pollOnce() {
    if (processing || queue.length > 0) return;
    const recent = await receiveMessages(config);
    const seen = new Set((state.seenIncomingIds || []).map(String));
    const fresh = recent
      .filter(isIncomingUserMessage)
      .filter((message) => !seen.has(String(message.id)) && !queuedIncomingIds.has(String(message.id)))
      .sort(compareMessages);
    if (fresh.length) enqueueIncoming(fresh);
  }

  log("starting relaymux iMessage orchestrator daemon");
  if (!state.initialized) {
    try {
      const recent = await receiveMessages(config);
      const initialIds = recent.filter(isIncomingUserMessage).map((message) => String(message.id));
      state.initialized = true;
      rememberSeen(state, initialIds);
      saveState();
      log(`initialized; marked ${initialIds.length} existing incoming message(s) as seen`);
    } catch (error) {
      warn("initial sync failed:", describeError(error));
      state.initialized = true;
      saveState();
    }
  }

  const webhookServer = config.daemon?.enabled === false
    ? null
    : await createCompletionWebhookServer({
        config,
        state,
        saveState,
        enqueue: enqueueJob,
        getStatus: queueStatus,
        io: { warn },
      });
  if (webhookServer) log(`local completion webhook listening on ${config.daemon?.host || "127.0.0.1"}:${Number(config.daemon?.port || 47761)}`);

  await pollOnce().catch((error) => warn("initial poll failed:", describeError(error)));
  await drainIfOnce(flags, processQueue);

  if (flags.once) {
    if (webhookServer) await closeServer(webhookServer);
    log("daemon --once complete");
    return 0;
  }

  const interval = setInterval(() => {
    pollOnce().catch((error) => warn("poll failed:", describeError(error)));
  }, Number(config.imessage?.pollMs || 3000));

  await new Promise<void>((resolve) => {
    const shutdown = async (signal) => {
      log(`shutting down (${signal})`);
      clearInterval(interval);
      if (webhookServer) await closeServer(webhookServer);
      resolve();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
  return 0;
}

export function readDaemonState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      initialized: Boolean(parsed.initialized),
      seenIncomingIds: Array.isArray(parsed.seenIncomingIds) ? parsed.seenIncomingIds.map(String) : [],
      seenWebhookIdempotencyKeys: Array.isArray(parsed.seenWebhookIdempotencyKeys) ? parsed.seenWebhookIdempotencyKeys.map(String) : [],
      lastProcessedAt: parsed.lastProcessedAt,
      lastWebhookAt: parsed.lastWebhookAt,
    };
  } catch {
    return { initialized: false, seenIncomingIds: [], seenWebhookIdempotencyKeys: [] };
  }
}

export function writeDaemonState(stateFile, state) {
  ensureDirectory(path.dirname(stateFile));
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function rememberSeen(state, ids) {
  const seen = new Set((state.seenIncomingIds || []).map(String));
  for (const id of ids) seen.add(String(id));
  state.seenIncomingIds = Array.from(seen).slice(-1000);
  state.lastProcessedAt = new Date().toISOString();
}

function compareMessages(a, b) {
  const aId = Number(a.id);
  const bId = Number(b.id);
  if (Number.isFinite(aId) && Number.isFinite(bId)) return aId - bId;
  return String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id));
}

async function drainIfOnce(flags, processQueue) {
  if (!flags.once) return;
  await processQueue();
}

async function closeServer(server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function describeError(error) {
  const parts = [error?.message || String(error)];
  const stdoutBytes = Buffer.byteLength(String(error?.stdout || ""));
  const stderrBytes = Buffer.byteLength(String(error?.stderr || ""));
  if (stdoutBytes) parts.push(`stdout captured: ${stdoutBytes} bytes`);
  if (stderrBytes) parts.push(`stderr captured: ${stderrBytes} bytes`);
  if (error?.lastActivityAt) {
    parts.push(`last activity: ${error.lastActivityAt}${error.lastActivityReason ? ` (${error.lastActivityReason})` : ""}`);
  }
  if (error?.signal) parts.push(`signal: ${error.signal}`);
  return parts.join("\n");
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function defaultIo() {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}
