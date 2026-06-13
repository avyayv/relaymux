import assert from "node:assert/strict";
import test from "node:test";

import { parseArgv } from "../src/args.js";

test("parseArgv parses command flags and positionals", () => {
  const parsed = parseArgv([
    "launch",
    "--repo",
    "/tmp/repo",
    "--agent=codex",
    "--dry-run",
    "--",
    "extra",
  ]);

  assert.equal(parsed.command, "launch");
  assert.deepEqual(parsed.flags, {
    repo: "/tmp/repo",
    agent: "codex",
    dryRun: true,
  });
  assert.deepEqual(parsed.positionals, ["extra"]);
});

test("parseArgv reports missing values", () => {
  assert.throws(() => parseArgv(["launch", "--repo"]), /Missing value/);
});

test("parseArgv supports global flags before the command", () => {
  const parsed = parseArgv(["--config", "relaymux.json", "doctor"]);

  assert.equal(parsed.command, "doctor");
  assert.deepEqual(parsed.flags, {
    config: "relaymux.json",
  });
});

test("parseArgv recognizes hands safety booleans", () => {
  const parsed = parseArgv(["hands", "run", "--workspace", "app=/repo", "--allow-write", "--allow-shell", "--read-only"]);

  assert.equal(parsed.command, "hands");
  assert.deepEqual(parsed.positionals, ["run"]);
  assert.deepEqual(parsed.flags, {
    workspace: "app=/repo",
    allowWrite: true,
    allowShell: true,
    readOnly: true,
  });
});
