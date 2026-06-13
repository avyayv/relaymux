import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseArgv } from "./args.js";
import { buildAgentInvocation, buildTmuxShellCommand, buildTmuxShellScript, quoteArgv, renderTemplate, shellExportBlock } from "./command.js";
import { collectDoctorChecks } from "./doctor.js";
import { defaultConfigPath, loadConfig, resolveLogDir, resolveStateDir, writeConfig, writeDefaultConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { getLaunchAgentStatus, installLaunchAgent, launchAgentPath, printLaunchAgentStatus, restartLaunchAgent, uninstallLaunchAgent } from "./launch-agent.js";
import { handleHandsCommand } from "./hands.js";
import { handleNotify } from "./notify.js";
import { webhookConfig, webhookStatus } from "./webhook.js";
import { expandPath, ensureDirectory, pathExists, readTextFile } from "./paths.js";
import { applyHomeMigration, buildHomeMigrationInventory, ensureRelaymuxHomeLayout, formatHomeMigrationInventory, formatHomeMigrationResults } from "./migration.js";
import { buildImsgConfig, initOptionsFromFlags, resolveImsgChatId } from "./setup-imsg.js";
import { latestEventsByRun, readRuns, recordRun, writePromptFile, writeScriptFile } from "./state.js";
import { resolveLaunchSession, resolveTmuxSessionMode } from "./session.js";
import { createAgentWindow, createCommandWindow, killWindowByName, listAgentWindows, sendShellCommand, setWindowMetadata, validateSessionName } from "./tmux.js";
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
    const stateDir = resolveStateDir(configInfo.config, io.env);

    switch (parsed.command) {
      case "migrate-home":
        return handleMigrateHome(parsed.flags, configInfo, io);
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
      case "ask":
      case "request":
        return handleAsk(parsed.flags, parsed.positionals, configInfo, io);
      case "hands":
        return await handleHandsCommand({ flags: parsed.flags, positionals: parsed.positionals, configInfo, stateDir, io });
      case "daemon":
        return await runDaemon({ flags: parsed.flags, configInfo, stateDir, io });
      case "start-tmux":
        return handleStartTmux(parsed.flags, configInfo, stateDir, io);
      case "supervise-tmux":
        return await handleSuperviseTmux(parsed.flags, configInfo, stateDir, io);
      case "install-launch-agent":
        installLaunchAgent({ flags: parsed.flags, configInfo, binPath: process.argv[1], io });
        return 0;
      case "restart-launch-agent":
        restartLaunchAgent({ flags: parsed.flags, configInfo, binPath: process.argv[1], io });
        return 0;
      case "status-launch-agent":
      case "launch-agent-status":
        printLaunchAgentStatus({ config: configInfo.config, io, json: Boolean(parsed.flags.json) });
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
  let configInfo = loadConfig({ configPath: flags.config, env: io.env });
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
    if (configInfo.usingLegacyDefault) {
      io.stdout.write("Tip: this is the legacy config path. Run `relaymux migrate-home --dry-run` to inventory a safe move into ~/.relaymux.\n");
    }
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
    const target = writeConfig(flags.config || defaultConfigPath(io.env), config, { force: Boolean(flags.force), env: io.env });
    const homeDir = ensureRelaymuxHomeLayout(path.dirname(defaultConfigPath(io.env)));
    io.stdout.write(`Created ${target} with imsg defaults\n`);
    io.stdout.write(`relaymux home: ${homeDir} (state ${resolveStateDir(config, io.env)}, logs ${resolveLogDir(config, io.env)})\n`);
    io.stdout.write("Next: relaymux doctor && relaymux restart-launch-agent && relaymux status\n");
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

  const target = writeDefaultConfig(flags.config || defaultConfigPath(io.env), { force: Boolean(flags.force), env: io.env });
  const config = loadConfig({ configPath: target, env: io.env }).config;
  const homeDir = ensureRelaymuxHomeLayout(path.dirname(defaultConfigPath(io.env)));
  io.stdout.write(`Created ${target}\n`);
  io.stdout.write(`relaymux home: ${homeDir} (state ${resolveStateDir(config, io.env)}, logs ${resolveLogDir(config, io.env)})\n`);
  io.stdout.write("Tip: use `relaymux init --imsg` for an imsg-based setup wizard.\n");
  return 0;
}

function handleMigrateHome(flags, configInfo, io) {
  const inventory = buildHomeMigrationInventory({
    homeDir: flags.home || flags.relaymuxHome,
    targetConfigPath: flags.targetConfig,
    legacyConfigPath: flags.legacyConfig,
    legacyStateDir: flags.legacyStateDir,
    orchestratorImessageDir: flags.orchestratorImessageDir,
    researchDir: flags.researchDir,
    agentmuxConfigPath: flags.agentmuxConfig,
    agentmuxStateDir: flags.agentmuxStateDir,
    configPath: configInfo.exists ? configInfo.path : undefined,
    config: configInfo.config,
  }, io.env);

  const applying = flags.apply === true && flags.dryRun !== true;
  if (flags.json && !applying) {
    io.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return 0;
  }

  io.stdout.write(formatHomeMigrationInventory(inventory, {
    applying,
    force: Boolean(flags.force),
    symlink: Boolean(flags.symlink),
  }));

  if (!applying) return 0;

  const results = applyHomeMigration(inventory, {
    force: Boolean(flags.force),
    symlink: Boolean(flags.symlink),
    env: io.env,
  });
  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ inventory, results }, null, 2)}\n`);
  } else {
    io.stdout.write(formatHomeMigrationResults(results));
  }
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
  const { repo, workdir, worktreeAddArgs } = resolveRepoAndWorkdir(flags);
  const name = sanitizeName(flags.name || `${agentName}-${path.basename(workdir)}-${runId.slice(-6)}`);
  const sessionInfo = resolveLaunchSession({ flags, config, env: io.env, repo, workdir, name });
  const session = sessionInfo.session;
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
    io.stdout.write(`# tmux session: ${session} (${sessionInfo.mode}; ${sessionInfo.source})\n`);
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
    relaymux_session: session,
    relaymux_session_mode: sessionInfo.mode,
    relaymux_started: started,
  });
  sendShellCommand(target.target, shellCommand);

  recordRun(stateDir, {
    time: started,
    runId,
    session,
    sessionMode: sessionInfo.mode,
    sessionSource: sessionInfo.source,
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

  io.stdout.write(`Started ${name} in tmux session ${session} tab ${target.windowTarget} (target ${target.target})\n`);
  io.stdout.write(`Run ID: ${runId}\n`);
  if (flags.attach) {
    io.stdout.write(`Attach with: tmux attach -t ${session}\n`);
  }
  return 0;
}

async function handleAsk(flags, positionals, configInfo, io) {
  const text = resolveRequestText(flags, positionals);
  const replyMode = flags.replyMode || "none";
  if (!["imessage", "none"].includes(replyMode)) {
    throw new Error("--reply-mode must be imessage or none");
  }

  const metadata = flags.metadataJson ? parseMetadataJson(flags.metadataJson) : {};
  const wait = flags.wait !== false;
  const result = await postDaemonRequest(configInfo.config, {
    text,
    source: flags.from || "terminal",
    metadata,
    replyMode,
    wait,
  }, Number(flags.timeoutMs || 0));

  if (!wait) {
    io.stdout.write(`Queued terminal request ${result.requestId}\n`);
    return 0;
  }

  if (!result.ok) {
    throw new Error(result.error || "terminal request failed");
  }

  io.stdout.write(`${String(result.reply || "Done.").trim()}\n`);
  return 0;
}

function handleStartTmux(flags, configInfo, stateDir, io) {
  if (!flags.allowTmuxDaemon) {
    throw new Error("start-tmux daemon mode is retired: iMessage/background/orchestrator must run as a direct LaunchAgent outside tmux. Use `relaymux restart-launch-agent` for the background service and `relaymux launch` for agent tmux tabs.");
  }
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
    io.stdout.write("# leaving configured LaunchAgent/background service alone\n");
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
  for (const extraWindow of resolveExtraTmuxWindows(config, { configPath: configInfo.path, session, stateDir })) {
    if (extraWindow.deprecatedMode) {
      io.stderr.write(`relaymux: tmux.extraWindows mode=${extraWindow.deprecatedMode} is deprecated; creating a normal tmux tab/window instead.\n`);
    }
    if (flags.restart !== false && extraWindow.restart !== false) {
      killWindowByName({ session, name: extraWindow.name });
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

async function handleSuperviseTmux(flags, configInfo, stateDir, io) {
  if (!flags.allowTmuxDaemon) {
    throw new Error("supervise-tmux daemon mode is retired: the background iMessage/orchestrator service must run direct outside tmux.");
  }
  const config = configInfo.config;
  const session = String(flags.session || io.env.RELAYMUX_SESSION || config.session || "agents");
  validateSessionName(session);
  const windowName = sanitizeName(flags.windowName || "relaymux-daemon");
  const configuredIntervalMs = Number(flags.intervalMs || config.daemon?.supervisorPollMs || 15000);
  const intervalMs = Number.isFinite(configuredIntervalMs) ? Math.max(1000, configuredIntervalMs) : 15000;
  let checking = false;

  const log = (...args) => io.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
  const warn = (...args) => io.stderr.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
  const startFlags = {
    ...flags,
    session,
    windowName,
    attach: false,
    dryRun: false,
    keepLaunchAgent: true,
    stopLaunchAgent: false,
    restart: flags.restart !== false,
  };

  function ensureStarted() {
    if (checking) return;
    checking = true;
    try {
      const reason = tmuxStackRepairReason(config, session, windowName);
      if (!reason) return;

      log(`starting relaymux tmux stack: ${reason}`);
      handleStartTmux(startFlags, configInfo, stateDir, io);
    } catch (error) {
      warn("tmux supervisor check failed:", error?.message || String(error));
    } finally {
      checking = false;
    }
  }

  if (flags.dryRun) {
    return handleStartTmux({ ...startFlags, dryRun: true }, configInfo, stateDir, io);
  }

  log(`supervising relaymux tmux session ${session} window ${windowName} every ${intervalMs}ms`);
  ensureStarted();
  if (flags.once) return 0;

  const interval = setInterval(ensureStarted, intervalMs);
  await new Promise<void>((resolve) => {
    const shutdown = (signal) => {
      log(`stopping tmux supervisor (${signal})`);
      clearInterval(interval);
      resolve();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
  return 0;
}

function tmuxStackRepairReason(config, session, windowName) {
  const windows = listAgentWindows({ session });
  const daemonWindow = windows.find((window) => window.agent === "daemon" && (window.name === windowName || window.windowName === windowName));
  if (!daemonWindow) {
    return `daemon window ${session}:${windowName} is missing`;
  }

  const extraWindows = Array.isArray(config.tmux?.extraWindows) ? config.tmux.extraWindows : [];
  for (const [index, extraWindow] of extraWindows.entries()) {
    const name = sanitizeName(extraWindow.name || `extra-${index + 1}`);
    const exists = windows.some((window) => window.agent === "extra" && (window.name === name || window.windowName === name));
    if (!exists) {
      return `extra window ${session}:${name} is missing`;
    }
  }

  return "";
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
    const deprecatedMode = extraWindow.mode === "pane" ? "pane" : "";
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
      deprecatedMode,
      mode: "window",
      restart: extraWindow.restart,
      shellCommand,
    };
  });
}

function buildLaunchShellScript(agentName, agentConfig, context) {
  const invocation = buildAgentInvocation(agentName, agentConfig, context);
  return buildTmuxShellScript(invocation, context);
}

function handleStatus(flags, configInfo, stateDir, io) {
  const config = configInfo.config;
  const session = flags.session ? String(flags.session) : undefined;
  const windows = listAgentWindows({ session });
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
  const daemon = daemonStatus(config, configInfo.path, io.env);

  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ daemon, runs: rows }, null, 2)}\n`);
    return 0;
  }

  const launchAgent: any = daemon.launchAgent;
  const launchAgentText = launchAgent.supported
    ? launchAgent.loaded
      ? `LaunchAgent ${launchAgent.label} loaded${launchAgent.running ? ` pid=${launchAgent.pid}` : ""}`
      : `LaunchAgent ${launchAgent.label} not loaded`
    : `LaunchAgent unsupported on ${process.platform}`;
  io.stdout.write(`Home: ${daemon.homeDir}; config ${daemon.configPath}; state ${daemon.stateDir}; logs ${daemon.logDir}\n`);
  io.stdout.write(`Background service: ${daemon.enabled ? "enabled" : "disabled"}; mode ${daemon.launchMode}/background (no tmux); ${launchAgentText}; webhook ${daemon.webhook.endpoints.message}; token ${daemon.webhook.tokenFileExists ? daemon.webhook.tokenFileMode : "missing"}\n`);
  io.stdout.write(`Agent tmux: session mode ${daemon.agentSessionMode}; ${session ? `filter session ${session}` : "showing all relaymux-managed sessions"}; tabs are tmux windows, never panes/splits.\n`);

  if (rows.length === 0) {
    io.stdout.write(flags.history ? "No relaymux runs found.\n" : "No relaymux agent tabs found. Use --history to include old run records.\n");
    return 0;
  }

  io.stdout.write(formatTable(rows, ["state", "target", "session", "tab", "agent", "name", "repo", "lastEvent"]));
  return 0;
}

function daemonStatus(config, configPath, env = process.env) {
  const agentSessionMode = resolveTmuxSessionMode({ config });
  return {
    enabled: config.daemon?.enabled !== false,
    homeDir: path.dirname(defaultConfigPath(env)),
    configPath,
    stateDir: resolveStateDir(config, env),
    logDir: resolveLogDir(config, env),
    launchMode: "direct",
    agentSessionMode,
    featureSessionMode: agentSessionMode,
    webhook: webhookStatus(config),
    launchAgentPath: launchAgentPath(config),
    launchAgent: getLaunchAgentStatus(config),
  };
}

function statusRow(run, window, latestEvent) {
  const completed = latestEvent?.event === "completed";
  const state = completed
      ? `completed:${latestEvent.exitCode ?? ""}`
      : window
        ? "running"
        : "window-missing";

  const target = window?.target || run.windowTarget || run.target || "";
  return {
    runId: run.runId,
    started: run.time || run.started,
    state,
    target,
    session: window?.session || run.session || targetSession(target),
    tab: window ? `${window.windowIndex}:${window.windowName}` : targetTab(target),
    agent: run.agent || window?.agent || "",
    name: run.name || window?.name || "",
    repo: run.repo || window?.repo || "",
    workdir: run.workdir || window?.cwd || "",
    lastEvent: latestEvent ? `${latestEvent.event}${latestEvent.message ? `: ${latestEvent.message}` : ""}` : "",
  };
}

function targetSession(target) {
  return String(target || "").split(":")[0] || "";
}

function targetTab(target) {
  const text = String(target || "");
  const tab = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  return tab.replace(/\.\d+$/, "");
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

function resolveRequestText(flags, positionals) {
  if (flags.prompt !== undefined || flags.promptFile) {
    return resolvePrompt(flags);
  }
  if (flags.message !== undefined) {
    return String(flags.message);
  }
  if (positionals.length > 0) {
    return positionals.join(" ");
  }
  throw new Error("Missing request text. Use `relaymux ask <text>` or --message <text>.");
}

function parseMetadataJson(raw) {
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("metadata must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid --metadata-json: ${error.message}`);
  }
}

