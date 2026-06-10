import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandPath, ensureDirectory } from "./paths.js";
import { runCommand } from "./process.js";

export function launchAgentPath(config) {
  const label = launchAgentLabel(config);
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchAgentLabel(config) {
  return config.daemon?.launchAgentLabel || "com.agentmux.daemon";
}

export function renderLaunchAgentPlist({ label, programArguments, workingDirectory, standardOutPath, standardErrorPath }) {
  const args = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
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
  <string>${xmlEscape(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
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
    throw new Error(`Config does not exist at ${configInfo.path}. Run agentmux init first.`);
  }

  const config = configInfo.config;
  const label = launchAgentLabel(config);
  const plistPath = launchAgentPath(config);
  const logDir = expandPath(config.daemon?.logDir || "~/.local/state/agentmux/logs");
  const workingDirectory = expandPath(config.orchestrator?.cwd || "~");
  const programArguments = [process.execPath, binPath, "--config", configInfo.path, "daemon"];
  const plist = renderLaunchAgentPlist({
    label,
    programArguments,
    workingDirectory,
    standardOutPath: path.join(logDir, "daemon.out.log"),
    standardErrorPath: path.join(logDir, "daemon.err.log"),
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
    const result = runCommand("launchctl", ["bootstrap", `gui/${process.getuid?.() || 501}`, plistPath], { allowFailure: true });
    if (result.status !== 0) {
      io.stderr.write(`launchctl bootstrap did not complete (${result.status}); you can load manually with launchctl bootstrap gui/$(id -u) ${plistPath}\n`);
    }
  }
  return plistPath;
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

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
