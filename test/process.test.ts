import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../src/process.js";

test("runCommand executes a simple command", () => {
  const result = runCommand(process.execPath, ["--version"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^v\d+/);
});
