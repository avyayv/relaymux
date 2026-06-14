# relaymux

`relaymux` launches local CLI agents in `tmux` windows and gives them a small, local completion path back to a daemon or run log.

```bash
# Start a visible agent window in the shared tmux session.
relaymux launch --repo ~/code/my-app --agent pi --name fix-tests \
  --prompt "Fix the failing tests, then report back with relaymux notify."

# From inside an agent when the work is done or blocked.
relaymux notify --from fix-tests --reply-mode imessage \
  --idempotency-key fix-tests-20260614-done \
  --message "Done: fixed the tests. Validation: npm test passed."
```

`--reply-mode imessage` is for machines with the optional daemon configured through `relaymux setup`. The iMessage/SMS path uses your configured `imsg` command; relaymux does not talk to Messages.app directly. Without the daemon, relaymux still launches local tmux agent windows and records run state, but it will not send text-message completions.

relaymux is not a model provider, coding agent, IDE, or cloud runtime. It is a thin local coordinator for tools you already run in a terminal: `pi`, `codex`, `claude`, `aider`, shell scripts, or any command you add to your config.

## Why relaymux exists

Coding agents are useful, but running more than one usually turns into a pile of terminal tabs, forgotten prompts, and "did that finish?" checks. relaymux keeps the work visible in `tmux`, gives every delegated run a name and local state record, and provides one completion path: `relaymux notify`.

The optional iMessage/SMS daemon lets you ask your Mac to start or coordinate agent work while you are away from the keyboard. Text the configured chat, the daemon runs your orchestrator command, and the orchestrator can either answer directly or launch longer work into `tmux`.

## Core ideas

An **agent** is just a command template in `~/.relaymux/config.json`. If you configure `pi`, relaymux runs `pi ...`; if you configure `codex`, it runs `codex ...`; if you configure `custom`, it can be any shell command.

A **run** is one `relaymux launch`. By default, relaymux creates a new `tmux` window in one shared session named `agents`. tmux calls these windows; many terminal apps display them like tabs. relaymux does not create panes or splits for agent runs.

The **daemon** is optional. On macOS, `relaymux setup` can install it as a per-user LaunchAgent. The daemon stays outside `tmux`, polls your configured message source, accepts local `relaymux ask` and `relaymux notify` requests, and runs your orchestrator command.

The **orchestrator** is also just a command, but it has a different job from an agent. The orchestrator handles inbound requests from iMessage/SMS or `relaymux ask`; agents do delegated work launched with `relaymux launch`. The orchestrator receives incoming text plus relaymux instructions and prints a reply. The default iMessage setup uses Pi in non-interactive mode, but you can replace it with any command that accepts a prompt and writes a clean final response to stdout.

relaymux stores its private config, token, run records, prompts, and logs under `~/.relaymux` by default:

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

For iMessage/SMS control you also need macOS, Messages signed in on that Mac, normal SMS forwarding if you want SMS, and an `imsg` CLI available as `imsg`. relaymux does not vendor or install `imsg`; it shells out to the message tool you configure. The expected commands are `imsg chats --limit <n> --json`, `imsg history --chat-id <id> --limit <n> --json`, and `imsg send --chat-id <id> --text <text> --json`.

## Try it in two minutes without iMessage

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

## Optional iMessage/SMS setup

The message flow is intentionally local:

```text
iMessage/SMS or relaymux ask
        │
        ▼
relaymux daemon on your Mac ──▶ orchestrator command
        │                              │
        │                              └── may run relaymux launch
        ▼
reply text ◀──────────── relaymux notify from tmux agent windows
```

Run setup on the Mac that will receive and send messages:

```bash
relaymux setup
relaymux doctor
relaymux status
```

`relaymux setup` creates `~/.relaymux/config.json`, tries to discover recent `imsg` chats, installs the LaunchAgent, and prints next steps. The target can be an individual chat, group chat, or phone number understood by your `imsg` tool. If chat discovery is not available or you already know the target chat, pass it explicitly:

```bash
relaymux setup --chat-id <chat-id-or-phone-number>
```

