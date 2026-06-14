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
      env.RELAYMUX_PROMPT = context.prompt;
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
  const launchNotification = normalizeLaunchNotification(context.launchNotification);

  const baseEnv = {
    RELAYMUX_AGENT: context.agent,
    RELAYMUX_CONFIG: context.configPath,
    RELAYMUX_NAME: context.name,
    RELAYMUX_NOTIFY_COMMAND: quoteArgv(notifyBase),
    RELAYMUX_PROMPT_FILE: context.promptFile,
    RELAYMUX_REPO: context.repo,
    RELAYMUX_RUN_ID: context.runId,
    RELAYMUX_SESSION: context.session || "",
    RELAYMUX_WORKDIR: context.workdir,
  };

  const exports = shellExportBlock({ ...invocation.env, ...baseEnv });
  const agentCommand =
    quoteArgv(invocation.argv) +
    (invocation.stdinFile ? ` < ${shellQuote(invocation.stdinFile)}` : "");

  const startedNotify = quoteArgv([...notifyBase, "--event", "started", "--message", "started"]);
  const completedNotify = `${quoteArgv([...notifyBase, "--event", "completed", "--exit-code"])} "$status" --message "$completion_message"`;
  const exitNotificationBlock = buildExitNotificationBlock(notifyBase, launchNotification);
  const holdOrExit = context.holdOnExit
    ? 'printf "\\nrelaymux: holding shell open after exit %s\\n" "$status"; exec "${SHELL:-/bin/sh}"'
    : 'exit "$status"';

  return [
    "#!/bin/sh",
    "set +e",
    exports,
    'printf "relaymux: started %s (%s)\\n" "$RELAYMUX_RUN_ID" "$RELAYMUX_NAME"',
    `${startedNotify} >/dev/null 2>&1 || true`,
    agentCommand,
    "status=$?",
    'if [ "$status" -eq 0 ]; then',
    '  completion_message="relaymux run $RELAYMUX_NAME ($RELAYMUX_RUN_ID) completed with exit 0"',
    "else",
    '  completion_message="relaymux run $RELAYMUX_NAME ($RELAYMUX_RUN_ID) failed with exit $status"',
    "fi",
    `${completedNotify} >/dev/null 2>&1 || true`,
    ...exitNotificationBlock,
    'printf "\\nrelaymux: completed %s (%s) with exit %s\\n" "$RELAYMUX_RUN_ID" "$RELAYMUX_NAME" "$status"',
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

function buildExitNotificationBlock(notifyBase, notification) {
  if (notification.onExit === "never") return [];

  const shouldNotifyLines = notification.onExit === "always"
    ? ["relaymux_should_notify=1"]
    : [
        "relaymux_should_notify=0",
        'if [ "$status" -ne 0 ]; then relaymux_should_notify=1; fi',
      ];
  const notifyCommand = `${quoteArgv([...notifyBase, "--event", "completed", "--exit-code"])} "$status" --reply-mode ${shellQuote(notification.replyMode)} --idempotency-key "$relaymux_idempotency_key" --message "$relaymux_auto_message"`;

  return [
    ...shouldNotifyLines,
    'if [ "$relaymux_should_notify" = "1" ]; then',
    "  relaymux_tail=",
    '  if [ "$status" -ne 0 ] && command -v tmux >/dev/null 2>&1 && [ -n "${TMUX_PANE:-}" ]; then',
    `    relaymux_tail="$(tmux capture-pane -pt "$TMUX_PANE" -S -${notification.tailLines} 2>/dev/null | tail -n ${notification.tailLines} | tail -c ${notification.tailBytes})"`,
    "  fi",
    '  if [ -n "$relaymux_tail" ]; then',
    `    relaymux_auto_message="$(printf "%s\\n\\nRecent tmux output (last ${notification.tailLines} lines, ${notification.tailBytes} bytes max):\\n%s" "$completion_message" "$relaymux_tail")"`,
    "  else",
    '    relaymux_auto_message="$completion_message"',
    "  fi",
    '  relaymux_idempotency_key="$RELAYMUX_RUN_ID-exit-$status"',
    `  if ! ${notifyCommand} >/dev/null; then`,
    '    printf "relaymux: exit notification failed for %s (%s) with exit %s\\n" "$RELAYMUX_RUN_ID" "$RELAYMUX_NAME" "$status" >&2',
    "  fi",
    "fi",
  ];
}

function normalizeLaunchNotification(notification: any = {}) {
  const onExit = notification.onExit || "never";
  const replyMode = notification.replyMode || "imessage";
  const tailLines = normalizePositiveInteger(notification.tailLines, 80);
  const tailBytes = normalizePositiveInteger(notification.tailBytes, 4000);

  if (!["never", "failure", "always"].includes(onExit)) {
    throw new Error(`launchNotifications.onExit must be never, failure, or always (got ${JSON.stringify(onExit)})`);
  }
  if (!["imessage", "none"].includes(replyMode)) {
    throw new Error(`launchNotifications.replyMode must be imessage or none (got ${JSON.stringify(replyMode)})`);
  }

  return { onExit, replyMode, tailLines, tailBytes };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}
