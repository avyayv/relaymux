# relaymux

`relaymux` coordinates local CLI agents in `tmux` windows and gives them a small local API for status, requests, and completion notifications.

```bash
# Start a visible agent window in the shared tmux session.
relaymux launch --repo ~/code/my-app --agent pi --name fix-tests \
  --prompt "Fix the failing tests, then report back with relaymux notify."

# From inside an agent when the work is done or blocked.
relaymux notify --from fix-tests \
  --message "Done: fixed the tests. Validation: npm test passed."
```

The core product is local: CLI + `tmux` + run state + a loopback HTTP API/webhook. Notification adapters are optional. iMessage/SMS via `imsg` and Telegram via the Bot API are supported as add-ons; neither is required to launch agents, inspect status, or record local notifications.

relaymux is not a model provider, coding agent, IDE, cloud runtime, or general messaging SDK. It is a thin local coordinator for tools you already run in a terminal: `pi`, `codex`, `claude`, `aider`, shell scripts, or any command you add to your config.

## Why relaymux exists

Coding agents are useful, but running more than one usually turns into a pile of terminal tabs, forgotten prompts, and "did that finish?" checks. relaymux keeps the work visible in `tmux`, gives every delegated run a name and local state record, and provides one completion path: `relaymux notify`.

Optional adapters can make those completions user-visible away from the keyboard. iMessage/SMS and Telegram are sibling integrations: configure one, both, or neither.

## Core ideas

An **agent** is just a command template in `~/.relaymux/config.json`. If you configure `pi`, relaymux runs `pi ...`; if you configure `codex`, it runs `codex ...`; if you configure `custom`, it can be any shell command.

A **run** is one `relaymux launch`. By default, relaymux creates a new `tmux` window in one shared session named `agents`. tmux calls these windows; many terminal apps display them like tabs. relaymux does not create panes or splits for agent runs.

The **daemon** is optional for local launches, but useful for the local API and adapter delivery. On macOS, `relaymux setup` can install it as a per-user LaunchAgent. The daemon stays outside `tmux`, accepts local `relaymux ask` and `relaymux notify` requests, and runs your orchestrator command. If the iMessage/SMS adapter is enabled, it also polls the configured `imsg` chat.

The **orchestrator** is also just a command, but it has a different job from an agent. The orchestrator handles inbound requests from the local API or optional adapters; agents do delegated work launched with `relaymux launch`. The orchestrator receives incoming text plus relaymux instructions and prints a reply.

relaymux stores private config, token, run records, prompts, and logs under `~/.relaymux` by default:

```text
~/.relaymux/
  config.json     # private config, written mode 0600
  state/          # daemon state, run records, prompts, scripts, webhook token
  logs/           # LaunchAgent stdout/stderr logs
  tasks/          # optional task scratch space
  reports/        # optional reports
  research/       # optional research notes
```

## Install

Requirements for local agent launches are Node.js 20+, npm, git, and `tmux`. tmux is the terminal multiplexer relaymux uses to keep agent runs visible as attachable sessions and windows.

```bash
curl -fsSL https://raw.githubusercontent.com/avyayv/relaymux/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
relaymux --version
```

Or install from a clone:

```bash
git clone https://github.com/avyayv/relaymux.git
cd relaymux
./install.sh
export PATH="$HOME/.local/bin:$PATH"
```

Optional adapter requirements:

- iMessage/SMS: macOS, Messages signed in on that Mac, SMS forwarding if you want SMS, and an external `imsg` CLI. relaymux shells out to the command you configure; it does not vendor `imsg` or talk to Messages.app directly.
- Telegram: a Telegram bot token and chat id. relaymux sends through the Telegram Bot API and reads the token from an environment variable or token file.

## Try it in two minutes without message adapters

This starts a harmless local run using the built-in default config, which includes a `custom` agent that just prints the prompt. You do not need to run `relaymux setup` first. `--repo` is the working directory for the command; it does not have to be a Git repository unless you use Git-specific features such as `--session-mode per-worktree`. `--hold` keeps the tmux window open after the command exits so you can inspect it.

