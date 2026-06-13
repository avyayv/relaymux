import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommandAsync } from "../src/async-process.js";

test("runCommandAsync wall timeout rejects", async () => {
  await assert.rejects(
    runCommandAsync(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { timeoutMs: 50 }),
    /timed out after 50ms/,
  );
});

test("runCommandAsync activity timeout resets on stdout", async () => {
  const script = `let n = 0;
const timer = setInterval(() => {
  console.log('tick');
  n += 1;
  if (n === 3) {
    clearInterval(timer);
    setTimeout(() => process.exit(0), 50);
  }
}, 50);`;

  const result = await runCommandAsync(process.execPath, ["-e", script], {
    timeoutMs: 200,
    timeoutMode: "activity",
    activityCheckIntervalMs: 20,
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /tick/);
});

test("runCommandAsync activity timeout resets on watched file changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-activity-"));
  const activityFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(activityFile, "");
  const script = `const fs = require('node:fs');
const file = process.argv[1];
let n = 0;
const timer = setInterval(() => {
  fs.appendFileSync(file, '.');
  n += 1;
  if (n === 4) {
    clearInterval(timer);
    setTimeout(() => process.exit(0), 50);
  }
}, 50);`;

  const result = await runCommandAsync(process.execPath, ["-e", script, activityFile], {
    timeoutMs: 200,
    timeoutMode: "activity",
    activityPaths: [activityFile],
    activityCheckIntervalMs: 20,
  });

  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(activityFile, "utf8"), "....");
});

test("runCommandAsync activity timeout rejects when idle", async () => {
  await assert.rejects(
    runCommandAsync(process.execPath, ["-e", "setTimeout(() => {}, 500)"], {
      timeoutMs: 50,
      timeoutMode: "activity",
      activityCheckIntervalMs: 10,
    }),
    (error: any) => {
      assert.match(error.message, /timed out after 50ms without output or activity/);
      assert.equal(error.timedOut, true);
      assert.equal(error.timeoutReason, "inactivity");
      assert.equal(error.lastActivityReason, "process start");
      return true;
    },
  );
});

test("runCommandAsync nonzero error omits command arguments", async () => {
  await assert.rejects(
    runCommandAsync(process.execPath, ["-e", "process.exit(7)", "secret-argument"], {}),
    (error: any) => {
      assert.equal(error.message, `${process.execPath} exited with 7`);
      assert.doesNotMatch(error.message, /secret-argument/);
      return true;
    },
  );
});
