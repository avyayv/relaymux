import { spawn } from "node:child_process";

export function runCommandAsync(command: string, args: string[] = [], options: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!settled) child.kill("SIGKILL");
          }, 1000).unref?.();
        }, options.timeoutMs)
      : null;
    timer?.unref?.();

    const append = (which, chunk) => {
      const text = chunk.toString("utf8");
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
      const result = { status: code, signal, stdout, stderr };
      if (timedOut) {
        const error: any = new Error(`${command} timed out after ${options.timeoutMs}ms`);
        Object.assign(error, result);
        finish(reject, error);
        return;
      }
      if (code !== 0 && !options.allowFailure) {
        const error: any = new Error(stderr.trim() || `${command} ${args.join(" ")} exited with ${code}`);
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
