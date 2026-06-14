import path from "node:path";

const VALID_PROMPT_MODES = new Set(["arg", "env", "none", "stdin"]);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateConfiguredAgentCommand(agentName, agentConfig, { location = `agents.${agentName}` } = {}) {
  const findings: any[] = [];
  if (!agentConfig || !Array.isArray(agentConfig.command) || agentConfig.command.length === 0) {
    findings.push(errorFinding(`${location}.command must be a non-empty command array`));
    return findings;
  }

  const promptMode = agentConfig.promptMode ?? "arg";
  if (!VALID_PROMPT_MODES.has(promptMode)) {
    findings.push(errorFinding(`${location}.promptMode must be one of arg, env, none, or stdin (got ${JSON.stringify(promptMode)})`));
  }

  for (const key of Object.keys(agentConfig.env ?? {})) {
    if (!ENV_KEY.test(key)) {
      findings.push(errorFinding(`${location}.env contains invalid environment key ${JSON.stringify(key)}`));
    }
  }

  findings.push(...validateKnownCliCommand(agentConfig.command, { location: `${location}.command` }));
  return findings;
}

export function validateKnownCliCommand(command, { location = "command" } = {}) {
  if (!Array.isArray(command) || command.length === 0) return [];

  const executable = executableName(command[0]);
  if (executable === "codex") {
    return validateCodexCommand(command, { location });
  }
  if (executable === "pi" || executable === "claude") {
    return [];
  }
  return [];
}

export function assertNoFatalCommandFindings(agentName, agentConfig, options: any = {}) {
  const findings = validateConfiguredAgentCommand(agentName, agentConfig, options);
  const fatal = findings.filter((finding) => finding.severity !== "warning");
  if (!fatal.length) return findings;

  const details = fatal.map((finding) => `- ${finding.detail}`).join("\n");
  throw new Error(`Agent "${agentName}" command failed validation:\n${details}\nRun \`relaymux doctor\` after editing your config.`);
}

function validateCodexCommand(command, { location }) {
  const findings: any[] = [];
  for (let index = 1; index < command.length; index += 1) {
    const part = String(command[index]);
    if (isReasoningEffortFlag(part)) {
      const value = flagValue(part, command[index + 1]);
      findings.push(errorFinding(
        `${location} contains ${value}. Current Codex CLI rejects --reasoning-effort; remove that flag/value from your relaymux config or replace it with a Codex-supported option.`,
      ));
    }
  }
  return findings;
}

function isReasoningEffortFlag(part) {
  return part === "--reasoning-effort" || part.startsWith("--reasoning-effort=") || /^--reasoning-effort\s+/.test(part);
}

function flagValue(part, nextPart) {
  if (part.includes("=")) return JSON.stringify(part);
  if (/^--reasoning-effort\s+/.test(part)) return JSON.stringify(part);
  if (nextPart && !String(nextPart).startsWith("--")) return `${JSON.stringify(part)} ${JSON.stringify(nextPart)}`;
  return JSON.stringify(part);
}

function executableName(value) {
  return path.basename(String(value || ""));
}

function errorFinding(detail) {
  return { ok: false, severity: "error", fatal: true, detail };
}
