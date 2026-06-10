import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentInvocation,
  quoteArgv,
  renderTemplate,
  shellExportBlock,
  shellQuote,
} from "../src/command.js";

test("shellQuote keeps safe tokens and quotes spaces", () => {
  assert.equal(shellQuote("abc-123_/x"), "abc-123_/x");
  assert.equal(shellQuote("hello world"), "'hello world'");
  assert.equal(shellQuote("can't"), "'can'\\''t'");
});

test("quoteArgv quotes each token independently", () => {
  assert.equal(quoteArgv(["codex", "--prompt", "review api"]), "codex --prompt 'review api'");
});

test("renderTemplate replaces known placeholders only", () => {
  assert.equal(renderTemplate("{agent}:{repo}:{missing}", { agent: "codex", repo: "/r" }), "codex:/r:{missing}");
});

test("buildAgentInvocation renders command templates without duplicate prompt", () => {
  const invocation = buildAgentInvocation("codex", {
    command: ["codex", "{prompt}", "--repo", "{repo}"],
    promptMode: "arg",
  }, {
    prompt: "do work",
    promptFile: "/tmp/prompt",
    repo: "/repo",
  });

  assert.deepEqual(invocation.argv, ["codex", "do work", "--repo", "/repo"]);
  assert.equal(invocation.stdinFile, null);
});

test("buildAgentInvocation supports stdin prompt mode", () => {
  const invocation = buildAgentInvocation("agent", {
    command: ["agent"],
    promptMode: "stdin",
  }, {
    prompt: "do work",
    promptFile: "/tmp/prompt",
  });

  assert.deepEqual(invocation.argv, ["agent"]);
  assert.equal(invocation.stdinFile, "/tmp/prompt");
});

test("shellExportBlock rejects invalid env keys", () => {
  assert.throws(() => shellExportBlock({ "BAD-KEY": "value" }), /Invalid environment/);
});
