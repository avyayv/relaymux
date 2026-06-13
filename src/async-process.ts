import fs from "node:fs";
import { spawn } from "node:child_process";

export function runCommandAsync(command: string, args: string[] = [], options: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    const timeoutMs = Number(options.timeoutMs || 0);
    const hardTimeoutMs = Number(options.hardTimeoutMs || 0);
    const timeoutMode = options.timeoutMode === "activity" ? "activity" : "wall";
    const activityPaths = Array.isArray(options.activityPaths) ? options.activityPaths.filter(Boolean).map(String) : [];
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutReason = "";
    let timeoutAfterMs = timeoutMs;
    let lastActivityAt = Date.now();
    let lastActivityReason = "process start";
    let lastActivityPathMtimeMs = maxActivityPathMtime(activityPaths);
    let activityTimer = null;
    let wallTimer = null;
    let hardTimer = null;

    const markActivity = (reason) => {
      lastActivityAt = Date.now();
      lastActivityReason = reason;
    };

    const clearTimers = () => {
      if (activityTimer) clearInterval(activityTimer);
      if (wallTimer) clearTimeout(wallTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn(value);
    };

    const killForTimeout = (reason, afterMs) => {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutReason = reason;
      timeoutAfterMs = afterMs;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref?.();
    };

    const refreshActivityPaths = () => {
      const mtimeMs = maxActivityPathMtime(activityPaths);
      if (mtimeMs > lastActivityPathMtimeMs) {
        lastActivityPathMtimeMs = mtimeMs;
        markActivity("activity file updated");
      }
    };

    if (timeoutMs > 0 && timeoutMode === "activity") {
      const intervalMs = Number(options.activityCheckIntervalMs || Math.max(25, Math.min(1000, Math.floor(timeoutMs / 4))));
      activityTimer = setInterval(() => {
        refreshActivityPaths();
        if (Date.now() - lastActivityAt >= timeoutMs) {
          killForTimeout("inactivity", timeoutMs);
        }
      }, intervalMs);
      activityTimer.unref?.();
    } else if (timeoutMs > 0) {
      wallTimer = setTimeout(() => killForTimeout("wall", timeoutMs), timeoutMs);
      wallTimer.unref?.();
    }

    if (hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => killForTimeout("hard", hardTimeoutMs), hardTimeoutMs);
      hardTimer.unref?.();
    }

    const append = (which, chunk) => {
      const text = chunk.toString("utf8");
      markActivity(which);
      if (which === "stdout") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill("SIGTERM");
        const error: any = new Error(`command output exceeded ${maxBuffer} bytes`);
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error: any) => {
      error.stdout = stdout;
      error.stderr = stderr;
      finish(reject, error);
    });

    child.on("close", (status, signal) => {
      const code = status ?? 1;
      const result = {
        status: code,
        signal,
        stdout,
        stderr,
        timedOut,
        timeoutReason,
        timeoutMs: timeoutAfterMs,
        lastActivityAt: new Date(lastActivityAt).toISOString(),
        lastActivityReason,
      };
      if (timedOut) {
        const detail = timeoutReason === "inactivity" ? " without output or activity" : "";
        const error: any = new Error(`${command} timed out after ${timeoutAfterMs}ms${detail}`);
        Object.assign(error, result);
        finish(reject, error);
        return;
      }
      if (code !== 0 && !options.allowFailure) {
        const error: any = new Error(`${command} exited with ${code}`);
        Object.assign(error, result);
        finish(reject, error);
        return;
      }
      finish(resolve, result);
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function maxActivityPathMtime(activityPaths: string[]) {
  let max = 0;
  for (const activityPath of activityPaths) {
    try {
      max = Math.max(max, fs.statSync(activityPath).mtimeMs);
    } catch {}
  }
  return max;
}
