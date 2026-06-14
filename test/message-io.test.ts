import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdapterArgv,
  commandSafeMessageText,
  formatIncomingForPrompt,
  isIncomingUserMessage,
  normalizeMessages,
  parseMessageOutput,
  splitMessage,
} from "../src/message-io.js";


test("parseMessageOutput accepts JSON arrays and JSONL", () => {
  assert.deepEqual(parseMessageOutput('[{"id":1,"text":"hi"}]'), [{ id: 1, text: "hi" }]);
  assert.deepEqual(parseMessageOutput('{"id":1,"text":"hi"}\n{"id":2,"text":"there"}\n'), [
    { id: 1, text: "hi" },
    { id: 2, text: "there" },
  ]);
});

test("normalizeMessages maps common iMessage fields", () => {
  const [incoming, outgoing] = normalizeMessages([
    { guid: "a", text: "hello", is_from_me: false, created_at: "now" },
    { guid: "b", body: "sent", direction: "outgoing" },
  ]);

  assert.equal(incoming.id, "a");
  assert.equal(incoming.createdAt, "now");
  assert.equal(isIncomingUserMessage(incoming), true);
  assert.equal(outgoing.isFromMe, true);
  assert.equal(isIncomingUserMessage(outgoing), false);
});

test("buildAdapterArgv renders command placeholders", () => {
  assert.deepEqual(
    buildAdapterArgv({ argv: ["imsg", "send", "--chat-id", "{chatId}", "--text", "{text}"] }, { chatId: "1", text: "hello" }),
    ["imsg", "send", "--chat-id", "1", "--text", "hello"],
  );
});

test("commandSafeMessageText protects dash-leading replies from option parsing", () => {
  assert.equal(commandSafeMessageText("hello"), "hello");
  assert.equal(commandSafeMessageText("- bullet"), "\u200B- bullet");
});

test("formatIncomingForPrompt is generic", () => {
  const text = formatIncomingForPrompt([{ id: "m1", text: "do the thing", isFromMe: false }]);
  assert.match(text, /configured chat/);
  assert.doesNotMatch(text, /Avyay|Dari/);
});

test("splitMessage chunks long text", () => {
  assert.deepEqual(splitMessage("hello", 10), ["hello"]);
  assert.ok(splitMessage("one two three four", 8).length > 1);
});