After setup, text the configured chat with a small request. Use a chat where your request appears as an incoming message to the Mac's Messages account; messages marked by Messages as sent by that Mac are ignored so relaymux does not respond to its own replies. The daemon remembers message ids it has already seen, runs the orchestrator, and sends back the orchestrator's stdout as the reply.

You can also send a request to the same daemon from a terminal:

```bash
relaymux ask "Launch an agent in ~/code/my-app to inspect the failing test"
relaymux ask --no-wait --reply-mode imessage "Start a longer refactor and text me when it is delegated"
```

If you do not want a LaunchAgent, you can run the daemon in the foreground for debugging:

```bash
relaymux daemon
```

## Configuration

`relaymux setup` writes a full config, but the important shape is small. Command arrays are argv templates; `{prompt}` and `{promptFile}` are substituted at launch time. The Pi commands below are examples, not requirements; edit them to match the agent CLIs you actually use.

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
    "logDir": "~/.relaymux/logs"
  },
  "imessage": {
    "chatId": "<chat-id-or-phone-number>",
    "pollMs": 3000,
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
  "orchestrator": {
    "cwd": "~",
    "command": ["pi", "--print", "--continue", "--session-dir", "~/.relaymux/state/sessions", "{prompt}"],
    "promptMode": "arg"
  },
  "agents": {
    "pi": {
      "command": ["pi", "{prompt}"],
      "promptMode": "arg"
    },
    "codex": {
      "command": ["codex", "{prompt}"],
      "promptMode": "arg"
    },
    "custom": {
      "command": ["sh", "-lc", "printf '%s\\n' \"$RELAYMUX_PROMPT\""],
      "promptMode": "env"
    }
  }
}
```

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

Send a completion from a delegated agent. Manual notifications with `--reply-mode` require the daemon; local runs still record automatic `started` and `completed` events even without it:

```bash
relaymux notify \
  --from fix-api \
  --reply-mode imessage \
  --idempotency-key fix-api-20260614-done \
  --message "Finished: fixed the API bug. Validation: npm test passed."
```

`--reply-mode imessage` asks the daemon to send a user-visible update to the configured chat. `--reply-mode none` posts the completion to the daemon so the orchestrator can observe it, but suppresses the outgoing text. Use a stable `--idempotency-key` for one logical update so retries do not send duplicates.

Turn on wrapper-level exit notifications if you want a fallback even when the agent forgets to call `relaymux notify`. `failure` means only nonzero exits notify; `always` also notifies on success; `never` is the default:

```bash
relaymux launch --repo ~/code/my-app --agent pi --name risky-task \
  --notify-on-exit failure --notify-reply-mode imessage \
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
relaymux uninstall-launch-agent
```

## Safety model and limitations

relaymux is designed for a single user's local machine. The daemon binds to `127.0.0.1` and `relaymux notify` authenticates to it with a random token stored under `~/.relaymux/state`. The config file is written with private file permissions.

That does not make arbitrary agents safe. If an incoming message causes your orchestrator to launch `pi`, `codex`, `claude`, or a shell script, that command has the same local permissions it would have if you ran it yourself. Configure relaymux only with chats and agents you trust, review your agent prompts, and assume prompts, logs, tmux scrollback, and run records may contain sensitive project context.

relaymux is probably the wrong tool if you need a sandbox, a multi-tenant service, durable distributed jobs, a cron/scheduler, hosted model inference, or a web UI. It is also not a general iMessage library; iMessage/SMS support depends on macOS, Messages.app, and the external `imsg` command you choose.

## Troubleshooting

If setup says the LaunchAgent is not loaded, reload it from a normal terminal:

```bash
relaymux restart-launch-agent
relaymux status-launch-agent
```

If Messages send/receive fails, verify your `imsg` CLI first:

```bash
imsg chats --limit 5 --json
relaymux doctor
```

You may need to grant the terminal or automation host the macOS permissions required by your message tool, such as Full Disk Access or Messages automation permission.

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

For a no-Messages smoke test from a clone:

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

Issues and pull requests are welcome. Please keep public examples free of private paths, phone numbers, chat ids, and secrets.

## License

MIT
