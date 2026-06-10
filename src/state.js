import fs from "node:fs";
import path from "node:path";

import { ensureDirectory } from "./paths.js";

export function writePromptFile(stateDir, runId, prompt) {
  const dir = path.join(stateDir, "prompts");
  ensureDirectory(dir);
  const file = path.join(dir, `${runId}.txt`);
  fs.writeFileSync(file, prompt);
  return file;
}

export function writeScriptFile(stateDir, runId, script) {
  const dir = path.join(stateDir, "scripts");
  ensureDirectory(dir);
  const file = path.join(dir, `${runId}.sh`);
  fs.writeFileSync(file, script, { mode: 0o700 });
  return file;
}

export function recordRun(stateDir, run) {
  appendJsonl(path.join(stateDir, "runs.jsonl"), run);
}

export function recordEvent(stateDir, event) {
  appendJsonl(path.join(stateDir, "events.jsonl"), event);
}

export function readRuns(stateDir) {
  return readJsonl(path.join(stateDir, "runs.jsonl"));
}

export function readEvents(stateDir) {
  return readJsonl(path.join(stateDir, "events.jsonl"));
}

export function latestEventsByRun(stateDir) {
  const latest = new Map();
  for (const event of readEvents(stateDir)) {
    latest.set(event.runId, event);
  }
  return latest;
}

function appendJsonl(file, value) {
  ensureDirectory(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) {
    return [];
  }

  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