async function postDaemonRequest(config, body, timeoutMs): Promise<any> {
  const resolved = webhookConfig(config);
  const token = fs.readFileSync(resolved.tokenFile, "utf8").trim();
  if (!token) throw new Error(`Webhook token file is empty: ${resolved.tokenFile}`);

  const payload = Buffer.from(JSON.stringify(body));
  const hostname = String(resolved.host).replace(/^\[(.*)\]$/, "$1");
  return new Promise<any>((resolve, reject) => {
    const req = http.request({
      hostname,
      port: resolved.port,
      path: "/request",
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(payload.length),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          reject(new Error(`daemon returned non-JSON response (${res.statusCode}): ${raw.slice(0, 500)}`));
          return;
        }
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(parsed.error || `daemon request failed with HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", (error) => reject(new Error(`Could not reach relaymux daemon at ${hostname}:${resolved.port}: ${error.message}`)));
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms waiting for relaymux daemon`)));
    }
    req.end(payload);
  });
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
  return `relaymux - relay iMessage/SMS requests to local coding agents

Mental model:
  - iMessage/background/orchestrator runs as a direct macOS LaunchAgent outside tmux.
  - By default, all agents open as tmux tabs/windows in one shared session.
  - Managed config/state/logs/prompts/scratch live under ~/.relaymux by default.
  - Use --session only when you explicitly want a separate/new/named tmux session; panes/splits are never used.

Start here:
  relaymux setup
  relaymux doctor
  relaymux status

Usage:
  relaymux setup [--imsg] [--chat-id <id>] [--no-launch-agent]
  relaymux init [--force] [--config <path>]
  relaymux init --imsg [--chat-id <id>] [--install-launch-agent]
  relaymux install-launch-agent [--dry-run] [--no-load]
  relaymux restart-launch-agent [--dry-run] [--no-load]
  relaymux status-launch-agent [--json]
  relaymux uninstall-launch-agent
  relaymux launch --repo <path> --agent <name> --prompt <text|@file> [--name <name>]
  relaymux ask <text> [--no-wait] [--reply-mode imessage|none]
  relaymux hands <status|run|serve-dev|enqueue> [options]
  relaymux status [--json] [--session <name>]
  relaymux notify [--run-id <id>] [--reply-mode imessage|none] [--message <text>]
  relaymux migrate-home [--dry-run] [--apply] [--symlink]
  relaymux doctor

Setup/init options:
  --imsg                    Create an imsg-based config and prompt for a chat when possible
  --chat-id <id>            Messages chat id/phone for imsg history/send
  --cwd <path>              Working directory for Pi and message commands
  --state-dir <path>        State/token/log directory
  --install-launch-agent    Install the direct/background LaunchAgent after writing config
  --no-launch-agent         For setup: skip LaunchAgent installation

Migration options:
  --apply                   Copy inventoried relaymux-owned files into ~/.relaymux
  --symlink                 After copying, replace old relaymux-owned source paths with symlinks
  --home <path>             Override target relaymux home (default ~/.relaymux)
  --legacy-config <path>    Override legacy config path to inventory
  --legacy-state-dir <path> Override legacy state dir to inventory

Launch options:
  --prompt-file <path>       Read prompt from a file
  --session <name>           Explicitly launch this agent into a separate/named tmux session
  --session-mode <mode>      shared (default) or per-worktree
  --worktree <path>          Launch from a generic git worktree path
  --create-worktree          Create --worktree with git worktree add when missing
  --worktree-branch <name>   Branch name to use with --create-worktree/session naming
  --worktree-from <ref>      Starting ref to use with --create-worktree
  --dry-run                  Print the tmux tab command without launching
  --print-command            Print the tmux tab command before launching
  --hold                     Keep a shell open after the agent exits
  --attach                   Print attach command after launch

Background service options:
  --no-load                  Write the LaunchAgent plist without loading it
  --keep-tmux-daemon         During migration, do not stop an old relaymux-daemon tmux tab

Request/notify/status options:
  --message <text>           Request/notify message text
  --no-wait                  For ask/request: enqueue and return immediately
  --timeout-ms <ms>          For ask/request: client-side wait timeout
  --reply-mode <mode>        imessage sends a concise chat update; none is quiet/no text
  --from <name>              For notify: source/subagent name
  --idempotency-key <key>    For notify: suppress duplicate completion webhook retries
  --metadata-json <json>     For notify: optional metadata object
  --history                  For status: include old run records whose tmux tabs are gone

Cloud-base/local-hands options:
  relaymux hands help        Show worker, dev-server, and task enqueue usage
  --endpoint <url>           Cloud/dev endpoint for hands worker or enqueue client
  --token-file <path>        Token file used to authenticate to the cloud/dev endpoint
  --workspace <name=path>    Worker allowlisted workspace root; for enqueue, workspace name
  --allow-write              Worker may execute write-file tasks inside the workspace
  --allow-shell              Worker may execute shell tasks inside the workspace

Useful commands:
  tmux attach -t <session>       attach to the shared or named agent session
  tmux kill-session -t <session> kill only that tmux session; background iMessage keeps running

Default home layout: ~/.relaymux/{config.json,state,logs,tasks,reports,research,workouts}.
Config defaults to ${defaultConfigPath()} (legacy ~/.config/relaymux/config.json is still read if the new config does not exist).
`;
}
