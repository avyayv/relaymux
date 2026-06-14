import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultRelaymuxHome, defaultRelaymuxHomeConfigValue, expandPath } from "./paths.js";

export function defaultImessageIntegration() {
  return {
    enabled: false,
    chatId: "",
    recipient: "",
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
  };
}

export function defaultTelegramIntegration() {
  return {
    enabled: false,
    chatId: "",
    botTokenEnv: "TELEGRAM_BOT_TOKEN",
    botTokenFile: "",
    parseMode: "",
    apiBaseUrl: "https://api.telegram.org",
    timeoutMs: 30000,
    maxMessageChars: 3900,
  };
}

export function defaultConfig(env = process.env) {
  const homeDir = defaultRelaymuxHomeConfigValue(env);
  const stateDir = path.posix.join(homeDir, "state");
  const tokenFile = path.posix.join(stateDir, "webhook-token");
  const logDir = path.posix.join(homeDir, "logs");

  return {
    version: 1,
    session: "agents",
    stateDir,
    holdOnExit: false,
    tmux: {
      sessionMode: "shared",
      sessionPrefix: "rmx",
      extraWindows: [],
    },
    launchNotifications: {
      onExit: "never",
      replyMode: "none",
      tailLines: 80,
      tailBytes: 4000,
    },
    integrations: {},
    daemon: {
      enabled: true,
      host: "127.0.0.1",
      port: 47761,
      tokenFile,
      maxBodyBytes: 65536,
      launchAgentLabel: "com.relaymux.daemon",
      launchMode: "direct",
      supervisorPollMs: 15000,
      selfRestartDelayMs: 30000,
      watchdog: {
        enabled: true,
        intervalSeconds: 60,
      },
      logDir,
    },
    orchestrator: {
      description: "Pi orchestrator command. Use a non-interactive Pi invocation if your pi binary supports one.",
      cwd: "~",
      command: ["pi", "{prompt}"],
      promptMode: "arg",
      timeoutMs: 0,
      timeoutMode: "activity",
      hardTimeoutMs: 0,
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
        description: "Codex CLI template. Edit flags to match your local install.",
        command: ["codex", "{prompt}"],
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
  return path.join(defaultRelaymuxHome(env), "config.json");
}

export function legacyDefaultConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME ? expandPath(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
  return path.join(base, "relaymux", "config.json");
}

export function legacyDefaultStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME ? expandPath(env.XDG_STATE_HOME) : path.join(os.homedir(), ".local", "state");
  return path.join(base, "relaymux");
}

export function loadConfig({ configPath, env = process.env }: any = {}) {
  const explicitConfigPath = Boolean(configPath);
  const defaultPath = defaultConfigPath(env);
  const legacyPath = legacyDefaultConfigPath(env);
  let resolvedPath = expandPath(configPath || defaultPath);

  if (!explicitConfigPath && !fs.existsSync(resolvedPath) && legacyPath !== resolvedPath && fs.existsSync(legacyPath)) {
    resolvedPath = legacyPath;
  }

  if (!fs.existsSync(resolvedPath)) {
    return {
      config: defaultConfig(env),
      path: resolvedPath,
      exists: false,
      defaultPath,
      legacyPath,
      usingLegacyDefault: false,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  return {
    config: normalizeConfig(mergeConfig(defaultConfig(env), parsed), parsed),
    path: resolvedPath,
    exists: true,
    defaultPath,
    legacyPath,
    usingLegacyDefault: !explicitConfigPath && legacyPath === resolvedPath && defaultPath !== legacyPath,
  };
}

export function writeDefaultConfig(configPath, { force = false, env = process.env } = {}) {
  return writeConfig(configPath, defaultConfig(env), { force, env });
}

export function writeConfig(configPath, config, { force = false, env = process.env } = {}) {
  const resolvedPath = expandPath(configPath || defaultConfigPath(env));
  if (fs.existsSync(resolvedPath) && !force) {
    throw new Error(`Config already exists at ${resolvedPath}. Use --force to overwrite.`);
  }
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(resolvedPath, 0o600); } catch {}
  return resolvedPath;
}

export function resolveStateDir(config, env = process.env) {
  return expandPath(config.stateDir || defaultConfig(env).stateDir);
}

export function resolveLogDir(config, env = process.env) {
  return expandPath(config.daemon?.logDir || defaultConfig(env).daemon.logDir);
}

export function resolveTokenFile(config, env = process.env) {
  return expandPath(config.daemon?.tokenFile || defaultConfig(env).daemon.tokenFile);
}

export function getIntegration(config, name) {
  const raw = integrationOverride(config, name);
  const defaults = name === "imessage"
    ? defaultImessageIntegration()
    : name === "telegram"
      ? defaultTelegramIntegration()
      : { enabled: false };
  const merged = mergeConfig(defaults, raw || {});
  if (raw && !Object.prototype.hasOwnProperty.call(raw, "enabled")) {
    merged.enabled = true;
  }
  return merged;
}

export function isIntegrationEnabled(config, name) {
  return getIntegration(config, name).enabled === true;
}

export function defaultReplyModeForConfig(config) {
  if (isIntegrationEnabled(config, "imessage")) return "imessage";
  if (isIntegrationEnabled(config, "telegram")) return "telegram";
  return "none";
}

function normalizeConfig(config, override) {
  if (!isPlainObject(override)) {
    return config;
  }

  if (override.stateDir) {
    config.daemon = config.daemon || {};
    if (!hasOwnPath(override, ["daemon", "tokenFile"])) {
      config.daemon.tokenFile = path.posix.join(String(override.stateDir), "webhook-token");
    }
    if (!hasOwnPath(override, ["daemon", "logDir"])) {
      config.daemon.logDir = path.posix.join(String(override.stateDir), "logs");
    }
  }

  config.integrations = config.integrations || {};

  if (hasOwnPath(override, ["integrations", "imessage"])) {
    config.integrations.imessage = normalizeIntegration(defaultImessageIntegration(), override.integrations.imessage);
  } else if (hasOwnPath(override, ["imessage"])) {
    config.integrations.imessage = normalizeIntegration(defaultImessageIntegration(), override.imessage);
  }

  if (hasOwnPath(override, ["integrations", "telegram"])) {
    config.integrations.telegram = normalizeIntegration(defaultTelegramIntegration(), override.integrations.telegram);
  }

  if (hasOwnPath(override, ["imessage"]) && config.integrations.imessage?.enabled && !hasOwnPath(override, ["launchNotifications", "replyMode"])) {
    config.launchNotifications = config.launchNotifications || {};
    config.launchNotifications.replyMode = "imessage";
  }

  return config;
}

function normalizeIntegration(defaults, override) {
  if (override === false) return { ...defaults, enabled: false };
  const raw = isPlainObject(override) ? override : {};
  const normalized = mergeConfig(defaults, raw);
  if (!Object.prototype.hasOwnProperty.call(raw, "enabled")) {
    normalized.enabled = true;
  } else {
    normalized.enabled = raw.enabled === true;
  }
  return normalized;
}

function integrationOverride(config, name) {
  if (hasOwnPath(config, ["integrations", name])) return config.integrations[name];
  if (name === "imessage" && hasOwnPath(config, ["imessage"])) return config.imessage;
  return null;
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

function hasOwnPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
      return false;
    }
    current = current[key];
  }
  return true;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
