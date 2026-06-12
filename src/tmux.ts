import { runCommand } from "./process.js";

const WINDOW_FIELD_SEPARATOR = "<|relaymux|>";
const WINDOW_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  "#{window_panes}",
  "#{pane_current_path}",
  "#{@relaymux}",
  "#{@relaymux_run_id}",
  "#{@relaymux_agent}",
  "#{@relaymux_repo}",
  "#{@relaymux_name}",
  "#{@relaymux_started}",
].join(WINDOW_FIELD_SEPARATOR);

export function validateSessionName(session) {
  if (!/^[A-Za-z0-9_.-]+$/.test(session)) {
    throw new Error(`Invalid tmux session name "${session}". Use letters, numbers, dot, dash, or underscore.`);
  }
}

export function hasSession(session) {
  const result = runCommand("tmux", ["has-session", "-t", session], { allowFailure: true });
  return result.status === 0;
}

export function createAgentWindow({ session, name, cwd }) {
  validateSessionName(session);

  return createWindow({ session, name, cwd });
}

export function createCommandWindow({ session, name, cwd, shellCommand }) {
  validateSessionName(session);

  return createWindow({ session, name, cwd, shellCommand });
}

export function createCommandPane({ windowTarget, cwd, shellCommand, split = "horizontal" }) {
  const args = ["split-window", "-d", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}"];
  if (split === "vertical") {
    args.push("-v");
  } else {
    args.push("-h");
  }
  args.push("-t", windowTarget, "-c", cwd, shellCommand);

  const result = runCommand("tmux", args);
  const target = result.stdout.trim();
  return {
    target,
    windowTarget: target.replace(/\.\d+$/, ""),
  };
}

function createWindow({ session, name, cwd, shellCommand = undefined }) {
  const args = hasSession(session)
    ? ["new-window", "-d", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}", "-t", `${session}:`, "-n", name, "-c", cwd]
    : ["new-session", "-d", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}", "-s", session, "-n", name, "-c", cwd];

  if (shellCommand !== undefined) {
    args.push(shellCommand);
  }

  const result = runCommand("tmux", args);
  const target = result.stdout.trim();
  return {
    target,
    windowTarget: target.replace(/\.\d+$/, ""),
  };
}

export function killWindowByName({ session, name }) {
  validateSessionName(session);
  const result = runCommand("tmux", ["kill-window", "-t", `${session}:${name}`], { allowFailure: true });
  return result.status === 0;
}

export function selectLayout(target, layout = "tiled") {
  runCommand("tmux", ["select-layout", "-t", target, layout], { allowFailure: true });
}

export function sendShellCommand(target, shellCommand) {
  runCommand("tmux", ["send-keys", "-t", target, "-l", shellCommand]);
  runCommand("tmux", ["send-keys", "-t", target, "C-m"]);
}

export function setWindowMetadata(windowTarget, metadata) {
  for (const [key, value] of Object.entries(metadata)) {
    runCommand("tmux", ["set-option", "-w", "-t", windowTarget, `@${key}`, String(value)]);
  }
}

export function listAgentWindows({ session }: any = {}) {
  const args = session
    ? ["list-windows", "-t", session, "-F", WINDOW_FORMAT]
    : ["list-windows", "-a", "-F", WINDOW_FORMAT];
  const result = runCommand("tmux", args, { allowFailure: true });
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map(parseWindowLine)
    .filter((window) => window.relaymux === "1");
}

function parseWindowLine(line) {
  const [
    session,
    windowIndex,
    windowName,
    active,
    panes,
    cwd,
    relaymux,
    runId,
    agent,
    repo,
    name,
    started,
  ] = line.split(WINDOW_FIELD_SEPARATOR);

  return {
    session,
    windowIndex,
    windowName,
    active: active === "1",
    panes: Number(panes),
    cwd,
    relaymux,
    runId,
    agent,
    repo,
    name,
    started,
    target: `${session}:${windowIndex}`,
  };
}
