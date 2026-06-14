# Integrations

relaymux works without message adapters. The core integration point is local: the daemon binds to loopback and accepts authenticated requests from the relaymux CLI helpers.

## Local API And Agent Updates

`relaymux ask` and `relaymux notify --reply-mode ...` are CLI wrappers over the local API. The update endpoints are local callbacks for agents and helper scripts; they are not public webhooks.

Default endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Returns daemon, queue, and local API status. |
| `POST /request` | Submits a terminal/local request to the orchestrator. |
| `POST /message` | Submits a subagent completion or update. |
| `POST /agent-message` | Alias for `POST /message`. |

Requests to `POST` endpoints require `Authorization: Bearer <token>`, where the token is stored in `~/.relaymux/state/webhook-token` by default.

Ask the orchestrator from a terminal:

```bash
relaymux ask "Open an agent in ~/code/my-app to inspect the failing test."
```

Send a local run-log completion from a delegated agent. Local runs still record automatic `started` and `completed` events even without the daemon:

```bash
relaymux notify \
  --from fix-api \
  --message "Finished: fixed the API bug. Validation: npm test passed."
```

Use a stable `--idempotency-key` for one logical update so retries do not send duplicates. Keys are remembered in the daemon state under `~/.relaymux/state`.

## Reply Modes

| `replyMode` | Behavior |
| --- | --- |
| `none` | The daemon passes the update to the orchestrator, but no adapter message is sent. |
| `imessage` | The daemon passes the update to the orchestrator, then sends the orchestrator's user-visible reply through the optional iMessage/SMS adapter. |
| `telegram` | The daemon passes the update to the orchestrator, then sends the orchestrator's user-visible reply through the optional Telegram adapter. |

Use `--reply-mode imessage` or `--reply-mode telegram` only when that adapter is configured and you want a user-visible update.

## Direct HTTP

For foreground debugging instead of LaunchAgent, run `relaymux daemon`. If you cannot use the CLI helper, you can call the local API directly:

```bash
TOKEN="$(cat ~/.relaymux/state/webhook-token)"
curl -sS -X POST http://127.0.0.1:47761/message \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"from":"build-agent","replyMode":"none","idempotencyKey":"build-agent:job-123:done","text":"Finished; tests passed."}'
```

## iMessage/SMS

The iMessage/SMS adapter is optional. It uses your configured `imsg` command for both inbound polling and outbound replies. relaymux shells out to the command you configure; it does not vendor `imsg` or talk to Messages.app directly.

Expected command shapes are `imsg chats --limit <n> --json`, `imsg history --chat-id <id> --limit <n> --json`, and `imsg send --chat-id <id> --text <text> --json`.

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

## Telegram

The Telegram adapter is optional outbound notification support through `sendMessage`. It does not poll Telegram for inbound messages.

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
