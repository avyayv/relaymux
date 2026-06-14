# relaymux

`relaymux` launches local coding-agent commands in visible `tmux` windows and records each run's status and completion updates under `~/.relaymux`.

It is not a model provider, IDE, cloud runtime, or agent framework. It coordinates commands you already run in a terminal, such as `pi`, `codex`, `claude`, `aider`, or a shell script that can work from a prompt.

## Quickstart

You need Node.js 20+, npm, git, and `tmux`. tmux is the terminal multiplexer relaymux uses to keep agent runs visible as attachable sessions and windows. Optional notification adapters such as iMessage/SMS and Telegram are not required for a local launch.

Install relaymux and put the command on your PATH:

```bash
curl -fsSL https://raw.githubusercontent.com/avyayv/relaymux/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
relaymux --version
relaymux setup
relaymux status
```

The installer clones and builds relaymux locally with Node/npm/git, writes app files under `~/.local/lib/relaymux`, and writes a `relaymux` shim under `~/.local/bin`.

`relaymux setup` creates or updates `~/.relaymux/config.json`, installs/restarts the macOS LaunchAgent when supported, and prints the config path, log path, status, and next command. If launchd rejects the service, setup prints the plist path, daemon logs, `launchctl print ...` command, common causes, and the exact retry command.

For a config-only setup without starting the background service, use `relaymux setup --no-launch-agent`. `relaymux init` is the lower-level config writer; it refuses to overwrite an existing config unless you pass `--force`.

The generated config includes a harmless `custom` agent that prints its prompt, which is useful for checking that tmux/status behavior works before wiring a real agent:

```bash
mkdir -p /tmp/relaymux-demo
relaymux launch \
  --repo /tmp/relaymux-demo \
  --agent custom \
  --name hello-relaymux \
  --hold \
  --prompt "hello from relaymux"
```

`--repo` is the command's working directory; it does not need to be a Git repository for this basic launch. `--hold` keeps the tmux window open after the command exits so you can inspect it. relaymux creates the shared tmux session automatically when it launches the first run.

Attach to the shared tmux session:

```bash
tmux attach -t agents
```

In tmux, you should see a window named `hello-relaymux`. Detach with `Ctrl-b d`, then inspect local status:

```bash
relaymux status --history
```

## Use A Real Agent

At minimum, relaymux needs a shared tmux session name and an agent command template in `~/.relaymux/config.json`. An agent command can be interactive or noninteractive; relaymux's job is to start it with the prompt you provide.

```json
{
  "session": "agents",
  "agents": {
    "my-agent": {
      "command": ["my-agent-cli", "--prompt-file", "{promptFile}"]
    }
  }
}
```

The `command` value is a list of command arguments. relaymux replaces `{promptFile}` with the path to the prompt file it writes for the run. Replace `my-agent-cli` with the agent or wrapper command you actually use. The prompt-file style is the simplest path; other prompt-passing modes and placeholders are covered in [Configuration](docs/configuration.md).

Write a prompt file:

```bash
mkdir -p ~/.relaymux/tasks
cat > ~/.relaymux/tasks/first-agent.md <<'EOF'
Read the README, summarize what this project does, and report any unclear setup steps.
EOF
```

A subagent is the command relaymux starts for one run. Launch one from that prompt file:

```bash
relaymux launch \
  --repo ~/code/my-project \
  --agent my-agent \
  --name first-agent \
  --prompt-file ~/.relaymux/tasks/first-agent.md
```

By default this creates a new tmux window in the shared `agents` session. relaymux does not create panes or splits; many terminal UIs display tmux windows like tabs.

Use a separate session only when you explicitly want to isolate a group of windows:

```bash
relaymux launch --session my-task --repo ~/code/my-project --agent my-agent --prompt-file ~/.relaymux/tasks/first-agent.md
```

Inside every launched agent process, relaymux injects `RELAYMUX_NOTIFY_COMMAND`, a shell command string that records local progress or completion updates for that run:

```bash
$RELAYMUX_NOTIFY_COMMAND --message "Finished: checked the README and found no blockers."
```

## Optional Notifications

relaymux works without message adapters. If you want user-visible updates away from the terminal, configure an adapter after the local flow works.

iMessage/SMS through macOS Messages and an external `imsg` CLI:

```bash
relaymux setup --imsg --chat-id <chat-id-or-phone-number>
relaymux status-launch-agent
relaymux status
```

`relaymux setup --imsg` creates or updates `~/.relaymux/config.json`, tries to discover recent `imsg` chats when `--chat-id` is omitted, installs/restarts the LaunchAgent unless `--no-launch-agent` is passed, and prints next steps. Re-running `relaymux init --imsg` or `relaymux setup --imsg` adds or updates the adapter on the existing config; `--force` is only for replacing the whole config.

After setup, text the configured chat with a small request. Use a chat where your request appears as an incoming message to the Mac's Messages account; messages marked by Messages as sent by that Mac are ignored so relaymux does not respond to its own replies.

Telegram through a Telegram bot:

```bash
relaymux setup --telegram \
  --telegram-chat-id <telegram-chat-id> \
  --telegram-bot-token-file ~/.relaymux/secrets/telegram-bot-token
relaymux status-launch-agent
relaymux status
```

Then use `relaymux notify --reply-mode imessage` or `relaymux notify --reply-mode telegram` from an agent when you want an adapter-delivered update. In this command, reply mode means the delivery channel for a user-visible notification.

## Docs

- [Configuration](docs/configuration.md): config shape, prompt passing, sessions, and common launch patterns.
- [Integrations](docs/integrations.md): local HTTP API for agent callbacks, `relaymux ask`, `relaymux notify`, iMessage/SMS, and Telegram.
- [Operations](docs/operations.md): install footprint, uninstall, background service, watchdog, safety model, troubleshooting, and development.

## Development

```bash
npm ci
npm run validate
```

Issues and pull requests are welcome. Please keep public examples free of private paths, phone numbers, chat ids, tokens, and secrets.

## License

MIT
