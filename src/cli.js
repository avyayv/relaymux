import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseArgv } from "./args.js";
import { buildAgentInvocation, buildTmuxShellCommand, buildTmuxShellScript, quoteArgv } from "./command.js";
import { collectDoctorChecks } from "./doctor.js";
import { defaultConfigPath, loadConfig, resolveStateDir, writeDefaultConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { installLaunchAgent, launchAgentPath, uninstallLaunchAgent } from "./launch-agent.js";
import { handleNotify } from "./notify.js";
import { webhookStatus } from "./webhook.js";
import { expandPath, ensureDirectory, pathExists, readTextFile } from "./paths.js";
import { latestEventsByRun, readRuns, recordRun, writePromptFile, writeScriptFile } from "./state.js";
import { createAgentWindow, listAgentWindows, sendShellCommand, setWindowMetadata, validateSessionName } from "./tmux.js";
import { createWorktree, resolveRepoAndWorkdir } from "./worktree.js";

export async function main(argv, io = defaultIo()) {
  try {
    const parsed = parseArgv(argv);
    if (parsed.flags.help || parsed.command === "help") {
      io.stdout.write(helpText());
      return 0;
    }
    if (parsed.flags.version || parsed.command === "version") {
      io.stdout.write("agentmux 0.1.0\n");
      return 0;
    }

    if (parsed.command === "init") {
      return handleInit(parsed.flags, io);
    }

    const configInfo = loadConfig({ configPath: parsed.flags.config, env: io.env });
    const stateDir = resolveStateDir(configInfo.config);

    switch (parsed.command) {
      case "launch":
        return handleLaunch(parsed.flags, configInfo, stateDir, io);
      case "status":
        return handleStatus(parsed.flags, configInfo, stateDir, io);
      case "notify":
        await handleNotify({
          flags: parsed.flags,
          positionals: parsed.positionals,
          config: configInfo.config,
          stateDir,
          io,
        });
        return 0;
      case "daemon":
        return runDaemon({ flags: parsed.flags, configInfo, stateDir, io });
      case "install-launch-agent":
        installLaunchAgent({ flags: parsed.flags, configInfo, binPath: process.argv[1], io });
        return 0;
      case "uninstall-launch-agent":
        uninstallLaunchAgent({ config: configInfo.config, io });
        return 0;
      case "doctor":
        return handleDoctor(configInfo, io);
      default:
        throw new Error(`Unknown command "${parsed.command}"`);
    }
  } catch (error) {
    io.stderr.write(`agentmux: ${error.message}\n`);
    return 1;
  }
}

function handleInit(flags, io) {
  const target = writeDefaultConfig(flags.config || defaultConfigPath(io.env), { force: Boolean(flags.force) });
  io.stdout.write(`Created ${target}\n`);
  return 0;
}

function handleLaunch(flags, configInfo, stateDir, io) {
  const config = configInfo.config;
  const agentName = flags.agent;
  if (!agentName) {
    throw new Error("Missing --agent <name>");
  }
  const agentConfig = config.agents?.[agentName];
  if (!agentConfig) {
    throw new Error(`Unknown agent "${agentName}". Add it to your config under agents.`);
  }

  const prompt = resolvePrompt(flags);
  const runId = flags.runId || makeRunId();
  const session = flags.session || config.session || "agents";
  validateSessionName(session);

  const { repo, workdir, worktreeAddArgs } = resolveRepoAndWorkdir(flags);
  const name = sanitizeName(flags.name || `${agentName}-${path.basename(workdir)}-${runId.slice(-6)}`);
  const holdOnExit = flags.hold ?? config.holdOnExit ?? false;

  if (flags.dryRun) {
    const promptFile = path.join(stateDir, "prompts", `${runId}.txt`);
    const scriptFile = path.join(stateDir, "scripts", `${runId}.sh`);
    const script = buildLaunchShellScript(agentName, agentConfig, {
      agent: agentName,
      cliPath: process.argv[1],
      configPath: configInfo.path,
      holdOnExit,
      name,
      prompt,
      promptFile,
      repo,
      runId,
      workdir,
    });
    const shellCommand = buildTmuxShellCommand(scriptFile);
    if (worktreeAddArgs) {
      io.stdout.write(`worktree: ${quoteArgv(["git", ...worktreeAddArgs])}\n`);
    }
    io.stdout.write(`${shellCommand}\n`);
    io.stdout.write("\n# wrapper script\n");
    io.stdout.write(`${script}\n`);
    return 0;
  }

  if (worktreeAddArgs) {
    createWorktree(worktreeAddArgs);
  }

  ensureDirectory(stateDir);
  const promptFile = writePromptFile(stateDir, runId, prompt);
  const script = buildLaunchShellScript(agentName, agentConfig, {
    agent: agentName,
    cliPath: process.argv[1],
    configPath: configInfo.path,
    holdOnExit,
    name,
    prompt,
    promptFile,
    repo,
    runId,
    workdir,
  });
  const scriptFile = writeScriptFile(stateDir, runId, script);
  const shellCommand = buildTmuxShellCommand(scriptFile);

  if (flags.printCommand) {
    io.stdout.write(`${shellCommand}\n`);
  }

  const target = createAgentWindow({
    session,
    name,
    cwd: workdir,
  });

  const started = new Date().toISOString();
  setWindowMetadata(target.windowTarget, {
    agentmux: "1",
    agentmux_agent: agentName,
    agentmux_name: name,
    agentmux_repo: repo,
    agentmux_run_id: runId,
    agentmux_started: started,
  });
  sendShellCommand(target.target, shellCommand);

  recordRun(stateDir, {
    time: started,
    runId,
    session,
    target: target.target,
    windowTarget: target.windowTarget,
    name,
    agent: agentName,
    repo,
    workdir,
    promptFile,
    scriptFile,
    command: shellCommand,
  });

  io.stdout.write(`Started ${name} in tmux target ${target.target}\n`);
  io.stdout.write(`Run ID: ${runId}\n`);
  if (flags.attach) {
    io.stdout.write(`Attach with: tmux attach -t ${session}\n`);
  }
  return 0;
}

function buildLaunchShellScript(agentName, agentConfig, context) {
  const invocation = buildAgentInvocation(agentName, agentConfig, context);
  return buildTmuxShellScript(invocation, context);
}

function handleStatus(flags, configInfo, stateDir, io) {
  const config = configInfo.config;
  const session = flags.session || config.session;
  const windows = listAgentWindows({ session: flags.all ? undefined : session });
  const windowsByRunId = new Map(windows.map((window) => [window.runId, window]));
  const latestEvents = latestEventsByRun(stateDir);
  const runs = readRuns(stateDir);

  const rows = runs.map((run) => {
    const window = windowsByRunId.get(run.runId);
    const latestEvent = latestEvents.get(run.runId);
    return statusRow(run, window, latestEvent);
  });

  for (const window of windows) {
    if (!rows.some((row) => row.runId === window.runId)) {
      rows.push(statusRow(window, window, latestEvents.get(window.runId)));
    }
  }

  rows.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  const daemon = daemonStatus(config, configInfo.path);

  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ daemon, runs: rows }, null, 2)}\n`);
    return 0;
  }

  io.stdout.write(`Daemon: ${daemon.enabled ? "enabled" : "disabled"}; webhook ${daemon.webhook.endpoints.message}; token ${daemon.webhook.tokenFileExists ? daemon.webhook.tokenFileMode : "missing"}; LaunchAgent ${daemon.launchAgentPath}\n`);

  if (rows.length === 0) {
    io.stdout.write("No agentmux runs found.\n");
    return 0;
  }

  io.stdout.write(formatTable(rows, ["state", "target", "agent", "name", "repo", "lastEvent"]));
  return 0;
}

function daemonStatus(config, configPath) {
  return {
    enabled: config.daemon?.enabled !== false,
    configPath,
    webhook: webhookStatus(config),
    launchAgentPath: launchAgentPath(config),
  };
}

function statusRow(run, window, latestEvent) {
  const completed = latestEvent?.event === "completed";
  const state = completed
      ? `completed:${latestEvent.exitCode ?? ""}`
      : window
        ? "running"
        : "window-missing";

  return {
    runId: run.runId,
    started: run.time || run.started,
    state,
    target: window?.target || run.windowTarget || run.target || "",
    agent: run.agent || window?.agent || "",
    name: run.name || window?.name || "",
    repo: run.repo || window?.repo || "",
    workdir: run.workdir || window?.cwd || "",
    lastEvent: latestEvent ? `${latestEvent.event}${latestEvent.message ? `: ${latestEvent.message}` : ""}` : "",
  };
}

function handleDoctor(configInfo, io) {
  const checks = collectDoctorChecks(configInfo.config, configInfo, io.env);
  for (const check of checks) {
    io.stdout.write(`${check.ok ? "ok" : "missing"}\t${check.name}\t${check.detail}\n`);
  }
  return checks.every((check) => check.ok || check.name.startsWith("agent:")) ? 0 : 1;
}

function resolvePrompt(flags) {
  if (flags.promptFile) {
    return readTextFile(expandPath(flags.promptFile));
  }
  if (flags.prompt === undefined) {
    throw new Error("Missing --prompt <text|@file> or --prompt-file <path>");
  }

  if (flags.prompt.startsWith("@")) {
    return readTextFile(expandPath(flags.prompt.slice(1)));
  }

  const maybePath = expandPath(flags.prompt);
  if (!flags.prompt.includes("\n") && pathExists(maybePath) && fs.statSync(maybePath).isFile()) {
    return readTextFile(maybePath);
  }

  return flags.prompt;
}

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent";
}

function makeRunId() {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function formatTable(rows, columns) {
  const headers = columns.map((column) => column.toUpperCase());
  const widths = columns.map((column, index) =>
    Math.max(headers[index].length, ...rows.map((row) => String(row[column] ?? "").length)),
  );

  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
  ];

  for (const row of rows) {
    lines.push(columns.map((column, index) => String(row[column] ?? "").padEnd(widths[index])).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

function defaultIo() {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function helpText() {
  return `agentmux - run local coding agents in tmux

