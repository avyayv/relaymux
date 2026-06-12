import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandPath, ensureDirectory } from "./paths.js";
import { runCommand } from "./process.js";
import { validateSessionName } from "./tmux.js";

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
  const launchMode = flags.mode || config.daemon?.launchMode || "tmux";
  const session = flags.session || config.session || "agents";
  const programArguments = launchMode === "direct"
    ? [process.execPath, binPath, "--config", configInfo.path, "daemon"]
    : launchMode === "tmux"
      ? buildTmuxSupervisorArgs({ binPath, configPath: configInfo.path, session })
      : null;
  if (!programArguments) {
    throw new Error(`Unknown daemon.launchMode "${launchMode}". Use "tmux" or "direct".`);
  }
  const logPrefix = launchMode === "direct" ? "daemon" : "supervisor";
  const plist = renderLaunchAgentPlist({
    label,
    programArguments,
    workingDirectory,
    environment: launchAgentEnvironment(config, configInfo.path, String(session)),
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

  if (flags.load !== false) {
    const domain = `gui/${process.getuid?.() || 501}`;
    runCommand("launchctl", ["bootout", `${domain}/${label}`], { allowFailure: true });
    runCommand("launchctl", ["enable", `${domain}/${label}`], { allowFailure: true });
    const result = runCommand("launchctl", ["bootstrap", domain, plistPath], { allowFailure: true });
    if (result.status !== 0) {
      io.stderr.write(`launchctl bootstrap did not complete (${result.status}); you can load manually with launchctl bootstrap gui/$(id -u) ${plistPath}\n`);
    } else {
      runCommand("launchctl", ["kickstart", "-k", `${domain}/${label}`], { allowFailure: true });
    }
  }
  return plistPath;
}

export function stopLaunchAgent({ config, io }) {
  if (process.platform !== "darwin") {
    return false;
  }

  const label = launchAgentLabel(config);
  const target = `gui/${process.getuid?.() || 501}/${label}`;
  const result = runCommand("launchctl", ["bootout", target], { allowFailure: true });
  if (result.status === 0) {
    io.stdout.write(`Stopped LaunchAgent ${label}\n`);
    return true;
  }
  return false;
}

export function uninstallLaunchAgent({ config, io }) {
  const plistPath = launchAgentPath(config);
  if (fs.existsSync(plistPath)) {
    runCommand("launchctl", ["bootout", `gui/${process.getuid?.() || 501}`, plistPath], { allowFailure: true });
    fs.unlinkSync(plistPath);
    io.stdout.write(`Removed ${plistPath}\n`);
  } else {
    io.stdout.write(`No LaunchAgent found at ${plistPath}\n`);
  }
  return plistPath;
}

function buildTmuxSupervisorArgs({ binPath, configPath, session }) {
  validateSessionName(String(session));
  return [process.execPath, binPath, "--config", configPath, "supervise-tmux", "--session", String(session)];
}

function launchAgentEnvironment(config, configPath, session) {
  return {
    PATH: defaultLaunchPath(),
    HOME: os.homedir(),
    TMUX_TMPDIR: "/private/tmp",
    RELAYMUX_CONFIG: configPath,
    RELAYMUX_SESSION: session,
    ...(config.daemon?.environment || {}),
  };
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

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
