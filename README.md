# agentmux

`agentmux` packages a local Pi/iMessage orchestrator pattern:

1. You text a private iMessage/SMS chat.
2. A local macOS daemon polls that chat with a configurable receive command.
3. Pi acts as the orchestrator brain with a clean, generic prompt.
4. Pi can delegate coding work into tmux tabs with configurable agent commands.
5. Subagents report completion through a localhost-only webhook via `agentmux notify`.
6. The daemon sends concise replies back with a configurable send command.

The project is repo-agnostic. It ships no personal context, secrets, phone numbers, or company-specific assumptions. There is intentionally no durable `/loop` feature.

## Install

```bash
npm install -g agentmux
```

For local development:

```bash
npm install
npm link
npm run validate
```

## Prerequisites

- macOS if you want iMessage/SMS integration.
- `tmux` for delegated agent tabs.
- A Pi CLI command that can be invoked non-interactively, configured in `orchestrator.command`.
- A message helper command for receive/send. `agentmux` does **not** hard-code a specific Messages tool. If you use `imsg`, configure it in `config.json`.
- Optional agent CLIs such as `pi`, `codex`, or `claude` for subagents.

## Quick start

Create a config:

```bash
agentmux init
$EDITOR ~/.config/agentmux/config.json
```

Edit placeholders:

- `imessage.chatId` / `imessage.recipient`
- `imessage.receive.command.argv`
- `imessage.send.command.argv`
- `orchestrator.command`
- `agents.*.command`
- `daemon.tokenFile`, `daemon.port`, `session`

Run checks:

```bash
agentmux doctor
```

Start the daemon in the foreground:

```bash
agentmux daemon
```

Install it as a macOS LaunchAgent:

```bash
agentmux install-launch-agent
# unload/remove later:
agentmux uninstall-launch-agent
```

## Config shape

Default config path:

```text
~/.config/agentmux/config.json
```

`agentmux init` writes a starter config with placeholders like:

```json
{
  "session": "agents",
  "stateDir": "~/.local/state/agentmux",
  "imessage": {
    "chatId": "CHAT_ID_OR_PHONE",
    "recipient": "+15555550123",
    "pollMs": 3000,
    "syncLimit": 5,
    "receive": {
      "backend": "command",
      "command": {
        "argv": ["imsg", "history", "--chat-id", "{chatId}", "--limit", "{limit}", "--json"]
      }
    },
    "send": {
      "backend": "command",
      "command": {
        "argv": ["imsg", "send", "--chat-id", "{chatId}", "--text", "{text}", "--json"]
      }
    }
  },
  "daemon": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 47761,
    "tokenFile": "~/.local/state/agentmux/webhook-token"
  },
  "orchestrator": {
    "cwd": "~",
    "command": ["pi", "{prompt}"],
    "promptMode": "arg"
  },
  "agents": {
    "pi": { "command": ["pi", "{prompt}"], "promptMode": "arg" },
    "codex": { "command": ["codex", "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "{prompt}"], "promptMode": "arg" }
  }
}
```

Command arrays are executed without a shell. Placeholders include:

- message IO: `{chatId}`, `{recipient}`, `{limit}`, `{text}`
- agent commands: `{prompt}`, `{promptFile}`, `{repo}`, `{workdir}`, `{name}`, `{runId}`, `{agent}`

Receive commands must print JSON or JSONL messages. Common fields are normalized: `id`, `guid`, `text`, `body`, `is_from_me`, `isFromMe`, `created_at`, `createdAt`, and `attachments`.

## Delegating subagents

Manual launch:

```bash
agentmux launch \
  --repo ~/code/my-app \
  --agent codex \
  --name fix-api \
  --prompt "Fix the API bug. Validate with npm test. Report completion with agentmux notify."
```

Launch from a worktree:

```bash
agentmux launch \
  --repo ~/code/my-app \
  --worktree ~/code/my-app-fix-api \
  --create-worktree \
  --worktree-branch agentmux/fix-api \
  --agent pi \
  --name fix-api \
  --prompt-file prompts/fix-api.md
```

Check status:

```bash
agentmux status
agentmux status --json
```

## Subagent completion webhook

The daemon exposes localhost-only endpoints:

- `GET /health`
- `POST /message`
- `POST /agent-message`

The bearer token is generated at `daemon.tokenFile` with mode `0600`.

Ask subagents to use the helper:

```bash
agentmux notify \
  --from build-agent \
  --reply-mode imessage \
  --idempotency-key "build-agent:job-123:done" \
  --message "Finished the build fix. npm test passed. No blockers."
```

Quiet context update:

```bash
agentmux notify \
  --from build-agent \
  --reply-mode none \
  --idempotency-key "build-agent:job-123:checkpoint-1" \
  --message "Still running tests; no user-visible update needed."
```

If `daemon.enabled` is `false`, `agentmux notify --reply-mode ...` writes the event to stdout instead of posting.

## LaunchAgent

Preview the plist:

```bash
agentmux install-launch-agent --dry-run
```

Install and load:

```bash
agentmux install-launch-agent
```

The generated plist runs:

```text
node <agentmux bin> --config <config path> daemon
```

Logs go to `daemon.logDir`.

## Mock smoke test (no real iMessages)

Use the mock config to exercise the daemon and webhook without sending messages:

```bash
rm -rf /tmp/agentmux-mock
mkdir -p /tmp/agentmux-mock
node ./bin/agentmux.js --config examples/config.mock.json daemon &
DAEMON_PID=$!
sleep 1
node ./bin/agentmux.js --config examples/config.mock.json notify \
  --from smoke \
  --reply-mode imessage \
  --idempotency-key smoke-1 \
  --message "Smoke completion"
sleep 1
cat /tmp/agentmux-mock/outbox.txt
kill "$DAEMON_PID"
```

Tmux smoke:

```bash
node ./bin/agentmux.js --config examples/config.mock.json launch \
  --repo "$PWD" \
  --session agentmux-smoke \
  --agent custom \
  --name smoke \
  --prompt "hello from smoke"
node ./bin/agentmux.js --config examples/config.mock.json status --session agentmux-smoke
```

## Security and privacy

- The completion webhook only binds loopback hosts (`127.0.0.1`, `localhost`, or `::1`).
- Webhook requests require a bearer token read from `daemon.tokenFile`.
- `agentmux` never ships or requires phone numbers, private prompts, tokens, or repo-specific context.
- Command adapters are explicit argv arrays, not shell strings. If you choose to invoke a shell, that is visible in your config.
- Keep config/token file permissions tight and avoid putting secrets in prompts or subagent completion messages.
- The daemon marks existing incoming messages as seen on first start so it does not replay your history.

## Limitations

- No durable `/loop` scheduler.
- Message IO depends on whatever receive/send commands you configure.
- The orchestrator command should be non-interactive. If your Pi command opens a TUI, configure Pi's print/RPC/non-interactive mode instead.
- The daemon is local-first and single-process; it is not a remote multi-user service.

## Examples

- `examples/config.imsg.json`: placeholder `imsg` configuration.
- `examples/config.mock.json`: no-message mock receive/send commands for smoke tests.
- `examples/com.agentmux.daemon.plist`: LaunchAgent plist shape.
- `examples/subagent-completion.md`: completion helper examples.
