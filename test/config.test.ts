import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, writeDefaultConfig } from "../src/config.js";

test("writeDefaultConfig creates a loadable config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmux-"));
  const configPath = path.join(dir, "config.json");

  writeDefaultConfig(configPath);
  const { config, exists } = loadConfig({ configPath });

  assert.equal(exists, true);
  assert.equal(config.session, "agents");
  assert.equal(config.imessage.receive.backend, "command");
  assert.equal(config.daemon.host, "127.0.0.1");
  assert.ok(config.orchestrator.command);
  assert.ok(config.agents.codex);
});

test("loadConfig merges user agents with defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmux-"));
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