```bash
mkdir -p /tmp/relaymux-demo
relaymux launch \
  --repo /tmp/relaymux-demo \
  --agent custom \
  --name hello-relaymux \
  --hold \
  --prompt "hello from relaymux"
```

Attach to the shared session:

```bash
tmux attach -t agents
```

In tmux, you should see a window named `hello-relaymux`. Detach with `Ctrl-b d`. Back in your shell:

```bash
relaymux status --history
```

Once that shape makes sense, replace `custom` with a real local agent from your config:

```bash
relaymux launch --repo ~/code/my-app --agent pi --name investigate-api \
  --prompt "Investigate the API failure. When done or blocked, run relaymux notify with a concise summary."
```

## Local API/webhook

The daemon exposes the core integration point on loopback only. `relaymux ask` and `relaymux notify --reply-mode ...` are CLI wrappers over this API.

Default endpoints:

- `GET /health` returns daemon, queue, and webhook status.
- `POST /request` submits a terminal/local request to the orchestrator.
- `POST /message` or `POST /agent-message` submits a subagent completion/update.

Requests to `POST` endpoints require `Authorization: Bearer <token>`, where the token is stored in `~/.relaymux/state/webhook-token` by default. For foreground debugging instead of LaunchAgent, run `relaymux daemon`.

```bash
TOKEN="$(cat ~/.relaymux/state/webhook-token)"
curl -sS -X POST http://127.0.0.1:47761/message \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"from":"build-agent","replyMode":"none","idempotencyKey":"build-agent:job-123:done","text":"Finished; tests passed."}'
```

`replyMode` can be:

| `replyMode` | Behavior |
| --- | --- |
| `none` | Quiet/local context update; no adapter message is sent. |
| `imessage` | Send the orchestrator's user-visible reply through the optional iMessage/SMS adapter. |
| `telegram` | Send the orchestrator's user-visible reply through the optional Telegram adapter. |

## Optional iMessage/SMS adapter

The iMessage/SMS adapter is one optional integration. It uses your configured `imsg` command for both inbound polling and outbound replies. The expected command shapes are `imsg chats --limit <n> --json`, `imsg history --chat-id <id> --limit <n> --json`, and `imsg send --chat-id <id> --text <text> --json`.

```bash
relaymux setup --imsg --chat-id <chat-id-or-phone-number>
relaymux doctor
relaymux status
```

`relaymux setup --imsg` creates `~/.relaymux/config.json`, tries to discover recent `imsg` chats when `--chat-id` is omitted, installs the LaunchAgent unless `--no-launch-agent` is passed, and prints next steps.

After setup, text the configured chat with a small request. Use a chat where your request appears as an incoming message to the Mac's Messages account; messages marked by Messages as sent by that Mac are ignored so relaymux does not respond to its own replies.

Manual user-visible completion:

```bash
relaymux notify \
  --from fix-api \
  --reply-mode imessage \
  --idempotency-key fix-api-20260614-done \
  --message "Finished: fixed the API bug. Validation: npm test passed."
```

## Optional Telegram adapter

The Telegram adapter is outbound notification support through `sendMessage`. It does not poll Telegram for inbound messages.

Create a bot with BotFather, get a chat id for the chat you want to notify, and store the token outside the public config. A token file works well with LaunchAgent because it does not depend on your interactive shell environment:

```bash
mkdir -p ~/.relaymux/secrets
printf '%s\n' '<telegram-bot-token>' > ~/.relaymux/secrets/telegram-bot-token
chmod 600 ~/.relaymux/secrets/telegram-bot-token

relaymux setup --telegram \
  --telegram-chat-id <telegram-chat-id> \
  --telegram-bot-token-file ~/.relaymux/secrets/telegram-bot-token
relaymux doctor
relaymux status
```

You can also use an environment variable instead of a file:

