# relaymux

`relaymux` lets you text a local Pi orchestrator over iMessage/SMS. The orchestrator can open coding-agent tabs in `tmux`, keep track of them, and send short status updates back to the chat.

It is local-first and repo-agnostic: you bring your own Pi command, message send/receive command, and agent commands.

## Install

Install with the standalone shell installer:

```bash
curl -fsSL https://raw.githubusercontent.com/avyayv/relaymux/main/install.sh | bash
relaymux setup
```

Or from this checkout:

```bash
./install.sh
relaymux setup
```

The installer builds relaymux locally and writes a shim to `~/.local/bin/relaymux`. It requires `node`, the project build tooling, and `git` when installing via curl.

`relaymux setup` finds your local `imsg` and `pi` commands, prompts for the Messages chat to use, writes the config, installs a macOS LaunchAgent, and runs `relaymux doctor`. The LaunchAgent starts a small supervisor at login; the supervisor keeps the relaymux daemon inside `tmux` so it can create and manage agent windows normally.

It writes:

```text
~/.config/relaymux/config.json
```

If you already know the chat id, skip the prompt:

```bash
relaymux setup --chat-id 1
```

`imsg` is the built-in preset. You can still edit the config later to use a different message CLI, as long as receive prints JSON/JSONL messages and send accepts `{text}`.

## Run it

Check your setup any time:

```bash
relaymux doctor
```

If you skipped the LaunchAgent with `relaymux setup --no-launch-agent`, run the daemon in the foreground:

```bash
relaymux daemon
```

Or run it inside a tmux session. The tmux session name is required and is also used as the runtime default for delegated subagents:

```bash
relaymux start-tmux --session my-agents
```

This creates the tmux session if needed, starts the daemon in a `relaymux-daemon` window, and stops the configured macOS LaunchAgent first if one is loaded. Use `--keep-launch-agent` if you do not want that.

You can also ask `start-tmux` to start additional long-running windows by adding `tmux.extraWindows` to the config:

```json
{
  "tmux": {
    "extraWindows": [
      {
        "name": "sidecar",
        "mode": "pane",
        "cwd": "~",
        "command": ["sh", "-lc", "echo sidecar && sleep 3600"]
      }
    ]
  }
}
```

Install it as a macOS LaunchAgent. By default this supervises `start-tmux` using `config.session` and restarts the tmux daemon window if it disappears:

```bash
relaymux install-launch-agent
```

If you really want launchd to run the daemon directly instead of supervising tmux, set `daemon.launchMode` to `"direct"` in the config before installing.

Remove it later:

```bash
relaymux uninstall-launch-agent
```

## Ask the orchestrator from a terminal

Send the same orchestrator a local request without texting it:

```bash
relaymux ask "open a pi subagent in ~/code/my-app to fix the API bug"
```

By default this waits and prints the orchestrator reply. Use `--no-wait` to enqueue and return immediately, or `--reply-mode imessage` if you also want the final status texted back.

## Open agent tabs manually

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name fix-api \
  --prompt "Fix the API bug, run tests, and report back with relaymux notify."
```

See running tmux windows:

```bash
relaymux status
```

Include old run records whose tmux windows are gone:

```bash
relaymux status --history
```

Attach to the tmux session you chose:

```bash
tmux attach -t my-agents
```

## Report back from a subagent

A subagent can send a completion update to the local daemon:

```bash
relaymux notify \
  --from fix-api \
  --reply-mode imessage \
  --idempotency-key fix-api-done \
  --message "Fixed the API bug. Tests pass."
```

Use `--reply-mode none` for quiet context that should not text the user.

## Test without sending messages

The mock config uses no real iMessage commands:

```bash
npm run build
rm -rf /tmp/relaymux-mock
node ./dist/bin/relaymux.js --config examples/config.mock.json daemon
```

In another terminal:

```bash
node ./dist/bin/relaymux.js --config examples/config.mock.json notify \
  --from smoke \
  --reply-mode imessage \
  --idempotency-key smoke-1 \
  --message "Smoke test complete"

cat /tmp/relaymux-mock/outbox.txt
```

## Notes

`relaymux` does not include private prompts, phone numbers, secrets, or repo-specific context. The completion webhook binds to localhost and uses a token file. There is no durable `/loop` feature.
