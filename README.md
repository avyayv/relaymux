# relaymux

Text your Mac to launch coding agents in `tmux` windows.

`relaymux` is a small local dispatcher for coding agents. You send a request over iMessage/SMS or from a terminal, a local orchestrator decides what to do, and delegated work runs as visible `tmux` windows you can attach to, inspect, and kill with normal terminal commands.

It is intentionally thin: relaymux does not try to be a model provider, agent runtime, IDE, or full agent platform. Your agents are just commands such as `pi`, `codex`, `claude`, or any custom shell command.

```text
iMessage/SMS or terminal
        │
        ▼
relaymux background daemon ──▶ orchestrator command stdout becomes the reply
        │                              │
        │                              ▼
        │                     relaymux launch
        │                              │
        ▼                              ▼
notify updates ◀────────── tmux window running Pi/Codex/Claude/etc.
```

## Quick start

Install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/avyayv/relaymux/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

Set up the iMessage/SMS adapter and background service:

```bash
relaymux setup
relaymux doctor
relaymux status
```

`relaymux setup` tries to list recent Messages chats through `imsg chats --json` and prompts you to choose one. If discovery does not work, pass the chat id or phone number yourself:

```bash
relaymux setup --chat-id +15555550123
```

Launch a first agent window manually:

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name fix-api \
  --prompt "Fix the API bug, run tests, and report back with relaymux notify."
```

Attach to the shared `tmux` session shown by `relaymux status`. tmux calls these “windows”; many terminal UIs display them like tabs.

```bash
tmux attach -t agents
```

## Mental model

The background daemon runs directly as a macOS LaunchAgent, which is a per-user background service managed by launchd. It polls your configured message source, receives local terminal requests from `relaymux ask`, runs your orchestrator command, and sends replies. It does **not** run inside `tmux`.

The orchestrator is just a command from your config. It receives the incoming request as prompt text, and whatever it prints to stdout becomes the reply. Use a non-interactive command whose stdout is a clean final response; if a CLI mixes logs into stdout, wrap it. If the orchestrator exits nonzero or times out, relaymux sends an error update instead. For orchestrators with `timeoutMs`, the default `timeoutMode` is `activity`: relaymux treats stdout/stderr and known Pi session-file writes as heartbeats, so healthy long turns are not killed by a fixed wall-clock timer.

The default setup uses [Pi](https://github.com/earendil-works/pi) in non-interactive mode. Pi can use shell tools, so it can decide to run `relaymux launch` for longer work. You can replace Pi with any command that accepts a prompt and prints a reply, but that command can only launch delegated agents if it has a way to run shell commands.

relaymux adds its runtime instructions directly to the prompt text passed to the orchestrator. Those instructions tell the orchestrator how to launch delegated work with `relaymux launch` and how delegated agents should report back with `relaymux notify`. You can extend them with `orchestrator.systemPromptFile` or `orchestrator.extraSystemPrompt` in config.

Incoming messages do not need special chat syntax. The daemon polls every few seconds, ignores messages sent by you, and remembers seen message ids so it does not process the same inbound text repeatedly. The orchestrator can answer directly, or it can run `relaymux launch` when the work should happen in a separate terminal.

Agent work runs in `tmux`. By default, every `relaymux launch` creates a new tmux window in one shared session named `agents`. relaymux does not create panes or splits. If you kill the tmux session, you kill those agent windows, but the background daemon keeps running.

Subagents report progress or completion explicitly with `relaymux notify`. That command talks to a localhost-only HTTP endpoint protected by a random token stored in the token file. You normally do not call the endpoint yourself; use `relaymux notify`. Delegated agents should not send iMessages directly.

## Requirements

- macOS for the iMessage/SMS LaunchAgent flow. The Mac must be signed into Messages; SMS also depends on your normal iPhone/Mac SMS forwarding setup.
- Node.js 20+, npm, and git.
- `tmux` for agent windows.
- An external `imsg` CLI installed as `imsg` that supports `chats`, `history`, and `send` commands with JSON output. relaymux does not install or vendor `imsg`; use the Messages.app CLI you already trust, then verify it with `imsg chats --limit 5 --json`.
- At least one local agent/orchestrator command. The generated config assumes `pi` from [Pi](https://github.com/earendil-works/pi), and includes editable templates for `codex` and `claude`; install and authenticate those CLIs separately.

If you only want terminal-launched tmux agents, you can still use `relaymux launch` without the iMessage flow after writing a config.

## Install from a clone

```bash
git clone https://github.com/avyayv/relaymux.git
cd relaymux
./install.sh
export PATH="$HOME/.local/bin:$PATH"
```

## Configuration

`relaymux setup` writes a private config file and managed data under `~/.relaymux`:

```text
~/.relaymux/
  config.json          # private config, mode 0600
  state/               # daemon state, run records, prompts, scripts, webhook token
  logs/                # LaunchAgent stdout/stderr logs
  tasks/               # default generated task scratch
  reports/             # optional generated reports
  research/            # optional generated research notes
  workouts/            # optional generated workout logs
