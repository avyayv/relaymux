import { spawnSync } from "node:child_process";

export function runCommand(command: string, args: string[] = [], options: any = {}): any {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env || process.env,
    input: options.input,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });

  const status = result.status ?? 1;
  if (result.error && !options.allowFailure) {
    throw result.error;
  }
  if (status !== 0 && !options.allowFailure) {
    const stderr = result.stderr?.trim();
    throw new Error(stderr || `${command} ${args.join(" ")} exited with ${status}`);
  }

  return {
    status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}
