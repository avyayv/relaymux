# relaymux

`relaymux` lets you text a local Pi orchestrator over iMessage/SMS and delegate coding agents into `tmux` task sessions.

## Mental model

- **Background service:** iMessage polling, the local webhook, and the orchestrator run as a direct macOS LaunchAgent process. They do **not** run in tmux.
- **Feature sessions:** each worktree/task group gets its own tmux session by default.
- **Agent tabs:** agents launched into the same task group show up as tmux windows/tabs inside that session. relaymux-managed panes/splits are not used.

This means it is safe to kill a feature tmux session:

```bash
tmux kill-session -t <feature-session>
```

The iMessage/background service keeps running and launchd restarts it if it exits.

## Prerequisites

- macOS for the iMessage LaunchAgent flow.
- `node` 20+, `npm`, and `git`.
- `tmux` for feature/task sessions.
- An `imsg` CLI that can read/send Messages.app chats.
- A local orchestrator command, usually `pi`.

## Quickstart

Install from the published repo:

```bash
curl -fsSL https://raw.githubusercontent.com/avyayv/relaymux/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

Or install from a clone:

```bash
git clone https://github.com/avyayv/relaymux.git
cd relaymux
./install.sh
export PATH="$HOME/.local/bin:$PATH"
```

Set up iMessage and the background service:

```bash
relaymux setup
relaymux doctor
relaymux status
```

`relaymux setup` writes:

```text
~/.config/relaymux/config.json
```

and installs a direct LaunchAgent. Check/restart it any time:

```bash
relaymux status-launch-agent
relaymux restart-launch-agent
relaymux status
```

Launch a first feature agent:

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name fix-api \
  --prompt "Fix the API bug, run tests, and report back with relaymux notify."
```

Attach to the feature session shown by `relaymux status`:

```bash
tmux attach -t <feature-session>
```

## Config

Minimal shape:

```json
{
  "version": 1,
  "session": "agents",
  "stateDir": "~/.local/state/relaymux",
  "tmux": {
    "sessionMode": "per-worktree",
    "sessionPrefix": "rmx"
  },
  "daemon": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 47761,
    "tokenFile": "~/.local/state/relaymux/webhook-token",
    "launchAgentLabel": "com.relaymux.daemon",
    "launchMode": "direct",
    "logDir": "~/.local/state/relaymux/logs"
  },
  "imessage": {
    "chatId": "CHAT_ID_OR_PHONE",
    "receive": { "backend": "command", "command": { "argv": ["imsg", "history", "--chat-id", "{chatId}", "--limit", "{limit}", "--json"] } },
    "send": { "backend": "command", "command": { "argv": ["imsg", "send", "--chat-id", "{chatId}", "--text", "{text}", "--json"] } }
  },
  "orchestrator": {
    "cwd": "~",
    "command": ["pi", "--print", "--continue", "{prompt}"],
    "promptMode": "arg"
  },
  "agents": {
    "pi": { "command": ["pi", "{prompt}"], "promptMode": "arg" }
  }
}
```

### Session behavior

Default:

```json
{"tmux": {"sessionMode": "per-worktree", "sessionPrefix": "rmx"}}
```

relaymux derives a deterministic, short, tmux-safe session name from the repo/worktree path plus branch when known. Multiple agents launched from the same worktree reuse that same session unless you pass `--session`.

Escape hatches:

```bash
# Group several agents into the same task session.
relaymux launch --session my-task --repo ~/code/app --agent pi --prompt @prompt.txt

# Use the older shared-session behavior globally.
# config.json
{"tmux": {"sessionMode": "shared"}, "session": "agents"}
```

No relaymux-managed panes/splits are created. Old `tmux.extraWindows` entries with `mode: "pane"` are treated as full windows/tabs in the legacy tmux-daemon path.

## Common commands

```bash
relaymux doctor                 # config, commands, token perms, background mode
relaymux status                 # background service + all relaymux tmux sessions/tabs
relaymux status --session NAME  # filter to one feature session
relaymux status --history       # include old run records whose tabs are gone
relaymux status-launch-agent    # launchd status for the background service
relaymux restart-launch-agent   # regenerate/reload direct LaunchAgent
```

Ask from a terminal:

```bash
relaymux ask "open a subagent in ~/code/my-app to fix the failing test"
```

Notify from a subagent:

```bash
relaymux notify \
  --from fix-api \
  --reply-mode imessage \
  --idempotency-key fix-api-done \
  --message "Finished: fixed the API bug and tests pass."
```

## Uninstall / cleanup

```bash
relaymux uninstall-launch-agent
rm -rf ~/.local/lib/relaymux ~/.local/bin/relaymux
# Optional state/config cleanup:
# rm -rf ~/.local/state/relaymux ~/.config/relaymux
```

Killing feature sessions does not uninstall relaymux:

```bash
tmux kill-session -t <feature-session>
```

## Troubleshooting

### Messages permissions

If receiving/sending fails, open System Settings and grant the terminal/automation host Full Disk Access and Automation permissions for Messages as required by your `imsg` tool. Then run:

```bash
relaymux doctor
relaymux restart-launch-agent
```

### LaunchAgent status/logs

```bash
relaymux status-launch-agent
launchctl print gui/$(id -u)/com.relaymux.daemon
ls ~/.local/state/relaymux/logs
```

The generated LaunchAgent should run `node ... relaymux ... daemon` directly. It should not contain `tmux`, `supervise-tmux`, `TMUX_TMPDIR`, or `RELAYMUX_SESSION`.

### Token file permissions

The webhook token file must not be group/world-readable:

```bash
chmod 600 ~/.local/state/relaymux/webhook-token
relaymux doctor
```

### tmux not found

Install tmux and ensure it is on the PATH seen by your shell:

```bash
brew install tmux
relaymux doctor
```

The background iMessage service can run without tmux, but feature agents need it.

### Config errors

Validate the file exists and is private:

```bash
ls -l ~/.config/relaymux/config.json
relaymux doctor
```

Use `relaymux setup --force` only if you intentionally want to rewrite the config.

## Test without real iMessage

The mock config uses command stubs:

```bash
npm run build
rm -rf /tmp/relaymux-mock
node ./dist/bin/relaymux.js --config examples/config.mock.json daemon --once
```

Launch a harmless feature tab with a mock agent:

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

`relaymux` does not include private prompts, phone numbers, secrets, or repo-specific context. The completion webhook binds to localhost and uses a token file. There is no durable `/loop` feature.