Usage:
  agentmux init [--force] [--config <path>]
  agentmux daemon [--once]
  agentmux install-launch-agent [--dry-run] [--no-load]
  agentmux uninstall-launch-agent
  agentmux launch --repo <path> --agent <name> --prompt <text|@file> [--name <name>]
  agentmux status [--json] [--session <name>] [--all]
  agentmux notify [--run-id <id>] [--reply-mode imessage|none] [--message <text>]
  agentmux doctor

Launch options:
  --prompt-file <path>       Read prompt from a file
  --session <name>           Override tmux session
  --worktree <path>          Launch from a generic git worktree path
  --create-worktree          Create --worktree with git worktree add when missing
  --worktree-branch <name>   Branch name to use with --create-worktree
  --worktree-from <ref>      Starting ref to use with --create-worktree
  --dry-run                  Print the tmux shell command without launching
  --print-command            Print the tmux shell command before launching
  --hold                     Keep a shell open after the agent exits
  --attach                   Print attach command after launch

Daemon/notify options:
  --once                     Poll once, drain queued work, then exit (for smoke tests)
  --reply-mode <mode>        For notify: imessage sends a concise chat update; none is quiet context
  --from <name>              For notify: source/subagent name
  --idempotency-key <key>    For notify: suppress duplicate completion webhook retries
  --metadata-json <json>     For notify: optional metadata object

Config defaults to ${defaultConfigPath()}.
`;
}
