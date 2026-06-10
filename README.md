# agentmux

`agentmux` lets you text a local Pi orchestrator over iMessage/SMS. The orchestrator can open coding-agent tabs in `tmux`, keep track of them, and send short status updates back to the chat.

It is local-first and repo-agnostic: you bring your own Pi command, message send/receive command, and agent commands.

## Install

```bash
npm install -g agentmux
agentmux init --imsg
```

The imsg setup finds your local `imsg` and `pi` commands, prompts for the Messages chat to use, and writes:

```text
~/.config/agentmux/config.json
```

If you already know the chat id, skip the prompt:

```bash
agentmux init --imsg --chat-id 1
```

`imsg` is the built-in preset. You can still edit the config later to use a different message CLI, as long as receive prints JSON/JSONL messages and send accepts `{text}`.

## Run it

Check your setup:

```bash
agentmux doctor
```

Run the daemon in the foreground:

```bash
agentmux daemon
```

Install it as a macOS LaunchAgent:

```bash
agentmux install-launch-agent
```

Remove it later:

```bash
agentmux uninstall-launch-agent
```

## Open agent tabs manually

```bash
agentmux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name fix-api \
  --prompt "Fix the API bug, run tests, and report back with agentmux notify."
```

See running tabs:

```bash
agentmux status
```

Attach to the tmux session:

```bash
tmux attach -t agents
```

## Report back from a subagent

A subagent can send a completion update to the local daemon:

```bash
agentmux notify \
  --from fix-api \
  --reply-mode imessage \
  --idempotency-key fix-api-done \
  --message "Fixed the API bug. Tests pass."
```

Use `--reply-mode none` for quiet context that should not text the user.

## Test without sending messages

The mock config uses no real iMessage commands:

```bash
rm -rf /tmp/agentmux-mock
node ./bin/agentmux.js --config examples/config.mock.json daemon
```

In another terminal:

```bash
node ./bin/agentmux.js --config examples/config.mock.json notify \
  --from smoke \
  --reply-mode imessage \
  --idempotency-key smoke-1 \
  --message "Smoke test complete"

cat /tmp/agentmux-mock/outbox.txt
```

## Notes

`agentmux` does not include private prompts, phone numbers, secrets, or repo-specific context. The completion webhook binds to localhost and uses a token file. There is no durable `/loop` feature.
