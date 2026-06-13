import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { runCloudBaseOrchestrator, resolveOrchestratorBackend } from "./cloud-base.js";
import { buildAgentInvocation } from "./command.js";
import { DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT, buildRuntimePromptContext } from "./prompt.js";
import { resolveStateDir, resolveTokenFile } from "./config.js";
import { defaultRelaymuxHome, expandPath, ensureDirectory, readTextFile } from "./paths.js";
import { runCommandAsync } from "./async-process.js";

export function buildIncomingOrchestratorPrompt({ config, configPath, incomingText }) {
  return buildFullPrompt({
    config,
    configPath,
    title: "Incoming iMessage/SMS turn",
    body: incomingText,
  });
}

export function buildWebhookOrchestratorPrompt({ config, configPath, job }) {
  const metadataText = Object.keys(job.metadata || {}).length
    ? `\nMetadata JSON:\n${JSON.stringify(job.metadata, null, 2)}`
    : "";
  const idempotencyText = job.idempotencyKey ? `\nIdempotency key: ${job.idempotencyKey}` : "";
  const replyInstruction = job.replyMode === "imessage"
    ? "Reply mode is imessage: produce one concise user-visible text-message update. Avoid spam and mention only meaningful completion, failure, or blockers."
    : "Reply mode is none: process this local update as context only. The daemon will not text the user, so return a short internal acknowledgement.";

  return buildFullPrompt({
    config,
    configPath,
    title: "Local subagent completion/update",
    body: `Source/from: ${job.source}\nRequest id: ${job.requestId}\nReceived at: ${job.receivedAt}\nReply mode: ${job.replyMode}${idempotencyText}${metadataText}\n\nMessage:\n${job.text}\n\n${replyInstruction}`,
  });
}

export function buildTerminalOrchestratorPrompt({ config, configPath, job }) {
  const metadataText = Object.keys(job.metadata || {}).length
    ? `\nMetadata JSON:\n${JSON.stringify(job.metadata, null, 2)}`
    : "";
  const replyInstruction = job.replyMode === "imessage"
    ? "Reply mode is imessage: do the requested work, then produce one concise user-visible text-message status. The daemon will also return the same text to the terminal command."
    : "Reply mode is none: do the requested work and return one concise terminal-visible status. The daemon will not text the user.";

  return buildFullPrompt({
    config,
    configPath,
    title: "Terminal request",
    body: `Source/from: ${job.source}\nRequest id: ${job.requestId}\nReceived at: ${job.receivedAt}\nReply mode: ${job.replyMode}${metadataText}\n\nMessage:\n${job.text}\n\nThis request came from a local terminal command. ${replyInstruction}`,
  });
}

export function buildFullPrompt({ config, configPath, title, body }) {
  const daemon = config.daemon || {};
  const system = [
    DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT,
    buildCloudModePrompt(config),
    readOptionalPromptFile(config.orchestrator?.systemPromptFile),
    config.orchestrator?.extraSystemPrompt,
  ].filter((part) => String(part || "").trim()).join("\n\n");
  const host = formatHostForUrl(daemon.host || "127.0.0.1");
  const webhookUrl = `http://${host}:${Number(daemon.port || 47761)}/message`;
  const runtime = buildRuntimePromptContext({
    configPath,
    session: config.session || "agents",
    sessionMode: config.tmux?.sessionMode || "shared",
    homeDir: defaultRelaymuxHome(),
    stateDir: resolveStateDir(config),
    tokenFile: resolveTokenFile(config),
    webhookUrl,
  });

  return `${system}\n\n${runtime}\n\n# ${title}\n\n${body}`;
}

export async function runOrchestrator(config, { prompt, stateDir, configPath, requestId }) {
  const orchestrator = config.orchestrator || {};
  const resolvedRequestId = requestId || makeRequestId();
  const promptFile = writeOrchestratorPrompt(stateDir, resolvedRequestId, prompt);

  if (resolveOrchestratorBackend(config) === "cloud") {
    return await runCloudBaseOrchestrator(config, {
      prompt,
      promptFile,
      stateDir,
      configPath,
      requestId: resolvedRequestId,
    });
  }

  const cwd = expandPath(orchestrator.cwd || "~");
  const invocation = buildAgentInvocation("orchestrator", orchestrator, {
    prompt,
    promptFile,
    configPath,
    session: config.session || "agents",
    tokenFile: resolveTokenFile(config),
    webhookPort: Number(config.daemon?.port || 47761),
    webhookHost: config.daemon?.host || "127.0.0.1",
    repo: cwd,
    workdir: cwd,
    name: "orchestrator",
    runId: resolvedRequestId,
  });

  const input = invocation.stdinFile ? fs.readFileSync(invocation.stdinFile, "utf8") : undefined;
  const env: any = {
    ...process.env,
    ...invocation.env,
    RELAYMUX_CONFIG: configPath,
    RELAYMUX_ORCHESTRATOR: "1",
  };
  if (config.tmux?.sessionMode === "shared") {
    env.RELAYMUX_SESSION = config.session || "agents";
  }

  const result = await runCommandAsync(invocation.argv[0], invocation.argv.slice(1), {
    cwd,
    env,
    input,
    timeoutMs: Number(orchestrator.timeoutMs || 0),
    maxBuffer: Number(orchestrator.maxBufferBytes || 10 * 1024 * 1024),
  });

  return result.stdout.trim() || result.stderr.trim() || "Done.";
}

function buildCloudModePrompt(config) {
  if (resolveOrchestratorBackend(config) !== "cloud") return "";
  const workspaces = Array.isArray(config.cloudHands?.workspaces) ? config.cloudHands.workspaces : [];
  const workspaceLines = workspaces.length
    ? workspaces.map((workspace) => {
        const permissions = [
          workspace.read !== false ? "read" : "",
          workspace.write === true ? "write" : "",
          workspace.shell === true ? "shell" : "",
        ].filter(Boolean).join(",") || "none";
        return `  - ${workspace.name || "workspace"}: ${permissions}`;
      }).join("\n")
    : "  - none configured; ask for a workspace or report a blocker before requesting local tool execution";

  return `Cloud base/local hands mode:
- You are the durable base agent running outside the user's Mac. Do not assume your own process has the Mac's filesystem, shell, tmux, or local CLIs.
- For local filesystem or shell work, use the relaymux.hands.v1 mechanism exposed by the cloud service to queue tasks for a connected local hands worker.
- Hands tasks must target an allowlisted workspace name and a relative path/cwd inside that workspace. Do not request ../ escapes, absolute paths outside a workspace, or secret material.
- Writes and shell are only allowed when the workspace has those permissions. If the needed permission is absent, ask the user for approval/config changes or report a blocker.
- Configured hands workspace capabilities known at prompt-build time:\n${workspaceLines}`;
}

function writeOrchestratorPrompt(stateDir, requestId, prompt) {
  const dir = path.join(stateDir, "prompts");
  ensureDirectory(dir);
  const file = path.join(dir, `${sanitizeFilePart(requestId)}.orchestrator.txt`);
  fs.writeFileSync(file, prompt);
  return file;
}

function readOptionalPromptFile(file) {
  if (!file) return "";
  return readTextFile(expandPath(file));
}

function sanitizeFilePart(value) {
  return String(value || "prompt").replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 120) || "prompt";
}

function makeRequestId() {
  return `orch-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function formatHostForUrl(host) {
  const value = String(host || "").trim();
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}
