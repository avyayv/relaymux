import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultConfigPath, getIntegration, isIntegrationEnabled, legacyDefaultConfigPath, resolveLogDir, resolveStateDir } from "./config.js";
import { validateConfiguredAgentCommand } from "./command-validation.js";
import { runCommand } from "./process.js";
import { getLaunchAgentStatus, getLaunchAgentWatchdogStatus, launchAgentPath, launchAgentWatchdogPath } from "./launch-agent.js";
import { defaultRelaymuxHome } from "./paths.js";
import { webhookStatus } from "./webhook.js";

export function findExecutable(command, env = process.env) {
  if (!command) {
    return null;
  }

  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

export function collectDoctorChecks(config, configInfo, env = process.env) {
  const checks = [];
  const tmuxPath = findExecutable("tmux", env);
  let tmuxVersion = "";

  if (tmuxPath) {
    const result = runCommand("tmux", ["-V"], { allowFailure: true });
    tmuxVersion = result.status === 0 ? result.stdout.trim() : "";
  }

  checks.push({
    name: "tmux-agent-tabs",
    ok: Boolean(tmuxPath),
    detail: tmuxPath ? `${tmuxPath}${tmuxVersion ? ` (${tmuxVersion})` : ""}; used only for agent tabs/sessions` : "not found on PATH; agent tabs need tmux",
  });

  checks.push({
    name: "config",
    ok: configInfo.exists,
    detail: configInfo.exists ? configInfo.path : `not initialized (${configInfo.path})`,
  });

  checks.push({
    name: "relaymux-home",
    ok: true,
    detail: `${defaultRelaymuxHome(env)}; default config ${defaultConfigPath(env)}; state ${resolveStateDir(config, env)}; logs ${resolveLogDir(config, env)}`,
  });

  const legacyPath = legacyDefaultConfigPath(env);
  if (configInfo.exists && configInfo.path === legacyPath) {
    checks.push({
      name: "legacy-config-path",
      ok: true,
      detail: `using legacy config path ${legacyPath}; run relaymux migrate-home --dry-run to inventory ~/.relaymux migration`,
    });
  }

  if (configInfo.exists) {
    const stat = fs.statSync(configInfo.path);
    const mode = stat.mode & 0o777;
    checks.push({
      name: "config-permissions",
      ok: (mode & 0o022) === 0,
      detail: `${configInfo.path} mode 0${mode.toString(8)}`,
    });
  }

  checks.push(commandCheck("orchestrator", config.orchestrator?.command?.[0], env));

  const imessage = getIntegration(config, "imessage");
  if (isIntegrationEnabled(config, "imessage")) {
    if (imessage.receive?.backend === "command" && imessage.receive?.enabled !== false) {
      checks.push(commandCheck("imessage-receive", imessage.receive.command?.argv?.[0], env));
    }
    if (imessage.send?.backend === "command" && imessage.send?.enabled !== false) {
      checks.push(commandCheck("imessage-send", imessage.send.command?.argv?.[0], env));
    }
  }

  const telegram = getIntegration(config, "telegram");
  if (isIntegrationEnabled(config, "telegram")) {
    checks.push({
      name: "telegram-chat-id",
      ok: Boolean(String(telegram.chatId || "").trim()) && telegram.chatId !== "TELEGRAM_CHAT_ID",
      detail: telegram.chatId && telegram.chatId !== "TELEGRAM_CHAT_ID" ? "configured" : "missing config.integrations.telegram.chatId",
    });
    checks.push(telegramTokenCheck(telegram, env));
  }

  const webhook = webhookStatus(config);
  checks.push({
    name: "webhook-token",
    ok: !webhook.tokenFileExists || webhook.tokenFileMode === "0600",
    detail: webhook.tokenFileExists ? `${webhook.tokenFile} mode ${webhook.tokenFileMode}` : `will be created at ${webhook.tokenFile}`,
  });
  const launchAgent: any = getLaunchAgentStatus(config);
  const daemonEnabled = config.daemon?.enabled !== false;
  const logDir = resolveLogDir(config, env);
  checks.push({
    name: "background-service",
    ok: !daemonEnabled || !launchAgent.supported || launchAgent.loaded,
    fatal: false,
    severity: launchAgent.loaded || !daemonEnabled ? undefined : "warning",
    detail: daemonEnabled
      ? launchAgent.supported
        ? launchAgent.loaded
          ? `direct/background LaunchAgent loaded: ${launchAgentPath(config)}${launchAgent.detail ? ` (${launchAgent.detail})` : ""}`
          : `direct/background LaunchAgent not loaded: ${launchAgentPath(config)}${launchAgent.detail ? ` (launchctl: ${launchAgent.detail})` : ""}; run relaymux restart-launch-agent; logs ${logDir}/daemon.out.log and ${logDir}/daemon.err.log; inspect launchctl print ${launchAgent.target}`
        : `direct/background LaunchAgent unsupported on ${process.platform}: ${launchAgentPath(config)}`
      : "disabled in config",
  });

  const watchdog: any = getLaunchAgentWatchdogStatus(config);
  if (daemonEnabled && watchdog.enabled) {
    checks.push({
      name: "background-watchdog",
      ok: !watchdog.supported || watchdog.loaded,
      fatal: false,
      detail: watchdog.supported
        ? `watchdog LaunchAgent ${watchdog.loaded ? "loaded" : "not loaded"}: ${launchAgentWatchdogPath(config)}; interval ${watchdog.intervalSeconds}s`
        : `watchdog LaunchAgent unsupported on ${process.platform}: ${launchAgentWatchdogPath(config)}`,
    });
  }

  for (const [name, agent] of Object.entries((config.agents ?? {}) as Record<string, any>)) {
    const command = Array.isArray(agent.command) ? agent.command[0] : "";
    const executable = findExecutable(command, env);
    checks.push({
      name: `agent:${name}`,
      ok: Boolean(executable),
      fatal: false,
      detail: executable || `${command || "missing command"} not found on PATH`,
    });

    const findings = validateConfiguredAgentCommand(name, agent, { location: `agents.${name}` });
    if (findings.length === 0) {
      checks.push({
        name: `agent:${name}-command`,
        ok: true,
        detail: "command template passed static checks",
      });
    } else {
      for (const finding of findings) {
        checks.push({
          name: `agent:${name}-command`,
          ok: false,
          severity: finding.severity,
          fatal: finding.fatal,
          detail: finding.detail,
        });
      }
    }
  }

  return checks;
}

function commandCheck(name, command, env) {
  const executable = findExecutable(command, env);
  return {
    name,
    ok: Boolean(executable),
    detail: executable || `${command || "missing command"} not found on PATH`,
  };
}

function telegramTokenCheck(telegram, env) {
  const tokenEnv = String(telegram.botTokenEnv || "").trim();
  if (tokenEnv && env[tokenEnv]) {
    return { name: "telegram-token", ok: true, detail: `env ${tokenEnv} is set` };
  }

  const tokenFile = String(telegram.botTokenFile || "").trim();
  if (tokenFile) {
    const file = expandHome(tokenFile, env);
    try {
      const stat = fs.statSync(file);
      const mode = stat.mode & 0o777;
      const hasToken = Boolean(fs.readFileSync(file, "utf8").trim());
      return {
        name: "telegram-token",
        ok: stat.isFile() && hasToken && (mode & 0o077) === 0,
        detail: `${file} mode 0${mode.toString(8)}${hasToken ? "" : " (empty)"}`,
      };
    } catch {
      return { name: "telegram-token", ok: false, detail: `token file missing: ${file}` };
    }
  }

  return {
    name: "telegram-token",
    ok: false,
    detail: tokenEnv ? `env ${tokenEnv} is not set` : "missing botTokenEnv or botTokenFile",
  };
}

function expandHome(value, env) {
  const text = String(value || "");
  const home = env.HOME || process.env.HOME || os.homedir();
  if (text === "~") return home;
  if (text.startsWith("~/")) return path.join(home, text.slice(2));
  return text;
}
