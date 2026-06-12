import assert from "node:assert/strict";
import test from "node:test";

import { deriveFeatureSessionName, resolveLaunchSession, resolveTmuxSessionMode } from "../src/session.js";

test("deriveFeatureSessionName is deterministic, safe, short, and branch-sensitive", () => {
  const first = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    branch: "feature/api fix",
    name: "fix api",
  });
  const second = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    branch: "feature/api fix",
    name: "fix api",
  });
  const other = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    branch: "feature/other",
    name: "fix api",
  });
  const sameWorktreeDifferentName = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    name: "different agent name",
  });
  const sameWorktreeNoName = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
  });

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(sameWorktreeDifferentName, sameWorktreeNoName);
  assert.match(first, /^[A-Za-z0-9_.-]+$/);
  assert.match(sameWorktreeDifferentName, /^[A-Za-z0-9_.-]+$/);
  assert.ok(first.length <= 64);
});

test("resolveLaunchSession defaults to per-worktree and honors explicit/shared escape hatches", () => {
  const config = { session: "shared-agents", tmux: { sessionMode: "per-worktree", sessionPrefix: "rmx" } };

  const perWorktree = resolveLaunchSession({
    flags: { worktreeBranch: "feature/api" },
    config,
    env: { RELAYMUX_SESSION: "ignored-env" },
    repo: "/tmp/repo",
    workdir: "/tmp/repo-api",
    name: "api",
  });
  assert.equal(perWorktree.mode, "per-worktree");
  assert.notEqual(perWorktree.session, "shared-agents");
  assert.notEqual(perWorktree.session, "ignored-env");

  const explicit = resolveLaunchSession({
    flags: { session: "manual-group" },
    config,
    env: {},
    repo: "/tmp/repo",
    workdir: "/tmp/repo-api",
    name: "api",
  });
  assert.deepEqual(explicit, { session: "manual-group", mode: "explicit", source: "--session" });

  assert.equal(resolveTmuxSessionMode({ config: { tmux: { sessionMode: "shared" } } }), "shared");
});
