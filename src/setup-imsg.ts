import readline from "node:readline/promises";
import path from "node:path";

import { defaultConfig } from "./config.js";
import { findExecutable } from "./doctor.js";
import { expandPath } from "./paths.js";
import { runCommand } from "./process.js";

export function buildImsgConfig(options: any = {}, env = process.env) {
  const base = defaultConfig();
  const stateDir = options.stateDir || base.stateDir;
  const sessionDir = path.posix.join(stateDir, "sessions");
  const imsg = options.imsgPath || findExecutable("imsg", env) || "imsg";
  const pi = options.piPath || findExecutable("pi", env) || "pi";
  const codex = options.codexPath || findExecutable("codex", env) || "codex";
  const claude = options.claudePath || findExecutable("claude", env) || "claude";
  const chatId = options.chatId || options.recipient || "CHAT_ID_OR_PHONE";
  const cwd = options.cwd || "~";

  return {
    ...base,
    session: options.session || base.session,
    stateDir,
    imessage: {
      ...base.imessage,
      chatId,
      recipient: options.recipient || "",
      pollMs: Number(options.pollMs || base.imessage.pollMs),
      syncLimit: Number(options.syncLimit || 10),
      receive: {
        backend: "command",
        command: {
          description: "Read recent Messages.app chat history through imsg.",
          argv: [imsg, "history", "--chat-id", "{chatId}", "--limit", "{limit}", "--attachments", "--convert-attachments", "--json"],
          cwd,
          timeoutMs: 30000,
        },
      },
      send: {
        backend: "command",
        command: {
          description: "Send one reply chunk through imsg.",
          argv: [imsg, "send", "--chat-id", "{chatId}", "--text", "{text}", "--json"],
          cwd,
          timeoutMs: 60000,
        },
      },
    },
    daemon: {
      ...base.daemon,
      port: Number(options.port || base.daemon.port),
      tokenFile: path.posix.join(stateDir, "webhook-token"),
      launchAgentLabel: options.launchAgentLabel || base.daemon.launchAgentLabel,
      logDir: path.posix.join(stateDir, "logs"),
    },
    orchestrator: {
      ...base.orchestrator,
      cwd,
      command: [pi, "--print", "--continue", "--session-dir", sessionDir, "{prompt}"],
      promptMode: "arg",
    },
    agents: {
      pi: {
        description: "Default Pi subagent launched in tmux.",
        command: [pi, "{prompt}"],
        promptMode: "arg",
      },
      codex: {
        description: "Codex subagent. Edit flags to match your local install.",
        command: [codex, "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "{prompt}"],
        promptMode: "arg",
      },
      claude: {
        description: "Claude subagent.",
        command: [claude, "{prompt}"],
        promptMode: "arg",
      },
    },
  };
}

export function discoverImsgChats({ imsgPath = "imsg", limit = 20, env = process.env }: any = {}) {
  const result = runCommand(imsgPath, ["chats", "--limit", String(limit), "--json"], { allowFailure: true, env });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${imsgPath} chats failed with ${result.status}`);
  }
  return parseJsonOrJsonl(result.stdout).map(normalizeChat).filter((chat) => chat.id);
}

export async function resolveImsgChatId(flags: any, io: any, env = process.env) {
  if (flags.chatId) return String(flags.chatId);
  if (flags.recipient) return String(flags.recipient);

  const imsgPath = flags.imsgPath || findExecutable("imsg", env) || "imsg";
  let chats = [];
  try {
    chats = discoverImsgChats({ imsgPath, limit: Number(flags.chatLimit || 20), env });
  } catch (error) {
    if (!isInteractive(io)) {
      throw new Error(`Could not discover imsg chats (${error.message}). Re-run with --chat-id <id>.`);
    }
    io.stderr.write(`Could not discover imsg chats: ${error.message}\n`);
  }

  if (isInteractive(io)) {
    if (chats.length) {
      io.stdout.write("Choose the iMessage/SMS chat for agentmux:\n");
      for (const [index, chat] of chats.entries()) {
        io.stdout.write(`${index + 1}. ${formatChat(chat)}\n`);
      }
      io.stdout.write("\n");
    }
    const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
    try {
      const answer = (await rl.question("Chat number or id/phone: ")).trim();
      if (!answer) throw new Error("chat id is required");
      const numeric = Number(answer);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= chats.length) {
        return chats[numeric - 1].id;
      }
      return answer;
    } finally {
      rl.close();
    }
  }

  const suggestions = chats.slice(0, 10).map((chat) => `  ${chat.id}\t${chat.label}`).join("\n");
  throw new Error(`Missing --chat-id <id>.${suggestions ? ` Recent chats:\n${suggestions}` : ""}`);
}

export function formatChat(chat) {
  return [chat.id, chat.label].filter(Boolean).join("\t");
}

function normalizeChat(chat) {
  const id = chat.id ?? chat.chat_id ?? chat.rowid ?? chat.guid ?? chat.identifier ?? chat.chat_identifier;
  const label = chat.display_name ?? chat.name ?? chat.chat_identifier ?? chat.identifier ?? chat.service_name ?? "";
  return {
    id: id === undefined || id === null ? "" : String(id),
    label: String(label || ""),
    raw: chat,
  };
}

function parseJsonOrJsonl(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.chats)) return parsed.chats;
    return [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function isInteractive(io) {
  return Boolean(io.stdin?.isTTY && io.stdout?.isTTY);
}

export function initOptionsFromFlags(flags) {
  return {
    chatId: flags.chatId,
    recipient: flags.recipient,
    cwd: flags.cwd ? expandPath(flags.cwd) : undefined,
    stateDir: flags.stateDir,
    session: flags.session,
    port: flags.port,
    pollMs: flags.pollMs,
    syncLimit: flags.syncLimit,
    launchAgentLabel: flags.launchAgentLabel,
    imsgPath: flags.imsgPath,
    piPath: flags.piPath,
    codexPath: flags.codexPath,
    claudePath: flags.claudePath,
  };
}
