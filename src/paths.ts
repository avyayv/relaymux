import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandPath(value, cwd = process.cwd()) {
  if (!value) {
    return value;
  }

  let expanded = String(value);
  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  if (!path.isAbsolute(expanded)) {
    expanded = path.resolve(cwd, expanded);
  }
  return expanded;
}

export function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathExists(value) {
  try {
    fs.accessSync(value);
    return true;
  } catch {
    return false;
  }
}

export function readTextFile(file) {
  return fs.readFileSync(file, "utf8");
}
