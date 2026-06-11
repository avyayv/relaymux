import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseArgv } from "./args.js";
import { buildAgentInvocation, buildTmuxShellCommand, buildTmuxShellScript, quoteArgv, renderTemplate, shellExportBlock } from "./command.js";
import { collectDoctorChecks } from "./doctor.js";
import { defaultConfigPath, loadConfig, resolveStateDir, writeConfig, writeDefaultConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { installLaunchAgent, launchAgentPath, stopLaunchAgent, uninstallLaunchAgent } from "./launch-agent.js";
import { handleNotify } from "./notify.js";
import { webhookStatus } from "./webhook.js";
import { expandPath, ensureDirectory, pathExists, readTextFile } from "./paths.js";
import { buildImsgConfig, initOptionsFromFlags, resolveImsgChatId } from "./setup-imsg.js";
import { latestEventsByRun, readRuns, recordRun, writePromptFile, writeScriptFile } from "./state.js";
import { createAgentWindow, createCommandPane, createCommandWindow, killWindowByName, listAgentWindows, selectLayout, sendShellCommand, setWindowMetadata, validateSessionName } from "./tmux.js";
import { createWorktree, resolveRepoAndWorkdir } from "./worktree.js";

export async function main(argv, io = defaultIo()) {
  try {
    const parsed = parseArgv(argv);
    if (parsed.flags.version || parsed.command === "version") {
      io.stdout.write("relaymux 0.1.0\n");
      return 0;
    }
    if (parsed.flags.help || parsed.command === "help") {
      io.stdout.write(helpText());
      return 0;
    }

    if (parsed.command === "init") {
      return handleInit(parsed.flags, io);
    }

    if (parsed.command === "setup") {
      return handleSetup(parsed.flags, io);
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
      case "start-tmux":
        return handleStartTmux(parsed.flags, configInfo, stateDir, io);
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
    io.stderr.write(`relaymux: ${error.message}\n`);
    return 1;
  }
}

async function handleSetup(flags, io) {
  const configPath = flags.config || defaultConfigPath(io.env);
  let configInfo = loadConfig({ configPath, env: io.env });
  const shouldInstallLaunchAgent = flags.launchAgent !== false;

  if (!configInfo.exists || flags.force) {
    await handleInit({
      ...flags,
      imsg: flags.imsg ?? true,
      installLaunchAgent: shouldInstallLaunchAgent,
    }, io);
    configInfo = loadConfig({ configPath, env: io.env });
  } else {
    io.stdout.write(`Using existing config at ${configInfo.path}\n`);
    if (shouldInstallLaunchAgent) {
      installLaunchAgent({
        flags: { load: flags.load },
        configInfo,
        binPath: process.argv[1],
        io,
      });
    }
  }

  const status = handleDoctor(configInfo, io);
  if (status === 0) {
    io.stdout.write("Setup complete. relaymux is ready.\n");
  } else {
    io.stderr.write("Setup completed, but doctor found missing requirements. Fix the missing checks above and re-run `relaymux doctor`.\n");
  }
  return status;
}

async function handleInit(flags, io) {
  if (flags.imsg || flags.preset === "imsg") {
    const chatId = await resolveImsgChatId(flags, io, io.env);
    const config = buildImsgConfig({
      ...initOptionsFromFlags(flags),
      chatId,
    }, io.env);
    const target = writeConfig(flags.config || defaultConfigPath(io.env), config, { force: Boolean(flags.force) });
    io.stdout.write(`Created ${target} with imsg defaults\n`);
    io.stdout.write("Next: relaymux doctor && relaymux daemon\n");
    if (flags.installLaunchAgent) {
      installLaunchAgent({
        flags: { load: flags.load },
        configInfo: { config, path: target, exists: true },
        binPath: process.argv[1],
        io,
      });
    }
    return 0;
  }

  const target = writeDefaultConfig(flags.config || defaultConfigPath(io.env), { force: Boolean(flags.force) });
  io.stdout.write(`Created ${target}\n`);
  io.stdout.write("Tip: use `relaymux init --imsg` for an imsg-based setup wizard.\n");
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
  const session = flags.session || io.env.RELAYMUX_SESSION || config.session || "agents";
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
      session,
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
    session,
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
    relaymux: "1",
    relaymux_agent: agentName,
    relaymux_name: name,
    relaymux_repo: repo,
    relaymux_run_id: runId,
    relaymux_started: started,
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

function handleStartTmux(flags, configInfo, stateDir, io) {
  if (!flags.session) {
    throw new Error("Missing --session <name> for start-tmux");
  }

  const config = configInfo.config;
  const session = String(flags.session);
  validateSessionName(session);
  const windowName = sanitizeName(flags.windowName || "relaymux-daemon");
  const cwd = expandPath(config.orchestrator?.cwd || "~");
  const daemonArgv = [process.execPath, process.argv[1], "--config", configInfo.path, "daemon", "--session", session];
  const exitBehavior = flags.hold
    ? [
        'printf "\\nrelaymux daemon exited with status %s\\n" "$status"',
        'exec "${SHELL:-/bin/sh}"',
      ]
    : ['exit "$status"'];
  const daemonShellCommand = [
    "set +e",
    shellExportBlock({
      RELAYMUX_CONFIG: configInfo.path,
      RELAYMUX_SESSION: session,
    }),
    quoteArgv(daemonArgv),
    "status=$?",
    ...exitBehavior,
  ].join("\n");

  if (flags.dryRun) {
    io.stdout.write(`# session: ${session}\n`);
    io.stdout.write(`# window: ${windowName}\n`);
    io.stdout.write(`# cwd: ${cwd}\n`);
    if (flags.keepLaunchAgent || flags.stopLaunchAgent === false) {
      io.stdout.write("# leaving configured LaunchAgent alone\n");
    } else {
      io.stdout.write(`# would stop LaunchAgent ${config.daemon?.launchAgentLabel || "com.relaymux.daemon"} if loaded\n`);
    }
    if (flags.restart !== false) {
      io.stdout.write(`# would replace existing tmux window ${session}:${windowName} if present\n`);
    }
    io.stdout.write("# daemon shell command:\n");
    io.stdout.write(`${daemonShellCommand}\n`);
    for (const extraWindow of resolveExtraTmuxWindows(config, { configPath: configInfo.path, session, stateDir })) {
      io.stdout.write(`# extra ${extraWindow.mode}: ${extraWindow.name}\n`);
      io.stdout.write(`# extra cwd: ${extraWindow.cwd}\n`);
      if (flags.restart !== false && extraWindow.restart !== false) {
        io.stdout.write(`# would remove existing tmux window ${session}:${extraWindow.name} if present\n`);
      }
      io.stdout.write(`${extraWindow.shellCommand}\n`);
    }
    return 0;
  }

  ensureDirectory(stateDir);
  if (!flags.keepLaunchAgent && flags.stopLaunchAgent !== false) {
    stopLaunchAgent({ config, io });
  }
  if (flags.restart !== false) {
    killWindowByName({ session, name: windowName });
  }

  const target = createCommandWindow({
    session,
    name: windowName,
    cwd,
    shellCommand: daemonShellCommand,
  });
  const started = new Date().toISOString();
  setWindowMetadata(target.windowTarget, {
    relaymux: "1",
    relaymux_agent: "daemon",
    relaymux_config: configInfo.path,
    relaymux_daemon: "1",
    relaymux_name: windowName,
    relaymux_repo: cwd,
    relaymux_run_id: `daemon-${session}`,
    relaymux_session: session,
    relaymux_started: started,
  });

  const extraTargets = [];
  let createdPane = false;
  for (const extraWindow of resolveExtraTmuxWindows(config, { configPath: configInfo.path, session, stateDir })) {
    if (flags.restart !== false && extraWindow.restart !== false) {
      killWindowByName({ session, name: extraWindow.name });
    }

    if (extraWindow.mode === "pane") {
      const extraTarget = createCommandPane({
        windowTarget: target.windowTarget,
        cwd: extraWindow.cwd,
        shellCommand: extraWindow.shellCommand,
        split: extraWindow.split,
      });
      createdPane = true;
      extraTargets.push({ ...extraWindow, target: extraTarget.target });
      continue;
    }

    const extraTarget = createCommandWindow({
      session,
      name: extraWindow.name,
      cwd: extraWindow.cwd,
      shellCommand: extraWindow.shellCommand,
    });
    setWindowMetadata(extraTarget.windowTarget, {
      relaymux: "1",
      relaymux_agent: "extra",
      relaymux_config: configInfo.path,
      relaymux_extra: "1",
      relaymux_name: extraWindow.name,
      relaymux_repo: extraWindow.cwd,
      relaymux_run_id: `extra-${session}-${extraWindow.name}`,
      relaymux_session: session,
      relaymux_started: started,
    });
    extraTargets.push({ ...extraWindow, target: extraTarget.target });
  }
  if (createdPane) {
    selectLayout(target.windowTarget, "tiled");
  }

  io.stdout.write(`Started relaymux daemon in tmux target ${target.target}\n`);
  for (const extraTarget of extraTargets) {
    io.stdout.write(`Started extra tmux ${extraTarget.mode} ${extraTarget.name} in target ${extraTarget.target}\n`);
  }
  io.stdout.write(`Session: ${session}\n`);
  io.stdout.write(`Attach with: tmux attach -t ${session}\n`);
  io.stdout.write(`Logs: tmux capture-pane -pt ${target.windowTarget} -S -200\n`);
  if (flags.attach) {
    io.stdout.write(`Attach command: tmux attach -t ${session}\n`);
  }
  return 0;
}

function resolveExtraTmuxWindows(config, context) {
  const extraWindows = config.tmux?.extraWindows;
  if (!Array.isArray(extraWindows)) return [];

  return extraWindows.map((extraWindow, index) => {
    const name = sanitizeName(extraWindow.name || `extra-${index + 1}`);
    const templateContext = {
      ...context,
      name,
      index: String(index),
    };
    const cwd = expandPath(renderTemplate(extraWindow.cwd || config.orchestrator?.cwd || "~", templateContext));
    const mode = extraWindow.mode === "pane" ? "pane" : "window";
    const split = extraWindow.split === "vertical" ? "vertical" : "horizontal";
    const env: Record<string, string> = {
      RELAYMUX_CONFIG: context.configPath,
      RELAYMUX_SESSION: context.session,
    };
    for (const [key, value] of Object.entries(extraWindow.env ?? {})) {
      env[key] = renderTemplate(value, templateContext);
    }

    let commandText;
    if (Array.isArray(extraWindow.command) && extraWindow.command.length > 0) {
      commandText = quoteArgv(extraWindow.command.map((part) => renderTemplate(part, templateContext)));
    } else if (extraWindow.shellCommand) {
      commandText = renderTemplate(extraWindow.shellCommand, templateContext);
    } else {
      throw new Error(`tmux extra window "${name}" must define command or shellCommand`);
    }

    const shellCommand = [
      "set +e",
      shellExportBlock(env),
      `exec ${commandText}`,
    ].join("\n");

    return {
      name,
      cwd,
      mode,
      restart: extraWindow.restart,
      shellCommand,
      split,
    };
  });
}

function buildLaunchShellScript(agentName, agentConfig, context) {
  const invocation = buildAgentInvocation(agentName, agentConfig, context);
  return buildTmuxShellScript(invocation, context);
}

function handleStatus(flags, configInfo, stateDir, io) {
  const config = configInfo.config;
  const session = flags.session || io.env.RELAYMUX_SESSION || config.session;
  const windows = listAgentWindows({ session: flags.all ? undefined : session });
  const windowsByRunId = new Map(windows.map((window) => [window.runId, window]));
  const latestEvents = latestEventsByRun(stateDir);
  const rows = [];

  if (flags.history) {
    const runs = readRuns(stateDir);
    for (const run of runs) {
      const window = windowsByRunId.get(run.runId);
      const latestEvent = latestEvents.get(run.runId);
      rows.push(statusRow(run, window, latestEvent));
    }
  }

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
    io.stdout.write(flags.history ? "No relaymux runs found.\n" : "No relaymux tmux windows found. Use --history to include old run records.\n");
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
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function helpText() {
  return `relaymux - run local coding agents in tmux

Usage:
  relaymux setup [--imsg] [--chat-id <id>] [--no-launch-agent]
  relaymux init [--force] [--config <path>]
  relaymux init --imsg [--chat-id <id>] [--install-launch-agent]
  relaymux daemon [--once]
  relaymux start-tmux --session <name>
  relaymux install-launch-agent [--dry-run] [--no-load]
  relaymux uninstall-launch-agent
  relaymux launch --repo <path> --agent <name> --prompt <text|@file> [--name <name>]
  relaymux status [--json] [--session <name>] [--all]
  relaymux notify [--run-id <id>] [--reply-mode imessage|none] [--message <text>]
  relaymux doctor

Setup/init options:
  --imsg                    Create an imsg-based config and prompt for a chat when possible
  --chat-id <id>            Messages chat id/phone for imsg history/send
  --cwd <path>              Working directory for Pi and message commands
  --state-dir <path>        State/session/token directory
  --install-launch-agent    Install the LaunchAgent after writing config
  --no-launch-agent         For setup: skip LaunchAgent installation

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

Tmux daemon options:
  --session <name>           Required for start-tmux; tmux session to create/use
  --window-name <name>       Daemon window name (default: relaymux-daemon)
  --no-restart               Do not replace an existing daemon window of the same name
  --keep-launch-agent        Do not stop the configured macOS LaunchAgent first
  --hold                     Keep a shell open if the daemon exits
  --attach                   Print attach command after start

Daemon/notify options:
  --once                     Poll once, drain queued work, then exit (for smoke tests)
  --session <name>           Runtime session override for daemon-launched subagents
  --reply-mode <mode>        For notify: imessage sends a concise chat update; none is quiet context
  --from <name>              For notify: source/subagent name
  --idempotency-key <key>    For notify: suppress duplicate completion webhook retries
  --metadata-json <json>     For notify: optional metadata object
  --history                  For status: include old run records whose tmux windows are gone

Config defaults to ${defaultConfigPath()}.
`;
}
