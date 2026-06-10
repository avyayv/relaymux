import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.js";

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
    name: "tmux",
    ok: Boolean(tmuxPath),
    detail: tmuxPath ? `${tmuxPath}${tmuxVersion ? ` (${tmuxVersion})` : ""}` : "not found on PATH",
  });

  checks.push({
    name: "config",
    ok: configInfo.exists,
    detail: configInfo.exists ? configInfo.path : `not initialized (${configInfo.path})`,
  });

  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    const command = Array.isArray(agent.command) ? agent.command[0] : "";
    const executable = findExecutable(command, env);
    checks.push({
      name: `agent:${name}`,
      ok: Boolean(executable),
      detail: executable || `${command || "missing command"} not found on PATH`,
    });
  }

  return checks;
}
