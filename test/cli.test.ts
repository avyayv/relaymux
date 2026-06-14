import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";
import { defaultConfig, loadConfig, writeConfig, writeDefaultConfig } from "../src/config.js";

function makeIo(env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const baseEnv = { ...process.env };
  delete baseEnv.RELAYMUX_SESSION;
  return {
    io: {
      env: { ...baseEnv, ...env },
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

function makeExecutable(dir: string, name: string, body = "printf 'fake\\n'") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
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

test("launch dry-run defaults to the shared configured session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-shared"),
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
  assert.match(harness.stdout, /# tmux session: agents \(shared; config\.session\)/);
  assert.doesNotMatch(harness.stdout, /# tmux session: rmx-/);
});

test("launch dry-run honors per-worktree session mode", async () => {
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
    "--session-mode",
    "per-worktree",
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

test("launch dry-run includes opt-in exit notification wrapper", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-notify-on-exit"),
    "launch",
    "--repo",
    dir,
    "--agent",
    "custom",
    "--name",
    "api-fix",
    "--prompt",
    "noop",
    "--notify-on-exit",
    "failure",
    "--notify-reply-mode",
    "imessage",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /relaymux_should_notify=0/);
  assert.match(harness.stdout, /--reply-mode imessage/);
  assert.match(harness.stdout, /--idempotency-key "\$relaymux_idempotency_key"/);
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

test("init --imsg merges adapter into existing config without overwriting core settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-init-merge-"));
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.session = "kept-session";
  config.orchestrator.command = ["custom-orchestrator", "{prompt}"];
  config.agents.local = { command: ["local-agent", "{prompt}"], promptMode: "arg" };
  writeConfig(configPath, config, { force: true });

  const harness = makeIo();
  const code = await main(["--config", configPath, "init", "--imsg", "--chat-id", "chat-1"], harness.io);
  const updated = loadConfig({ configPath }).config;

  assert.equal(code, 0);
  assert.match(harness.stdout, /Updated .* with iMessage\/SMS adapter defaults/);
  assert.doesNotMatch(harness.stdout, /doctor &&/);
  assert.equal(updated.session, "kept-session");
  assert.deepEqual(updated.orchestrator.command, ["custom-orchestrator", "{prompt}"]);
  assert.deepEqual(updated.agents.local.command, ["local-agent", "{prompt}"]);
  assert.equal(updated.integrations.imessage.enabled, true);
  assert.equal(updated.integrations.imessage.chatId, "chat-1");
});

test("init --imsg is idempotent on an existing imsg config without prompting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-init-imsg-idempotent-"));
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.integrations.imessage = {
    enabled: true,
    chatId: "chat-1",
  };
  writeConfig(configPath, config, { force: true });

  const harness = makeIo();
  const code = await main(["--config", configPath, "init", "--imsg"], harness.io);
  const updated = loadConfig({ configPath }).config;

  assert.equal(code, 0);
  assert.equal(harness.stderr, "");
  assert.equal(updated.integrations.imessage.chatId, "chat-1");
});

test("setup --imsg guidance uses separate recovery commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-setup-guidance-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  makeExecutable(binDir, "tmux", "printf 'tmux 3.4\\n'");
  makeExecutable(binDir, "pi");
  makeExecutable(binDir, "imsg");
  const configPath = path.join(dir, "config.json");
  const harness = makeIo({ PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, RELAYMUX_HOME: path.join(dir, "home") });
  const code = await main(["--config", configPath, "setup", "--imsg", "--chat-id", "chat-1", "--no-launch-agent"], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /Updated|Created/);
  assert.match(harness.stdout, /Next: relaymux restart-launch-agent/);
  assert.match(harness.stdout, /Logs:/);
  assert.doesNotMatch(harness.stdout, /doctor && relaymux restart-launch-agent && relaymux status/);
});

test("setup dry-run does not write config or mutate LaunchAgents", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-setup-dry-run-"));
  const configPath = path.join(dir, "config.json");
  const harness = makeIo();
  const code = await main(["--config", configPath, "setup", "--imsg", "--dry-run"], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /Would create config/);
  assert.match(harness.stdout, /Would prompt for iMessage\/SMS chat/);
  assert.equal(fs.existsSync(configPath), false);
});

test("doctor exits zero when only the background service is missing or unsupported", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-doctor-background-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  makeExecutable(binDir, "tmux", "printf 'tmux 3.4\\n'");
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.orchestrator.command = [process.execPath, "--version"];
  config.daemon.launchAgentLabel = `com.relaymux.test.${process.pid}`;
  writeConfig(configPath, config, { force: true });

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  try {
    const harness = makeIo({ PATH: process.env.PATH });
    const code = await main(["--config", configPath, "doctor"], harness.io);

    assert.equal(code, 0);
    if (process.platform === "darwin") {
      assert.match(harness.stdout, /warning\tbackground-service\t/);
      assert.match(harness.stdout, /relaymux restart-launch-agent/);
    } else {
      assert.match(harness.stdout, /ok\tbackground-service\t.*unsupported/);
    }
  } finally {
    process.env.PATH = oldPath;
  }
});
