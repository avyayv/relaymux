import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveLogDir } from "./config.js";
import { quoteArgv } from "./command.js";
import { expandPath, ensureDirectory } from "./paths.js";
import { runCommand } from "./process.js";
import { killWindowByName, validateSessionName } from "./tmux.js";

export function launchAgentPath(config) {
  const label = launchAgentLabel(config);
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchAgentWatchdogPath(config) {
  const label = launchAgentWatchdogLabel(config);
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchAgentLabel(config) {
  return config.daemon?.launchAgentLabel || "com.relaymux.daemon";
}

export function launchAgentWatchdogLabel(config) {
  return `${launchAgentLabel(config)}.watchdog`;
}

export function renderLaunchAgentPlist({ label, programArguments, workingDirectory, standardOutPath, standardErrorPath, environment = {}, keepAlive = true, startInterval = 0 }) {
  const args = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  const env = renderEnvironment(environment);
  const interval = renderStartInterval(startInterval);
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
  ${keepAlive ? "<true/>" : "<false/>"}${interval}
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
  const logDir = resolveLogDir(config);
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

  if (shouldInstallWatchdog(config, flags)) {
    installLaunchAgentWatchdog({
      config,
      configPath: configInfo.path,
      binPath,
      io,
      load: flags.load !== false,
    });
  }

  if (flags.load !== false) {
    const target = launchAgentTarget(config);
    if (process.platform === "darwin" && isCurrentLaunchAgent(config, process.env) && flags.immediateSelfRestart !== true) {
      scheduleLaunchAgentReloadHelper({ config, plistPath, io });
      return plistPath;
    }

    runCommand("launchctl", ["bootout", target], { allowFailure: true });
    runCommand("/bin/sleep", ["1"], { allowFailure: true });
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
    const result = loadLaunchAgentTarget({ target, domain: launchAgentDomain(), plistPath });
    if (result.status !== 0) {
      io.stderr.write(`launchctl bootstrap did not complete (${result.status}); watchdog will retry, or load manually with launchctl bootstrap ${launchAgentDomain()} ${plistPath}\n`);
    }
  }
  return plistPath;
}

export function installLaunchAgentWatchdog({ config, configPath, binPath, io, load = true }) {
  if (process.platform !== "darwin") {
    return null;
  }

  const scriptPath = launchAgentWatchdogScriptPath(config);
  const plistPath = launchAgentWatchdogPath(config);
  const logDir = resolveLogDir(config);
  const scriptSourcePath = resolveWatchdogSourcePath(binPath);
  const script = fs.readFileSync(scriptSourcePath, "utf8");
  ensureDirectory(path.dirname(scriptPath));
  ensureDirectory(path.dirname(plistPath));
  ensureDirectory(logDir);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  try { fs.chmodSync(scriptPath, 0o755); } catch {}

  const plist = renderLaunchAgentWatchdogPlist({ config, configPath, scriptPath });
  fs.writeFileSync(plistPath, plist, { mode: 0o644 });
  io.stdout.write(`Wrote ${plistPath}\n`);

  if (load) {
    const target = launchAgentWatchdogTarget(config);
    const result = loadLaunchAgentTarget({ target, domain: launchAgentDomain(), plistPath });
    if (result.status !== 0) {
      io.stderr.write(`watchdog bootstrap did not complete (${result.status}); you can load manually with launchctl bootstrap ${launchAgentDomain()} ${plistPath}\n`);
    }
  }

  return { plistPath, scriptPath };
}

export function renderLaunchAgentWatchdogPlist({ config, configPath, scriptPath }) {
  const logDir = resolveLogDir(config);
  const label = launchAgentWatchdogLabel(config);
  return renderLaunchAgentPlist({
    label,
    programArguments: ["/bin/sh", scriptPath],
    workingDirectory: os.homedir(),
    environment: {
      PATH: defaultLaunchPath(),
      HOME: os.homedir(),
      RELAYMUX_CONFIG: configPath,
      RELAYMUX_MAIN_LABEL: launchAgentLabel(config),
      RELAYMUX_MAIN_PLIST: launchAgentPath(config),
      RELAYMUX_HEALTH_URL: launchAgentHealthUrl(config),
      RELAYMUX_WATCHDOG_LOG: path.join(logDir, "launch-agent-watchdog.log"),
    },
    standardOutPath: path.join(logDir, "launch-agent-watchdog.out.log"),
    standardErrorPath: path.join(logDir, "launch-agent-watchdog.err.log"),
    keepAlive: false,
    startInterval: launchAgentWatchdogIntervalSeconds(config),
  });
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
  const watchdog: any = getLaunchAgentWatchdogStatus(config);
  if (json) {
    const payload = { ...status, watchdog };
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
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
  if (watchdog.enabled) {
    const watchdogText = watchdog.loaded
      ? `loaded state=${watchdog.state || "unknown"}${watchdog.pid ? ` pid=${watchdog.pid}` : ""}`
      : `not loaded${watchdog.detail ? ` (${watchdog.detail})` : ""}`;
    io.stdout.write(`Watchdog ${watchdog.label}: interval=${watchdog.intervalSeconds}s ${watchdogText}; plist ${watchdog.plistPath}; script ${watchdog.scriptPath}\n`);
  }
  return status;
}

export function getLaunchAgentStatus(config) {
  return getLaunchAgentStatusFor({
    label: launchAgentLabel(config),
    plistPath: launchAgentPath(config),
    target: launchAgentTarget(config),
  });
}

export function getLaunchAgentWatchdogStatus(config) {
  return {
    ...getLaunchAgentStatusFor({
      label: launchAgentWatchdogLabel(config),
      plistPath: launchAgentWatchdogPath(config),
      target: launchAgentWatchdogTarget(config),
    }),
    enabled: shouldInstallWatchdog(config, {}),
    intervalSeconds: launchAgentWatchdogIntervalSeconds(config),
    scriptPath: launchAgentWatchdogScriptPath(config),
  };
}

function getLaunchAgentStatusFor({ label, plistPath, target }) {
  const plistExists = fs.existsSync(plistPath);
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
  const watchdogPlistPath = launchAgentWatchdogPath(config);
  if (fs.existsSync(watchdogPlistPath)) {
    runCommand("launchctl", ["bootout", launchAgentWatchdogTarget(config)], { allowFailure: true });
    fs.unlinkSync(watchdogPlistPath);
    io.stdout.write(`Removed ${watchdogPlistPath}\n`);
  }

  const watchdogScriptPath = launchAgentWatchdogScriptPath(config);
  if (fs.existsSync(watchdogScriptPath)) {
    fs.unlinkSync(watchdogScriptPath);
    io.stdout.write(`Removed ${watchdogScriptPath}\n`);
  }

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

export function isCurrentLaunchAgent(config, env = process.env) {
  const label = launchAgentLabel(config);
  return env.XPC_SERVICE_NAME === label || env.LAUNCHD_JOB_LABEL === label;
}

export function scheduleLaunchAgentReloadHelper({ config, plistPath, io }) {
  const mainLabel = launchAgentLabel(config);
  const helperLabel = `${mainLabel}.reload.${process.pid}.${Date.now()}`;
  const helperPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${helperLabel}.plist`);
  const logDir = resolveLogDir(config);
  const scriptPath = path.join(logDir, `${helperLabel}.sh`);
  const logPath = path.join(logDir, "launch-agent-reload.log");
  const domain = launchAgentDomain();
  const target = launchAgentTarget(config);
  const helperTarget = `${domain}/${helperLabel}`;
  const delaySeconds = Math.max(1, Math.ceil(Number(config.daemon?.selfRestartDelayMs || 30000) / 1000));

  ensureDirectory(path.dirname(helperPlistPath));
  ensureDirectory(logDir);
  fs.writeFileSync(scriptPath, renderLaunchAgentReloadScript({
    delaySeconds,
    domain,
    helperPlistPath,
    helperTarget,
    plistPath,
    scriptPath,
    target,
  }), { mode: 0o700 });
  try { fs.chmodSync(scriptPath, 0o700); } catch {}

  const helperPlist = renderLaunchAgentPlist({
    label: helperLabel,
    programArguments: ["/bin/sh", scriptPath],
    workingDirectory: os.homedir(),
    environment: {
      PATH: defaultLaunchPath(),
      HOME: os.homedir(),
    },
    standardOutPath: logPath,
    standardErrorPath: logPath,
    keepAlive: false,
  });
  fs.writeFileSync(helperPlistPath, helperPlist, { mode: 0o644 });

  runCommand("launchctl", ["bootout", helperTarget], { allowFailure: true });
  const result = runCommand("launchctl", ["bootstrap", domain, helperPlistPath], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`Could not schedule LaunchAgent reload helper (${result.status}): ${firstLine(result.stderr) || firstLine(result.stdout)}`);
  }
  runCommand("launchctl", ["kickstart", "-k", helperTarget], { allowFailure: true });
  io.stdout.write(`Scheduled LaunchAgent reload helper ${helperLabel} in ${delaySeconds}s; log ${logPath}\n`);
  return helperPlistPath;
}

export function renderLaunchAgentReloadScript({ delaySeconds, domain, helperPlistPath, helperTarget, plistPath, scriptPath, target }) {
  return [
    "#!/bin/sh",
    "set -u",
    `sleep ${Math.max(1, Number(delaySeconds) || 1)}`,
    `printf '[%s] reloading %s from %s\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" ${quoteArgv([target])} ${quoteArgv([plistPath])}`,
    `${quoteArgv(["launchctl", "bootout", target])} >/dev/null 2>&1 || true`,
    "sleep 1",
    `${quoteArgv(["launchctl", "enable", target])} >/dev/null 2>&1 || true`,
    `if ${quoteArgv(["launchctl", "bootstrap", domain, plistPath])}; then`,
    `  ${quoteArgv(["launchctl", "kickstart", "-k", target])} >/dev/null 2>&1 || true`,
    `  ${quoteArgv(["launchctl", "print", target])} || true`,
    "else",
    "  status=$?",
    "  echo \"bootstrap failed with status $status\"",
    `  ${quoteArgv(["launchctl", "print", target])} || true`,
    "  exit \"$status\"",
    "fi",
    `${quoteArgv(["rm", "-f", helperPlistPath, scriptPath])} || true`,
    `${quoteArgv(["launchctl", "bootout", helperTarget])} >/dev/null 2>&1 || true`,
  ].join("\n") + "\n";
}

export function launchAgentDomain() {
  return `gui/${process.getuid?.() || 501}`;
}

export function launchAgentTarget(config) {
  return `${launchAgentDomain()}/${launchAgentLabel(config)}`;
}

export function launchAgentWatchdogTarget(config) {
  return `${launchAgentDomain()}/${launchAgentWatchdogLabel(config)}`;
}

export function shouldInstallWatchdog(config, flags: any = {}) {
  if (flags.watchdog === false) return false;
  if (config.daemon?.enabled === false) return false;
  if (config.daemon?.watchdog?.enabled === false) return false;
  return true;
}

export function launchAgentWatchdogScriptPath(config) {
  const logDir = resolveLogDir(config);
  const relaymuxHome = path.dirname(logDir);
  return path.join(relaymuxHome, "bin", `${launchAgentLabel(config)}-watchdog.sh`);
}

export function launchAgentWatchdogIntervalSeconds(config) {
  const raw = config.daemon?.watchdog?.intervalSeconds ?? config.daemon?.watchdogIntervalSeconds ?? 60;
  const interval = Number(raw);
  if (!Number.isFinite(interval) || interval <= 0) return 60;
  return Math.max(15, Math.floor(interval));
}

export function resolveWatchdogSourcePath(binPath) {
  const candidates = [
    path.resolve(path.dirname(binPath || ""), "..", "..", "scripts", "relaymux-launch-agent-watchdog.sh"),
    path.resolve(process.cwd(), "scripts", "relaymux-launch-agent-watchdog.sh"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find relaymux watchdog script. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

function buildDirectDaemonArgs({ binPath, configPath }) {
  return [stableNodePath(), binPath, "--config", configPath, "daemon"];
}

function loadLaunchAgentTarget({ target, domain, plistPath }) {
  let result: any = { status: 1, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    runCommand("launchctl", ["enable", target], { allowFailure: true });
    result = runCommand("launchctl", ["bootstrap", domain, plistPath], { allowFailure: true });
    if (result.status === 0) {
      runCommand("launchctl", ["kickstart", "-k", target], { allowFailure: true });
      return result;
    }
    runCommand("launchctl", ["bootout", target], { allowFailure: true });
    runCommand("/bin/sleep", [String(attempt)], { allowFailure: true });
  }
  return result;
}

function stableNodePath() {
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return process.execPath;
}

function launchAgentHealthUrl(config) {
  const host = formatHostForUrl(config.daemon?.host || "127.0.0.1");
  const port = Number(config.daemon?.port || 47761);
  return `http://${host}:${port}/health`;
}

function formatHostForUrl(host) {
  const value = String(host || "").trim();
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function resolveLaunchMode(flags, config) {
  const explicitMode = flags.mode || flags.launchMode;
  const rawMode = String(explicitMode || config.daemon?.launchMode || "direct");
  const mode = rawMode === "background" ? "direct" : rawMode;
  if (explicitMode && !["direct", "background"].includes(String(explicitMode))) {
    throw new Error("LaunchAgent tmux mode has been removed. The relaymux background service must run direct; use start-tmux only for legacy manual debugging.");
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

function renderStartInterval(startInterval) {
  const interval = Number(startInterval || 0);
  if (!Number.isFinite(interval) || interval <= 0) return "";
  return `\n  <key>StartInterval</key>\n  <integer>${Math.floor(interval)}</integer>`;
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