```json
{
  "integrations": {
    "telegram": {
      "enabled": true,
      "chatId": "<telegram-chat-id>",
      "botTokenEnv": "TELEGRAM_BOT_TOKEN",
      "parseMode": ""
    }
  }
}
```

Manual Telegram completion:

```bash
relaymux notify \
  --from fix-api \
  --reply-mode telegram \
  --idempotency-key fix-api-20260614-done \
  --message "Finished: fixed the API bug. Validation: npm test passed."
```

## Configuration

`relaymux init` writes a core config with no message adapters. Command arrays are argv templates; `{prompt}` and `{promptFile}` are substituted at launch time. The Pi commands below are examples, not requirements; edit them to match the agent CLIs you actually use.

```json
{
  "version": 1,
  "session": "agents",
  "stateDir": "~/.relaymux/state",
  "tmux": {
    "sessionMode": "shared"
  },
  "daemon": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 47761,
    "tokenFile": "~/.relaymux/state/webhook-token",
    "launchAgentLabel": "com.relaymux.daemon",
    "watchdog": {
      "enabled": true,
      "intervalSeconds": 60
    },
    "logDir": "~/.relaymux/logs"
  },
  "integrations": {},
  "orchestrator": {
    "cwd": "~",
    "command": ["pi", "--print", "--continue", "--session-dir", "~/.relaymux/state/sessions", "{prompt}"],
    "promptMode": "arg"
  },
  "agents": {
    "pi": { "command": ["pi", "{prompt}"], "promptMode": "arg" },
    "codex": { "command": ["codex", "{prompt}"], "promptMode": "arg" },
    "custom": { "command": ["sh", "-lc", "printf '%s\\n' \"$RELAYMUX_PROMPT\""], "promptMode": "env" }
  }
}
```

Optional adapter config lives under `integrations`:

```json
{
  "integrations": {
    "imessage": {
      "enabled": true,
      "chatId": "<chat-id-or-phone-number>",
      "pollMs": 3000,
      "receive": {
        "backend": "command",
        "command": { "argv": ["imsg", "history", "--chat-id", "{chatId}", "--limit", "{limit}", "--json"] }
      },
      "send": {
        "backend": "command",
        "command": { "argv": ["imsg", "send", "--chat-id", "{chatId}", "--text", "{text}", "--json"] }
      }
    },
    "telegram": {
      "enabled": true,
      "chatId": "<telegram-chat-id>",
      "botTokenFile": "~/.relaymux/secrets/telegram-bot-token",
      "parseMode": ""
    }
  }
}
```

Legacy top-level `imessage` config is still accepted and normalized as `integrations.imessage` at load time.

Prompt passing modes are:

| `promptMode` | Behavior |
| --- | --- |
| `arg` | Append the prompt as a command-line argument unless `{prompt}` is already present. |
| `env` | Put the prompt in `RELAYMUX_PROMPT`. |
| `stdin` | Write the prompt under `~/.relaymux/state/prompts` and pipe that file to stdin. |
| `none` | Do not pass the prompt automatically. |

Use `--prompt @prompt.txt` or `--prompt-file prompt.txt` for longer prompts. The orchestrator follows the same command-template rules as agents: relaymux passes it a prompt, expects a useful final reply on stdout, and treats a nonzero exit as an error to report.

## Common workflows

Launch a named agent in the default shared session:

```bash
relaymux launch --repo ~/code/my-app --agent pi --name fix-api --prompt @prompt.txt
```

Launch into a separate tmux session when you want an isolated group of windows:

```bash
relaymux launch --session release-fix --repo ~/code/my-app --agent codex --prompt @prompt.txt
```

Use per-worktree sessions when each Git worktree should get a stable session name. In this mode, relaymux derives the session from the repo/worktree/branch plus a short hash:

```bash
relaymux launch --session-mode per-worktree --repo ~/code/my-app --agent pi --prompt @prompt.txt
```

Send a local run-log completion from a delegated agent. Local runs still record automatic `started` and `completed` events even without the daemon:

