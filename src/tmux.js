import { runCommand } from "./process.js";

const WINDOW_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  "#{window_panes}",
  "#{pane_current_path}",
  "#{@agentmux}",
  "#{@agentmux_run_id}",
  "#{@agentmux_agent}",
  "#{@agentmux_repo}",
  "#{@agentmux_name}",
  "#{@agentmux_started}",
].join("\t");

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

  const args = hasSession(session)
    ? ["new-window", "-d", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}", "-t", `${session}:`, "-n", name, "-c", cwd]
    : ["new-session", "-d", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}", "-s", session, "-n", name, "-c", cwd];

  const result = runCommand("tmux", args);
  const target = result.stdout.trim();
  return {
    target,
    windowTarget: target.replace(/\.\d+$/, ""),
  };
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

export function listAgentWindows({ session } = {}) {
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
    .filter((window) => window.agentmux === "1");
}

function parseWindowLine(line) {
  const [
    session,
    windowIndex,
    windowName,
    active,
    panes,
    cwd,
    agentmux,
    runId,
    agent,
    repo,
    name,
    started,
  ] = line.split("\t");

  return {
    session,
    windowIndex,
    windowName,
    active: active === "1",
    panes: Number(panes),
    cwd,
    agentmux,
    runId,
    agent,
    repo,
    name,
    started,
    target: `${session}:${windowIndex}`,
  };
}
