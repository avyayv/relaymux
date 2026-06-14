# Operations

This page covers background service behavior, safety, troubleshooting, and development commands.

## Install Footprint

The install script builds relaymux locally, writes app files under `~/.local/lib/relaymux`, and writes a `relaymux` shim under `~/.local/bin` unless you override the install directories.

Stop the background service and remove the installed binary:

```bash
relaymux uninstall-launch-agent
rm -rf ~/.local/lib/relaymux ~/.local/bin/relaymux
```

Optionally remove local state and config after checking for data you want to keep:

```bash
rm -rf ~/.relaymux
```

## Background Service

The daemon is optional for local launches, but useful for the local API and adapter delivery. On macOS, `relaymux setup`, `relaymux install-launch-agent`, or `relaymux restart-launch-agent` can install it as a per-user LaunchAgent. The daemon runs outside tmux.

```bash
relaymux restart-launch-agent
relaymux status-launch-agent
relaymux uninstall-launch-agent
```

`restart-launch-agent` writes two LaunchAgents on macOS: the main relaymux daemon and a small watchdog. The watchdog runs once a minute, checks the daemon's launchd state plus `/health` on the local API, and bootstraps or kickstarts the daemon if it was killed or left unloaded. Use `--no-watchdog` only when you intentionally want to manage recovery yourself.

Turn on wrapper-level exit notifications if you want a fallback even when the agent forgets to call `relaymux notify`. `failure` means only nonzero exits notify; `always` also notifies on success; `never` is the default:

```bash
relaymux launch --repo ~/code/my-app --agent pi --name risky-task \
  --notify-on-exit failure --notify-reply-mode telegram \
  --prompt @prompt.txt
```

Adapter exit notifications require the daemon and the selected adapter. Local `started` and `completed` run events are still recorded without them.

## Safety Model And Limitations

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

If iMessage/SMS send or receive fails, verify your `imsg` CLI first:

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

Please keep public examples free of private paths, phone numbers, chat ids, tokens, and secrets.
