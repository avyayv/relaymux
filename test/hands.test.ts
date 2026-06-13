import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import {
  createHandsDevServer,
  executeHandsTask,
  pollHandsTask,
  postHandsResult,
  resolveWorkspacePath,
} from "../src/hands.js";
import { runOrchestrator } from "../src/orchestrator.js";
import { httpJson, readTokenFile } from "../src/remote.js";

function tmpDir(prefix = "relaymux-hands-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function closeServer(server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function endpointFor(server) {
  const address: any = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("hands workspace paths are scoped under the allowlisted root", async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "note.txt"), "hello");
  const runtime: any = {
    maxCommandOutputBytes: 10000,
    workspaces: [{ name: "app", path: root, read: true, write: false, shell: false }],
  };

  const read = await executeHandsTask({ id: "t1", kind: "readFile", workspace: "app", args: { path: "note.txt" } }, runtime);
  assert.equal(read.ok, true);
  assert.equal(read.text, "hello");

  assert.throws(() => resolveWorkspacePath(runtime.workspaces, "app", "../outside.txt", "read"), /escapes workspace|ENOENT/);

  const shell = await executeHandsTask({ id: "t2", kind: "shell", workspace: "app", args: { command: "pwd" } }, runtime);
  assert.equal(shell.ok, false);
  assert.match(shell.error, /does not allow shell/);

  const writeDenied = await executeHandsTask({ id: "t3", kind: "writeFile", workspace: "app", args: { path: "new.txt", content: "x" } }, runtime);
  assert.equal(writeDenied.ok, false);
  assert.match(writeDenied.error, /does not allow writes/);

  const writeRuntime: any = { ...runtime, workspaces: [{ name: "app", path: root, read: true, write: true, shell: false }] };
  const writeAllowed = await executeHandsTask({ id: "t4", kind: "writeFile", workspace: "app", args: { path: "nested/new.txt", content: "x" } }, writeRuntime);
  assert.equal(writeAllowed.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "nested", "new.txt"), "utf8"), "x");
});

test("hands dev server leases tasks, accepts local results, and persists status", async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, "server-state.json");
  const tokenFile = path.join(dir, "hands-token");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "package.json"), "{\"ok\":true}\n");

  const server = await createHandsDevServer({ host: "127.0.0.1", port: 0, stateFile, tokenFile, io: quietIo() });
  try {
    const endpoint = endpointFor(server);
    const token = readTokenFile(tokenFile);
    const queued = await httpJson({
      endpoint,
      path: "/v1/tasks",
      token,
      body: { kind: "readFile", workspace: "app", args: { path: "package.json" } },
    });

    const runtime: any = {
      endpoint,
      requestTimeoutMs: 5000,
      workerId: "worker-one",
      leaseMs: 5000,
      maxCommandOutputBytes: 10000,
      workspaces: [{ name: "app", path: workspace, read: true, write: false, shell: false }],
    };

    const task = await pollHandsTask(runtime, token);
    assert.equal(task.id, queued.task.id);
    assert.equal(task.status, "leased");

    const result = await executeHandsTask(task, runtime);
    assert.equal(result.ok, true);
    await postHandsResult(runtime, token, task, result);

    const fetched = await httpJson({ endpoint, path: `/v1/tasks/${task.id}`, method: "GET", token });
    assert.equal(fetched.task.status, "succeeded");
    assert.equal(fetched.task.result.text, "{\"ok\":true}\n");
  } finally {
    await closeServer(server);
  }
});

test("leased hands tasks are reclaimable after worker death/lease expiry", async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, "server-state.json");
  const tokenFile = path.join(dir, "hands-token");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "a");

  const server = await createHandsDevServer({ host: "127.0.0.1", port: 0, stateFile, tokenFile, io: quietIo() });
  try {
    const endpoint = endpointFor(server);
    const token = readTokenFile(tokenFile);
    await httpJson({ endpoint, path: "/v1/tasks", token, body: { kind: "readFile", workspace: "app", args: { path: "a.txt" } } });

    const baseRuntime: any = {
      endpoint,
      requestTimeoutMs: 5000,
      leaseMs: 1,
      maxCommandOutputBytes: 10000,
      workspaces: [{ name: "app", path: workspace, read: true, write: false, shell: false }],
    };
    const first = await pollHandsTask({ ...baseRuntime, workerId: "worker-one" }, token);
    assert.equal(first.workerId, "worker-one");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await pollHandsTask({ ...baseRuntime, workerId: "worker-two" }, token);
    assert.equal(second.id, first.id);
    assert.equal(second.workerId, "worker-two");
    assert.notEqual(second.leaseId, first.leaseId);
  } finally {
    await closeServer(server);
  }
});

test("cloud orchestrator backend can post a turn to the dev cloud base endpoint", async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, "server-state.json");
  const tokenFile = path.join(dir, "hands-token");
  const server = await createHandsDevServer({ host: "127.0.0.1", port: 0, stateFile, tokenFile, io: quietIo() });
  try {
    const config: any = {
      ...defaultConfig({ RELAYMUX_HOME: dir }),
      stateDir: path.join(dir, "state"),
      orchestrator: { command: ["definitely-not-used"] },
      cloudBase: { enabled: true, endpoint: endpointFor(server), tokenFile, sessionId: "test-session" },
    };
    const reply = await runOrchestrator(config, {
      prompt: "hello cloud",
      stateDir: path.join(dir, "state"),
      configPath: path.join(dir, "config.json"),
      requestId: "req-cloud-1",
    });

    assert.match(reply, /mock cloud base accepted req-cloud-1/);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.turns[0].sessionId, "test-session");
  } finally {
    await closeServer(server);
  }
});

function quietIo() {
  return {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}
