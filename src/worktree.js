import fs from "node:fs";

import { expandPath } from "./paths.js";
import { runCommand } from "./process.js";

export function resolveRepoAndWorkdir(flags) {
  if (!flags.repo) {
    throw new Error("Missing --repo <path>");
  }

  const repo = expandPath(flags.repo);
  assertDirectory(repo, "--repo");

  if (!flags.worktree) {
    return { repo, workdir: repo, worktreeAddArgs: null };
  }

  const workdir = expandPath(flags.worktree);
  if (fs.existsSync(workdir)) {
    assertDirectory(workdir, "--worktree");
    return { repo, workdir, worktreeAddArgs: null };
  }

  if (!flags.createWorktree) {
    throw new Error(`Worktree ${workdir} does not exist. Use --create-worktree to create it.`);
  }

  return {
    repo,
    workdir,
    worktreeAddArgs: buildWorktreeAddArgs(repo, workdir, flags),
  };
}

export function createWorktree(args) {
  if (!args) {
    return;
  }
  runCommand("git", args);
}

export function buildWorktreeAddArgs(repo, workdir, flags) {
  const args = ["-C", repo, "worktree", "add"];
  if (flags.worktreeBranch) {
    args.push("-b", flags.worktreeBranch);
  }
  args.push(workdir);
  if (flags.worktreeFrom) {
    args.push(flags.worktreeFrom);
  }
  return args;
}

function assertDirectory(dir, label) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`${label} path does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} path is not a directory: ${dir}`);
  }
}