```bash
relaymux notify \
  --from fix-api \
  --message "Finished: fixed the API bug. Validation: npm test passed."
```

Add `--reply-mode none` when the daemon should receive quiet context but no adapter message should be sent. Use `--reply-mode imessage` or `--reply-mode telegram` only when that adapter is configured and you want a user-visible update. Use a stable `--idempotency-key` for one logical update so retries do not send duplicates.

Turn on wrapper-level exit notifications if you want a fallback even when the agent forgets to call `relaymux notify`. `failure` means only nonzero exits notify; `always` also notifies on success; `never` is the default:

```bash
relaymux launch --repo ~/code/my-app --agent pi --name risky-task \
  --notify-on-exit failure --notify-reply-mode telegram \
  --prompt @prompt.txt
```

Inspect local state. `--history` includes old run records whose tmux windows have already exited:

```bash
relaymux status
relaymux status --history
relaymux doctor
relaymux status-launch-agent
```

Manage the background service:

```bash
relaymux restart-launch-agent
relaymux status-launch-agent
relaymux uninstall-launch-agent
```

`restart-launch-agent` writes two LaunchAgents on macOS: the main relaymux daemon and a small watchdog. The watchdog runs once a minute, checks the daemon's launchd state plus `/health` on the local API, and bootstraps/kickstarts the daemon if it was killed or left unloaded. Use `--no-watchdog` only when you intentionally want to manage recovery yourself.

## Safety model and limitations

relaymux is designed for a single user's local machine. The daemon binds to `127.0.0.1` and API requests authenticate with a random token stored under `~/.relaymux/state`. The config file is written with private file permissions.

That does not make arbitrary agents safe. If a local request or adapter message causes your orchestrator to launch `pi`, `codex`, `claude`, or a shell script, that command has the same local permissions it would have if you ran it yourself. Configure relaymux only with adapters and agents you trust, review your agent prompts, and assume prompts, logs, tmux scrollback, and run records may contain sensitive project context.

relaymux is probably the wrong tool if you need a sandbox, a multi-tenant service, durable distributed jobs, a cron/scheduler, hosted model inference, or a web UI. It is also not a general iMessage, SMS, or Telegram library.

## Troubleshooting

If setup says the LaunchAgent is not loaded, reload it from a normal terminal:

```bash
relaymux restart-launch-agent
relaymux status-launch-agent
```

A healthy install should show both the main LaunchAgent and `Watchdog ... loaded`. The checked-in watchdog script is copied to `~/.relaymux/bin/<launch-agent-label>-watchdog.sh`, and its plist lives at `~/Library/LaunchAgents/<launch-agent-label>.watchdog.plist`. Watchdog activity is logged under `~/.relaymux/logs/launch-agent-watchdog.log`.

If iMessage/SMS send/receive fails, verify your `imsg` CLI first:

```bash
imsg chats --limit 5 --json
relaymux doctor
```

You may need to grant the terminal or automation host the macOS permissions required by your message tool, such as Full Disk Access or Messages automation permission.

If Telegram sending fails, verify the chat id, token source, and token file permissions:

```bash
chmod 600 ~/.relaymux/secrets/telegram-bot-token
relaymux doctor
```

If tmux is missing:

```bash
brew install tmux
relaymux doctor
```

If the notify token has loose permissions:

```bash
chmod 600 ~/.relaymux/state/webhook-token
relaymux doctor
```

For a no-adapter smoke test from a clone:

```bash
npm run build
rm -rf /tmp/relaymux-mock
node ./dist/bin/relaymux.js --config examples/config.mock.json daemon --once
node ./dist/bin/relaymux.js --config examples/config.mock.json launch \
  --repo /tmp/relaymux-mock/repo --agent custom --name smoke --prompt "smoke"
node ./dist/bin/relaymux.js --config examples/config.mock.json status --history
```

## Development

```bash
npm ci
npm run validate
```

Issues and pull requests are welcome. Please keep public examples free of private paths, phone numbers, chat ids, tokens, and secrets.

## License

MIT
