import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";
import { writeDefaultConfig } from "../src/config.js";

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

function writeTempConfig(name: string) {
  const configPath = tempConfigPath(name);
  fs.rmSync(configPath, { force: true });
  writeDefaultConfig(configPath);
  return configPath;
}

test("start-tmux daemon mode is retired by default", async () => {
  const harness = makeIo();
  const code = await main(["--config", tempConfigPath("retired-start-tmux"), "start-tmux", "--session", "smoke", "--dry-run"], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /daemon mode is retired/);
  assert.match(harness.stderr, /outside tmux/);
});

test("legacy start-tmux dry-run requires explicit opt-in", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    tempConfigPath("legacy-dry-run"),
    "start-tmux",
    "--allow-tmux-daemon",
    "--session",
    "smoke",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# session: smoke/);
  assert.match(harness.stdout, /RELAYMUX_SESSION=smoke/);
  assert.match(harness.stdout, /daemon --session smoke/);
});

test("supervise-tmux daemon mode is retired by default", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    tempConfigPath("retired-supervise-tmux"),
    "supervise-tmux",
    "--session",
    "boot-agents",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /outside tmux/);
});

test("launch dry-run defaults to a per-worktree feature session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo({ RELAYMUX_SESSION: "old-shared" });
  const code = await main([
    "--config",
    writeTempConfig("launch-per-worktree"),
    "launch",
    "--repo",
    dir,
    "--agent",
    "custom",
    "--name",
    "api-fix",
    "--worktree-branch",
    "feature/api-fix",
    "--prompt",
    "noop",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# tmux session: rmx-/);
  assert.match(harness.stdout, /\(per-worktree;/);
  assert.doesNotMatch(harness.stdout, /# tmux session: old-shared/);
});

test("launch dry-run honors explicit session grouping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-explicit-session"),
    "launch",
    "--repo",
    dir,
    "--agent",
    "custom",
    "--name",
    "api-fix",
    "--session",
    "task-group",
    "--prompt",
    "noop",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# tmux session: task-group \(explicit; --session\)/);
});

test("install-launch-agent dry-run runs the daemon directly by default", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-agent-direct"),
    "install-launch-agent",
    "--dry-run",
    "--no-load",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /<string>daemon<\/string>/);
  assert.match(harness.stdout, /daemon\.out\.log/);
  assert.doesNotMatch(harness.stdout, /<string>--session<\/string>/);
  assert.doesNotMatch(harness.stdout, /RELAYMUX_SESSION/);
  assert.doesNotMatch(harness.stdout, /TMUX/);
  assert.doesNotMatch(harness.stdout, /supervise-tmux/);
});

test("install-launch-agent rejects tmux supervisor mode", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-agent-tmux"),
    "install-launch-agent",
    "--mode",
    "tmux",
    "--dry-run",
    "--no-load",
  ], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /tmux mode has been removed/);
});
