# Subagent completion examples

Ask delegated agents to report completion through `agentmux notify` instead of sending iMessages directly.

User-visible completion:

```bash
agentmux notify \
  --from build-agent \
  --reply-mode imessage \
  --idempotency-key "build-agent:job-123:done" \
  --message "Finished the build fix. Validation: npm test passed. No blockers."
```

Quiet context-only update:

```bash
agentmux notify \
  --from build-agent \
  --reply-mode none \
  --idempotency-key "build-agent:job-123:checkpoint-1" \
  --message "Still running tests; no user-visible update needed yet."
```

Direct HTTP shape, if you cannot use the CLI helper:

```bash
TOKEN="$(cat ~/.local/state/agentmux/webhook-token)"
curl -sS -X POST http://127.0.0.1:47761/message \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"from":"build-agent","replyMode":"imessage","idempotencyKey":"build-agent:job-123:done","text":"Finished; tests passed."}'
```
