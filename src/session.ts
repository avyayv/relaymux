import crypto from "node:crypto";
import path from "node:path";

import { runCommand } from "./process.js";
import { validateSessionName } from "./tmux.js";

const DEFAULT_SESSION_PREFIX = "rmx";
const DEFAULT_SESSION_MODE = "per-worktree";
const MAX_SESSION_NAME_LENGTH = 64;

export function resolveTmuxSessionMode({ flags = {}, config = {} }: any = {}) {
  const rawMode = String(flags.sessionMode || config.tmux?.sessionMode || DEFAULT_SESSION_MODE);
  const mode = rawMode.toLowerCase();
  if (["per-worktree", "worktree", "feature", "per-feature"].includes(mode)) {
    return "per-worktree";
  }
  if (["shared", "session"].includes(mode)) {
    return "shared";
  }
  throw new Error(`Invalid tmux session mode "${rawMode}". Use "per-worktree" or "shared".`);
}

export function resolveLaunchSession({ flags = {}, config = {}, env = {}, repo, workdir }: any) {
  if (flags.session) {
    const session = String(flags.session);
    validateSessionName(session);
    return { session, mode: "explicit", source: "--session" };
  }

  const mode = resolveTmuxSessionMode({ flags, config });
  if (mode === "shared") {
    const session = String(env.RELAYMUX_SESSION || config.session || "agents");
    validateSessionName(session);
    return { session, mode, source: env.RELAYMUX_SESSION ? "RELAYMUX_SESSION" : "config.session" };
  }

  const branch = String(flags.worktreeBranch || detectGitBranch(workdir) || "");
  const session = deriveFeatureSessionName({
    prefix: config.tmux?.sessionPrefix || DEFAULT_SESSION_PREFIX,
    repo,
    workdir,
    branch,
  });
  validateSessionName(session);
  return { session, mode, source: branch ? "worktree/branch" : "worktree/path" };
}

export function deriveFeatureSessionName({ prefix = DEFAULT_SESSION_PREFIX, repo, workdir, branch = "", maxLength = MAX_SESSION_NAME_LENGTH }: any) {
  const repoPath = path.resolve(String(repo || workdir || "."));
  const workdirPath = path.resolve(String(workdir || repo || "."));
  const repoBase = sessionPart(path.basename(repoPath), 18);
  const workdirBase = sessionPart(path.basename(workdirPath), 24);
  const safePrefix = sessionPart(prefix || DEFAULT_SESSION_PREFIX, 12);
  const visiblePath = workdirBase && workdirBase !== repoBase
    ? `${repoBase}-${workdirBase}`
    : (workdirBase || repoBase || "worktree");
  const hint = sessionPart(branch || "", 20);
  const hash = shortHash([repoPath, workdirPath, branch || ""].join("\0"));
  const stem = [safePrefix, visiblePath, hint].filter(Boolean).join("-");
  const suffix = `-${hash}`;
  const maxStemLength = Math.max(1, Number(maxLength || MAX_SESSION_NAME_LENGTH) - suffix.length);
  const trimmedStem = stem.slice(0, maxStemLength).replace(/[-_.]+$/g, "") || safePrefix;
  return `${trimmedStem}${suffix}`;
}

export function detectGitBranch(workdir) {
  if (!workdir) return "";
  const result = runCommand("git", ["-C", String(workdir), "branch", "--show-current"], { allowFailure: true });
  if (result.status !== 0) return "";
  return result.stdout.trim().split(/\r?\n/)[0] || "";
}

function sessionPart(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, maxLength)
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 8);
}
