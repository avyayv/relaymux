import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, defaultConfigPath, legacyDefaultConfigPath, loadConfig, writeDefaultConfig } from "../src/config.js";

test("writeDefaultConfig creates a loadable config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-"));
  const configPath = path.join(dir, "config.json");

  writeDefaultConfig(configPath);
  const { config, exists } = loadConfig({ configPath });

  assert.equal(exists, true);
  assert.equal(config.session, "agents");
  assert.equal(config.imessage.receive.backend, "command");
  assert.equal(config.daemon.host, "127.0.0.1");
  assert.equal(config.daemon.launchMode, "direct");
  assert.equal(config.tmux.sessionMode, "shared");
  assert.equal(config.orchestrator.backend, "local");
  assert.equal(config.cloudBase.enabled, false);
  assert.equal(config.cloudHands.enabled, false);
  assert.deepEqual(config.cloudHands.workspaces, []);
  assert.ok(config.orchestrator.command);
  assert.ok(config.agents.codex);
});

test("default paths live under RELAYMUX_HOME when provided", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-home-"));
  const home = path.join(dir, "home");
  const env = { RELAYMUX_HOME: home, XDG_CONFIG_HOME: path.join(dir, "xdg") };
  const config = defaultConfig(env);

  assert.equal(defaultConfigPath(env), path.join(home, "config.json"));
  assert.equal(legacyDefaultConfigPath(env), path.join(dir, "xdg", "relaymux", "config.json"));
  assert.equal(config.stateDir, path.join(home, "state"));
  assert.equal(config.daemon.tokenFile, path.join(home, "state", "webhook-token"));
  assert.equal(config.daemon.logDir, path.join(home, "logs"));
  assert.equal(config.cloudBase.tokenFile, path.join(home, "state", "cloud-base-token"));
  assert.equal(config.cloudHands.tokenFile, path.join(home, "state", "hands-token"));
  assert.equal(config.cloudHands.devServer.stateFile, path.join(home, "state", "hands-dev-server.json"));
});

test("loadConfig falls back to the legacy default config path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-legacy-"));
  const env = { RELAYMUX_HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg") };
  const legacyPath = legacyDefaultConfigPath(env);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({
    session: "legacy",
    stateDir: "~/.local/state/relaymux",
  }));

  const info = loadConfig({ env });

  assert.equal(info.exists, true);
  assert.equal(info.path, legacyPath);
  assert.equal(info.usingLegacyDefault, true);
  assert.equal(info.config.session, "legacy");
  assert.equal(info.config.daemon.tokenFile, "~/.local/state/relaymux/webhook-token");
  assert.equal(info.config.daemon.logDir, "~/.local/state/relaymux/logs");
  assert.equal(info.config.cloudBase.tokenFile, "~/.local/state/relaymux/cloud-base-token");
  assert.equal(info.config.cloudHands.tokenFile, "~/.local/state/relaymux/hands-token");
});

test("loadConfig does not fall back when an explicit config path is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-explicit-"));
  const env = { RELAYMUX_HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg") };
  const legacyPath = legacyDefaultConfigPath(env);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({ session: "legacy" }));

  const explicit = path.join(dir, "missing.json");
  const info = loadConfig({ configPath: explicit, env });

  assert.equal(info.exists, false);
  assert.equal(info.path, explicit);
});

test("loadConfig merges user agents with defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    session: "review",
    agents: {
      local: {
        command: ["local-agent"],
        promptMode: "stdin",
      },
    },
  }));

  const { config } = loadConfig({ configPath });
  assert.equal(config.session, "review");
  assert.ok(config.agents.codex);
  assert.deepEqual(config.agents.local.command, ["local-agent"]);
});
