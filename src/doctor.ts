import fs from "node:fs";
import path from "node:path";

import { defaultConfigPath, legacyDefaultConfigPath, resolveLogDir, resolveStateDir } from "./config.js";
import { validateConfiguredAgentCommand } from "./command-validation.js";
import { runCommand } from "./process.js";
import { getLaunchAgentStatus, launchAgentPath } from "./launch-agent.js";
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
  if (config.imessage?.receive?.backend === "command") {
    checks.push(commandCheck("message-receive", config.imessage.receive.command?.argv?.[0], env));
  }
  if (config.imessage?.send?.backend === "command") {
    checks.push(commandCheck("message-send", config.imessage.send.command?.argv?.[0], env));
  }

  const webhook = webhookStatus(config);
  checks.push({
    name: "webhook-token",
    ok: !webhook.tokenFileExists || webhook.tokenFileMode === "0600",
    detail: webhook.tokenFileExists ? `${webhook.tokenFile} mode ${webhook.tokenFileMode}` : `will be created at ${webhook.tokenFile}`,
  });
  const launchAgent: any = getLaunchAgentStatus(config);
  const daemonEnabled = config.daemon?.enabled !== false;
  checks.push({
    name: "background-service",
    ok: !daemonEnabled || !launchAgent.supported || launchAgent.loaded,
    detail: daemonEnabled
      ? launchAgent.supported
        ? `direct/background LaunchAgent ${launchAgent.loaded ? "loaded" : "not loaded"}: ${launchAgentPath(config)}${launchAgent.detail ? ` (${launchAgent.detail})` : ""}`
        : `direct/background LaunchAgent unsupported on ${process.platform}: ${launchAgentPath(config)}`
      : "disabled in config",
  });

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