```

New relaymux-managed prompts, run records, completion notes, logs, and generated scratch/research/workout files should live under this home unless you pass an explicit path. The important config parts are the shared tmux session, the background daemon, the message adapters, the orchestrator command, and the agent command templates:

```json
{
  "version": 1,
  "session": "agents",
  "stateDir": "~/.relaymux/state",
  "tmux": {
    "sessionMode": "shared",
    "sessionPrefix": "rmx"
  },
  "daemon": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 47761,
    "tokenFile": "~/.relaymux/state/webhook-token",
    "launchAgentLabel": "com.relaymux.daemon",
    "launchMode": "direct",
    "logDir": "~/.relaymux/logs"
  },
  "imessage": {
    "chatId": "CHAT_ID_OR_PHONE",
    "receive": {
      "backend": "command",
      "command": {
        "argv": ["imsg", "history", "--chat-id", "{chatId}", "--limit", "{limit}", "--attachments", "--convert-attachments", "--json"]
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
    "promptMode": "arg",
    "timeoutMs": 0,
    "timeoutMode": "activity"
  },
  "agents": {
    "pi": {
      "command": ["pi", "{prompt}"],
      "promptMode": "arg"
    },
    "codex": {
      "command": ["codex", "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "{prompt}"],
      "promptMode": "arg"
    },
    "claude": {
      "command": ["claude", "{prompt}"],
      "promptMode": "arg"
    }
  }
}
```

Agent commands are templates. If the command contains `{prompt}` or `{promptFile}`, relaymux substitutes those values. If it does not, `promptMode` decides what to do with the prompt. Valid values are `arg`, `env`, `stdin`, and `none`.

Prompts can be passed inline or read from a file. `--prompt @prompt.txt` means “read the prompt text from `prompt.txt`.” You can also use `--prompt-file prompt.txt`.

## Session behavior

The default is one shared tmux session:

```json
{
  "session": "agents",
  "tmux": { "sessionMode": "shared" }
}
```

That means work from different repos and worktrees appears as windows in the same session unless you ask for a different shape.

Use an explicit session when you want a separate group of windows:

```bash
relaymux launch --session my-task --repo ~/code/app --agent pi --prompt @prompt.txt
```

Use per-worktree sessions when you want deterministic isolation by Git worktree or branch. relaymux derives the session name from the repo/worktree/branch plus a short hash, so repeated launches for the same worktree land in the same named session. If you do not use Git worktrees, you can ignore this mode.

```bash
relaymux launch --session-mode per-worktree --repo ~/code/app --agent pi --prompt @prompt.txt
```

Or make per-worktree sessions the default:

```json
{
  "tmux": {
    "sessionMode": "per-worktree",
    "sessionPrefix": "rmx"
  }
}
```

relaymux-managed panes/splits are not used.

## Common commands

```bash
relaymux doctor                 # check config, home layout, commands, token permissions, and background mode
relaymux status                 # show background service and relaymux-managed tmux windows
relaymux status --session NAME  # filter status to one tmux session
relaymux status --history       # include old run records whose windows are gone
relaymux status-launch-agent    # show launchd status for the background service
relaymux restart-launch-agent   # regenerate and reload the LaunchAgent
relaymux migrate-home --dry-run # inventory old relaymux-owned paths before copying into ~/.relaymux
```

Ask the orchestrator from a terminal:

```bash
relaymux ask "open a subagent in ~/code/my-app to fix the failing test"
```

Notify from a delegated agent:

```bash
relaymux notify \
  --from fix-api \
  --reply-mode imessage \
  --idempotency-key fix-api-done \
  --message "Finished: fixed the API bug and tests pass."
```

`--reply-mode imessage` asks the daemon to send a user-visible text update. `--reply-mode none` still re-prompts the daemon/orchestrator path, but suppresses the outgoing iMessage. Use it for progress notes that should affect the orchestrator's context or logs without texting the user. Whether that context persists depends on your orchestrator command; the default Pi command uses `--continue` with a relaymux session directory.

The idempotency key is a stable de-duplication string for one logical update. If a delegated agent retries the same completion notification, reuse the same key so relaymux does not send duplicate text messages.

## Migrating old relaymux-managed files

New installs use `~/.relaymux`, but older local setups may still have relaymux-owned config/state under `~/.config/relaymux`, `~/.local/state/relaymux`, old `agentmux` paths, `~/.pi/agent/orchestrator-imessage`, or prompt scratch like `~/research/orchestrator-prompts-*`.

Start with an inventory; it prints paths only, never token contents:

```bash
relaymux migrate-home --dry-run
```

If the plan looks right, copy only those relaymux-owned files into `~/.relaymux`:

```bash
relaymux migrate-home --apply
relaymux doctor
relaymux restart-launch-agent
```

`--apply` copies and leaves the original files in place for backcompat. Add `--symlink` only if you want migrated source paths replaced by symlinks after copying. relaymux intentionally does **not** blindly move all of `~/research`, `~/personal`, or other canonical personal directories.

## Cleanup

Stop the background service and remove the installed binary:

```bash
relaymux uninstall-launch-agent
rm -rf ~/.local/lib/relaymux ~/.local/bin/relaymux
```

Optionally remove local state and config after checking for data you want to keep:

```bash
rm -rf ~/.relaymux
# Legacy installs may also have:
# rm -rf ~/.local/state/relaymux ~/.config/relaymux
```

Killing a tmux session only kills the windows in that session:

```bash
tmux kill-session -t agents
```

It does not uninstall relaymux or stop the LaunchAgent.

## Troubleshooting

### Messages permissions

If receive/send fails, grant the terminal or automation host Full Disk Access and Messages Automation permissions required by your `imsg` tool. Then run:

```bash
relaymux doctor
relaymux restart-launch-agent
```

### LaunchAgent status and logs

```bash
relaymux status-launch-agent
launchctl print gui/$(id -u)/com.relaymux.daemon
ls ~/.relaymux/logs
```

The generated LaunchAgent should run `node ... relaymux ... daemon` directly. It should not contain `tmux`, `supervise-tmux`, `TMUX_TMPDIR`, or `RELAYMUX_SESSION`.

### Token file permissions

The local token file stores the random secret used by `relaymux notify` to reach the localhost HTTP endpoint. It must not be group/world-readable:

```bash
chmod 600 ~/.relaymux/state/webhook-token
relaymux doctor
```

### tmux not found

Install tmux and make sure it is on the PATH seen by your shell:

```bash
brew install tmux
relaymux doctor
```

The background service can run without tmux, but agent windows need it.

### Config errors

Check that the config exists and is private:

```bash
ls -l ~/.relaymux/config.json
relaymux doctor
```

Use `relaymux setup --force` only if you intentionally want to rewrite the config.

## Test without real iMessage

The mock config uses fake receive/send commands, so you can test the daemon and tmux launch path without touching Messages.app:

```bash
npm run build
rm -rf /tmp/relaymux-mock
node ./dist/bin/relaymux.js --config examples/config.mock.json daemon --once
```

Launch a harmless mock agent window:

```bash
mkdir -p /tmp/relaymux-mock/repo
node ./dist/bin/relaymux.js --config examples/config.mock.json launch \
  --repo /tmp/relaymux-mock/repo \
  --agent custom \
  --name smoke \
  --prompt "smoke"
node ./dist/bin/relaymux.js --config examples/config.mock.json status
```

## Notes

relaymux does not include private prompts, phone numbers, secrets, or repo-specific context. The notify endpoint binds to localhost and requires the token file.
