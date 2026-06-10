const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_/:=@%+.,-]+$/;

export function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) {
    return "''";
  }
  if (SAFE_SHELL_TOKEN.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function quoteArgv(argv) {
  return argv.map((part) => shellQuote(part)).join(" ");
}

export function renderTemplate(value, context) {
  return String(value).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => {
    if (!Object.hasOwn(context, key)) {
      return match;
    }
    return String(context[key]);
  });
}

export function buildAgentInvocation(agentName, agentConfig, context) {
  if (!agentConfig || !Array.isArray(agentConfig.command) || agentConfig.command.length === 0) {
    throw new Error(`Agent "${agentName}" must define a non-empty command array`);
  }

  const promptMode = agentConfig.promptMode ?? "arg";
  if (!["arg", "env", "none", "stdin"].includes(promptMode)) {
    throw new Error(`Agent "${agentName}" has unsupported promptMode "${promptMode}"`);
  }

  const templateContext = {
    ...context,
    agent: agentName,
  };

  const hasPromptPlaceholder = agentConfig.command.some((part) =>
    String(part).includes("{prompt}") || String(part).includes("{promptFile}"),
  );

  const argv = agentConfig.command.map((part) => renderTemplate(part, templateContext));
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(agentConfig.env ?? {})) {
    if (!ENV_KEY.test(key)) {
      throw new Error(`Agent "${agentName}" has invalid env key "${key}"`);
    }
    env[key] = renderTemplate(value, templateContext);
  }

  let stdinFile = null;
  if (!hasPromptPlaceholder) {
    if (promptMode === "arg") {
      argv.push(context.prompt);
    } else if (promptMode === "env") {
      env.AGENTMUX_PROMPT = context.prompt;
    } else if (promptMode === "stdin") {
      stdinFile = context.promptFile;
    }
  }

  return { argv, env, stdinFile };
}

export function buildTmuxShellScript(invocation, context) {
  const notifyBase = [
    process.execPath,
    context.cliPath,
    "--config",
    context.configPath,
    "notify",
    "--run-id",
    context.runId,
    "--agent",
    context.agent,
    "--name",
    context.name,
    "--repo",
    context.repo,
  ];

  const baseEnv = {
    AGENTMUX_AGENT: context.agent,
    AGENTMUX_CONFIG: context.configPath,
    AGENTMUX_NAME: context.name,
    AGENTMUX_NOTIFY_COMMAND: quoteArgv(notifyBase),
    AGENTMUX_PROMPT_FILE: context.promptFile,
    AGENTMUX_REPO: context.repo,
    AGENTMUX_RUN_ID: context.runId,
    AGENTMUX_WORKDIR: context.workdir,
  };

  const exports = shellExportBlock({ ...invocation.env, ...baseEnv });
  const agentCommand =
    quoteArgv(invocation.argv) +
    (invocation.stdinFile ? ` < ${shellQuote(invocation.stdinFile)}` : "");

  const startedNotify = quoteArgv([...notifyBase, "--event", "started", "--message", "started"]);
  const completedNotify = `${quoteArgv([...notifyBase, "--event", "completed", "--exit-code"])} "$status"`;
  const holdOrExit = context.holdOnExit
    ? 'printf "\\nagentmux: holding shell open after exit %s\\n" "$status"; exec "${SHELL:-/bin/sh}"'
    : 'exit "$status"';

  return [
    "#!/bin/sh",
    "set +e",
    exports,
    'printf "agentmux: started %s (%s)\\n" "$AGENTMUX_RUN_ID" "$AGENTMUX_NAME"',
    `${startedNotify} >/dev/null 2>&1 || true`,
    agentCommand,
    "status=$?",
    `${completedNotify} >/dev/null 2>&1 || true`,
    'printf "\\nagentmux: completed %s with exit %s\\n" "$AGENTMUX_RUN_ID" "$status"',
    holdOrExit,
  ].join("\n");
}

export function buildTmuxShellCommand(scriptFile) {
  return quoteArgv(["/bin/sh", scriptFile]);
}

export function shellExportBlock(env) {
  return Object.entries(env)
    .map(([key, value]) => {
      if (!ENV_KEY.test(key)) {
        throw new Error(`Invalid environment variable name "${key}"`);
      }
      return `${key}=${shellQuote(value)}; export ${key}`;
    })
    .join("\n");
}
