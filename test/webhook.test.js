import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCompletionBody,
  rememberWebhookIdempotencyKey,
} from "../src/webhook.js";


test("normalizeCompletionBody accepts message aliases", () => {
  const job = normalizeCompletionBody({
    from: "worker",
    message: "done",
    replyMode: "none",
    idempotencyKey: "k1",
    metadata: { runId: "r1" },
  }, "req1", "2026-01-01T00:00:00.000Z");

  assert.equal(job.type, "webhook");
  assert.equal(job.source, "worker");
  assert.equal(job.text, "done");
  assert.equal(job.replyMode, "none");
  assert.equal(job.metadata.runId, "r1");
});

test("normalizeCompletionBody rejects invalid reply mode", () => {
  assert.throws(() => normalizeCompletionBody({ text: "x", replyMode: "loud" }, "req"), /replyMode/);
});

test("rememberWebhookIdempotencyKey suppresses duplicates", () => {
  const state = { seenWebhookIdempotencyKeys: [] };
  assert.deepEqual(rememberWebhookIdempotencyKey(state, "same"), { duplicate: false });
  assert.deepEqual(rememberWebhookIdempotencyKey(state, "same"), { duplicate: true });
  assert.deepEqual(state.seenWebhookIdempotencyKeys, ["same"]);
});
