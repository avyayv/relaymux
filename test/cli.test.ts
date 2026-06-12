import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";

function makeIo(env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      env: { ...process.env, ...env },
      stdin: { isTTY: false },
      stdout: { isTTY: false, write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function tempConfigPath(name: string) {
  return path.join(os.tmpdir(), `relaymux-${process.pid}-${name}.json`);
}

test("start-tmux requires an explicit session", async () => {
  const harness = makeIo();
  const code = await main(["--config", tempConfigPath("missing-session"), "start-tmux", "--dry-run"], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /Missing --session <name>/);
});

test("start-tmux dry-run uses the explicit session", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    tempConfigPath("dry-run"),
    "start-tmux",
    "--session",
    "smoke",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# session: smoke/);
  assert.match(harness.stdout, /RELAYMUX_SESSION=smoke/);
  assert.match(harness.stdout, /daemon --session smoke/);
});

test("supervise-tmux dry-run uses the configured session", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    tempConfigPath("supervise-dry-run"),
    "supervise-tmux",
    "--session",
    "boot-agents",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# session: boot-agents/);
  assert.match(harness.stdout, /RELAYMUX_SESSION=boot-agents/);
  assert.match(harness.stdout, /daemon --session boot-agents/);
});
