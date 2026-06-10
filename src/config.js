import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandPath } from "./paths.js";

export function defaultConfig() {
  return {
    version: 1,
    session: "agents",
    stateDir: "~/.local/state/agentmux",
    holdOnExit: false,
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
        command: ["sh", "-lc", "printf '%s\\n' \"$AGENTMUX_PROMPT\""],
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
  return path.join(base, "agentmux", "config.json");
}

export function loadConfig({ configPath, env = process.env } = {}) {
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
  const resolvedPath = expandPath(configPath || defaultConfigPath());
  if (fs.existsSync(resolvedPath) && !force) {
    throw new Error(`Config already exists at ${resolvedPath}. Use --force to overwrite.`);
  }
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
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
