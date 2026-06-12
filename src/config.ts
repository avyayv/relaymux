import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandPath } from "./paths.js";

export function defaultConfig() {
  const stateDir = "~/.local/state/relaymux";
  const tokenFile = `${stateDir}/webhook-token`;

  return {
    version: 1,
    session: "agents",
    stateDir,
    holdOnExit: false,
    tmux: {
      sessionMode: "per-worktree",
      sessionPrefix: "rmx",
      extraWindows: [],
    },
    imessage: {
      chatId: "CHAT_ID_OR_PHONE",
      recipient: "+15555550123",
      pollMs: 3000,
      syncLimit: 5,
      maxReplyChars: 1400,
      receive: {
        backend: "command",
        command: {
          description: "Command must print recent messages as JSON/JSONL. This imsg example is a placeholder.",
          argv: ["imsg", "history", "--chat-id", "{chatId}", "--limit", "{limit}", "--json"],
          cwd: "~",
          timeoutMs: 30000,
        },
      },
      send: {
        backend: "command",
        command: {
          description: "Command sends one text chunk. This imsg example is a placeholder.",
          argv: ["imsg", "send", "--chat-id", "{chatId}", "--text", "{text}", "--json"],
          cwd: "~",
          timeoutMs: 60000,
        },
      },
    },
    daemon: {
      enabled: true,
      host: "127.0.0.1",
      port: 47761,
      tokenFile,
      maxBodyBytes: 65536,
      launchAgentLabel: "com.relaymux.daemon",
      launchMode: "direct",
      supervisorPollMs: 15000,
      logDir: `${stateDir}/logs`,
    },
    orchestrator: {
      description: "Pi orchestrator command. Use a non-interactive Pi invocation if your pi binary supports one.",
      cwd: "~",
      command: ["pi", "{prompt}"],
      promptMode: "arg",
      timeoutMs: 0,
      maxBufferBytes: 10 * 1024 * 1024,
      systemPromptFile: "",
      extraSystemPrompt: "",
    },
    agents: {
      pi: {
        description: "Pi CLI template. Edit this command to match your local install.",
        command: ["pi", "{prompt}"],
        promptMode: "arg",
      },
      codex: {
        description: "Codex CLI template with model/effort flags. Edit flags to match your local install.",
        command: ["codex", "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "{prompt}"],
        promptMode: "arg",
      },
      claude: {
        description: "Claude CLI template. Edit this command to match your local install.",
        command: ["claude", "{prompt}"],
        promptMode: "arg",
      },
      custom: {
        description: "A simple placeholder command for testing custom agent wiring.",
        command: ["sh", "-lc", "printf '%s\\n' \"$RELAYMUX_PROMPT\""],
        promptMode: "env",
      },
    },
    notifier: {
      command: {
        enabled: false,
        argv: [],
      },
      webhook: {
        enabled: false,
        url: "",
        headers: {},
      },
    },
  };
}

export function defaultConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "relaymux", "config.json");
}

export function loadConfig({ configPath, env = process.env }: any = {}) {
  const resolvedPath = expandPath(configPath || defaultConfigPath(env));
  if (!fs.existsSync(resolvedPath)) {
    return { config: defaultConfig(), path: resolvedPath, exists: false };
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  return {
    config: mergeConfig(defaultConfig(), parsed),
    path: resolvedPath,
    exists: true,
  };
}

export function writeDefaultConfig(configPath, { force = false } = {}) {
  return writeConfig(configPath, defaultConfig(), { force });
}

export function writeConfig(configPath, config, { force = false } = {}) {
  const resolvedPath = expandPath(configPath || defaultConfigPath());
  if (fs.existsSync(resolvedPath) && !force) {
    throw new Error(`Config already exists at ${resolvedPath}. Use --force to overwrite.`);
  }
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return resolvedPath;
}

export function resolveStateDir(config) {
  return expandPath(config.stateDir || defaultConfig().stateDir);
}

function mergeConfig(base, override) {
  if (!isPlainObject(override)) {
    return base;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfig(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
