import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandPath, ensureDirectory } from "./paths.js";
import { runCommand } from "./process.js";
import { killWindowByName, validateSessionName } from "./tmux.js";

export function launchAgentPath(config) {
  const label = launchAgentLabel(config);
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchAgentLabel(config) {
  return config.daemon?.launchAgentLabel || "com.relaymux.daemon";
}

export function renderLaunchAgentPlist({ label, programArguments, workingDirectory, standardOutPath, standardErrorPath, environment = {}, keepAlive = true }) {
  const args = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  const env = renderEnvironment(environment);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>${env}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  ${keepAlive ? "<true/>" : "<false/>"}
  <key>StandardOutPath</key>
  <string>${xmlEscape(standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(standardErrorPath)}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent({ flags, configInfo, binPath, io }) {
  if (!configInfo.exists) {
    throw new Error(`Config does not exist at ${configInfo.path}. Run relaymux init first.`);
  }

  const config = configInfo.config;
  const label = launchAgentLabel(config);
  const plistPath = launchAgentPath(config);
  const logDir = expandPath(config.daemon?.logDir || "~/.local/state/relaymux/logs");
  const workingDirectory = expandPath(config.orchestrator?.cwd || "~");
  const launchMode = resolveLaunchMode(flags, config);
  const session = String(flags.session || config.session || "agents");
  if ((config.daemon?.launchMode === "tmux" || config.daemon?.launchMode === "supervised-tmux") && !flags.mode && !flags.launchMode) {
    io.stderr.write("relaymux: daemon.launchMode=tmux is deprecated; installing direct/background LaunchAgent instead.\n");
  }
  const programArguments = buildDirectDaemonArgs({ binPath, configPath: configInfo.path });
  const logPrefix = "daemon";
  const plist = renderLaunchAgentPlist({
    label,
    programArguments,
    workingDirectory,
    environment: launchAgentEnvironment(config, configInfo.path),
    standardOutPath: path.join(logDir, `${logPrefix}.out.log`),
    standardErrorPath: path.join(logDir, `${logPrefix}.err.log`),
  });

  if (flags.dryRun) {
    io.stdout.write(plist);
    return plistPath;
  }

  ensureDirectory(path.dirname(plistPath));
  ensureDirectory(logDir);
  fs.writeFileSync(plistPath, plist, { mode: 0o644 });
  io.stdout.write(`Wrote ${plistPath}\n`);
  io.stdout.write(`LaunchAgent ${label} mode: ${launchMode}/background (no tmux)\n`);

  if (flags.load !== false) {
    const target = launchAgentTarget(config);
    runCommand("launchctl", ["bootout", target], { allowFailure: true });
    if (process.platform === "darwin" && launchMode === "direct" && flags.keepTmuxDaemon !== true) {
      const windowName = String(flags.windowName || "relaymux-daemon");
      try {
        validateSessionName(session);
        if (killWindowByName({ session, name: windowName })) {
          io.stdout.write(`Stopped tmux daemon window ${session}:${windowName}\n`);
        }
      } catch (error) {
        io.stderr.write(`relaymux: skipped old tmux daemon cleanup: ${error.message}\n`);
      }
    }
    runCommand("launchctl", ["enable", target], { allowFailure: true });
    const result = runCommand("launchctl", ["bootstrap", launchAgentDomain(), plistPath], { allowFailure: true });
    if (result.status !== 0) {
      io.stderr.write(`launchctl bootstrap did not complete (${result.status}); you can load manually with launchctl bootstrap ${launchAgentDomain()} ${plistPath}\n`);
    } else {
      runCommand("launchctl", ["kickstart", "-k", target], { allowFailure: true });
    }
  }
  return plistPath;
}

export function stopLaunchAgent({ config, io }) {
  if (process.platform !== "darwin") {
    return false;
  }

  const label = launchAgentLabel(config);
  const result = runCommand("launchctl", ["bootout", launchAgentTarget(config)], { allowFailure: true });
  if (result.status === 0) {
    io.stdout.write(`Stopped LaunchAgent ${label}\n`);
    return true;
  }
  return false;
}

export function restartLaunchAgent({ flags, configInfo, binPath, io }) {
  const plistPath = installLaunchAgent({
    flags: { ...flags, load: true },
    configInfo,
    binPath,
    io,
  });
  printLaunchAgentStatus({ config: configInfo.config, io });
  return plistPath;
}

export function printLaunchAgentStatus({ config, io, json = false }) {
  const status: any = getLaunchAgentStatus(config);
  if (json) {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status;
  }

  if (!status.supported) {
    io.stdout.write(`LaunchAgent ${status.label}: direct/background (no tmux) unsupported on ${process.platform}; plist ${status.plistPath}\n`);
    return status;
  }

  if (!status.loaded) {
    io.stdout.write(`LaunchAgent ${status.label}: direct/background (no tmux) not loaded; plist ${status.plistExists ? status.plistPath : "missing"}\n`);
    if (status.detail) io.stdout.write(`Detail: ${status.detail}\n`);
    return status;
  }

  const pidText = status.pid ? ` pid=${status.pid}` : "";
  const exitText = status.lastExitCode ? ` lastExit=${status.lastExitCode}` : "";
  io.stdout.write(`LaunchAgent ${status.label}: direct/background (no tmux) loaded state=${status.state || "unknown"}${pidText}${exitText}; plist ${status.plistPath}\n`);
  return status;
}

export function getLaunchAgentStatus(config) {
  const label = launchAgentLabel(config);
  const plistPath = launchAgentPath(config);
  const plistExists = fs.existsSync(plistPath);
  const target = launchAgentTarget(config);
  const base = { label, plistPath, plistExists, target, supported: process.platform === "darwin", mode: "direct", background: true };
  if (!base.supported) {
    return { ...base, loaded: false, running: false, state: "unsupported" };
  }

  const result = runCommand("launchctl", ["print", target], { allowFailure: true });
  if (result.status !== 0) {
    return {
      ...base,
      loaded: false,
      running: false,
      state: "not-loaded",
      detail: firstLine(result.stderr) || firstLine(result.stdout),
    };
  }

  const parsed = parseLaunchCtlPrint(result.stdout);
  return {
    ...base,
    loaded: true,
    running: Boolean(parsed.pid),
    ...parsed,
  };
}

export function uninstallLaunchAgent({ config, io }) {
  const plistPath = launchAgentPath(config);
  if (fs.existsSync(plistPath)) {
    runCommand("launchctl", ["bootout", launchAgentTarget(config)], { allowFailure: true });
    fs.unlinkSync(plistPath);
    io.stdout.write(`Removed ${plistPath}\n`);
  } else {
    io.stdout.write(`No LaunchAgent found at ${plistPath}\n`);
  }
  return plistPath;
}

export function launchAgentDomain() {
  return `gui/${process.getuid?.() || 501}`;
}

export function launchAgentTarget(config) {
  return `${launchAgentDomain()}/${launchAgentLabel(config)}`;
}

function buildDirectDaemonArgs({ binPath, configPath }) {
  return [process.execPath, binPath, "--config", configPath, "daemon"];
}

function resolveLaunchMode(flags, config) {
  const explicitMode = flags.mode || flags.launchMode;
  const rawMode = String(explicitMode || config.daemon?.launchMode || "direct");
  const mode = rawMode === "background" ? "direct" : rawMode;
  if (explicitMode && !["direct", "background"].includes(String(explicitMode))) {
    throw new Error("LaunchAgent tmux mode has been removed. The background iMessage/orchestrator service must run direct; use start-tmux only for legacy manual debugging.");
  }
  if (["direct", "tmux", "supervised-tmux"].includes(mode)) {
    return "direct";
  }
  throw new Error(`Unknown daemon.launchMode "${rawMode}". Use "direct".`);
}

function launchAgentEnvironment(config, configPath) {
  const environment: Record<string, string> = {
    PATH: defaultLaunchPath(),
    HOME: os.homedir(),
    RELAYMUX_CONFIG: configPath,
    ...(config.daemon?.environment || {}),
  };

  for (const key of Object.keys(environment)) {
    if (key === "RELAYMUX_SESSION" || key.startsWith("TMUX")) {
      delete environment[key];
    }
  }
  return environment;
}

function defaultLaunchPath() {
  const pathParts = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return pathParts.join(":");
}

function renderEnvironment(environment) {
  const entries = Object.entries(environment || {}).filter(([key, value]) => key && value !== undefined && value !== null);
  if (!entries.length) return "";

  const body = entries
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `\n  <key>EnvironmentVariables</key>\n  <dict>\n${body}\n  </dict>`;
}

export function parseLaunchCtlPrint(output) {
  const pidMatch = /^\s*pid = (\d+)\s*$/m.exec(output);
  const stateMatch = /^\s*state = (.+?)\s*$/m.exec(output);
  const lastExitMatch = /^\s*last exit code = (.+?)\s*$/m.exec(output);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state: stateMatch ? stateMatch[1] : (pidMatch ? "running" : "loaded"),
    lastExitCode: lastExitMatch ? lastExitMatch[1] : "",
  };
}

function firstLine(value) {
  return String(value || "").trim().split(/\r?\n/)[0] || "";
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
