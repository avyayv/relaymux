import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";
import { defaultConfig, writeConfig } from "../src/config.js";
import { validateConfiguredAgentCommand } from "../src/command-validation.js";

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

function writeStaleCodexConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-stale-codex-"));
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.agents.codex.command = ["codex", "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "{prompt}"];
  writeConfig(configPath, config, { force: true });
  return { dir, configPath };
}

test("Codex command validation rejects stale --reasoning-effort", () => {
  const findings = validateConfiguredAgentCommand("codex", {
    command: ["codex", "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "{prompt}"],
    promptMode: "arg",
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].detail, /--reasoning-effort/);
  assert.match(findings[0].detail, /Current Codex CLI rejects/);
});

test("doctor reports stale Codex flags", async () => {
  const { configPath } = writeStaleCodexConfig();
  const harness = makeIo();
  const code = await main(["--config", configPath, "doctor"], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stdout, /error\tagent:codex-command\t.*--reasoning-effort/);
  assert.match(harness.stdout, /Current Codex CLI rejects/);
});

test("launch fails before tmux for stale Codex flags", async () => {
  const { dir, configPath } = writeStaleCodexConfig();
  const harness = makeIo();
  const code = await main([
    "--config",
    configPath,
    "launch",
    "--repo",
    dir,
    "--agent",
    "codex",
    "--name",
    "bad-codex",
    "--prompt",
    "noop",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /Agent "codex" command failed validation/);
  assert.match(harness.stderr, /--reasoning-effort/);
  assert.doesNotMatch(harness.stdout, /tmux session/);
});
