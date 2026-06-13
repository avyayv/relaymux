import path from "node:path";

import { resolveStateDir } from "./config.js";
import { expandPath } from "./paths.js";
import { httpJson, readTokenFile } from "./remote.js";

export const CLOUD_BASE_PROTOCOL = "relaymux.cloud-base.v1";

export function resolveCloudBaseConfig(config, { stateDir, env = process.env }: any = {}) {
  const cloudBase = config.cloudBase || {};
  const orchestrator = config.orchestrator || {};
  const resolvedStateDir = stateDir || resolveStateDir(config, env);
  return {
    enabled: Boolean(cloudBase.enabled || orchestrator.backend === "cloud"),
    endpoint: String(cloudBase.endpoint || orchestrator.endpoint || "").replace(/\/+$/, ""),
    tokenFile: expandPath(cloudBase.tokenFile || path.join(resolvedStateDir, "cloud-base-token")),
    sessionId: String(cloudBase.sessionId || cloudBase.session || orchestrator.sessionId || "default"),
    timeoutMs: Number(cloudBase.timeoutMs || orchestrator.timeoutMs || 0),
  };
}

export function resolveOrchestratorBackend(config) {
  const backend = String(config.orchestrator?.backend || "local");
  if (backend === "cloud" || config.cloudBase?.enabled === true) return "cloud";
  if (backend === "local") return "local";
  throw new Error(`Unsupported orchestrator.backend "${backend}"; use "local" or "cloud"`);
}

export async function runCloudBaseOrchestrator(config, { prompt, promptFile, stateDir, configPath, requestId }) {
  const resolved = resolveCloudBaseConfig(config, { stateDir });
  if (!resolved.endpoint) {
    throw new Error("orchestrator.backend=cloud requires cloudBase.endpoint (or orchestrator.endpoint)");
  }

  const token = readTokenFile(resolved.tokenFile);
  const response = await httpJson({
    endpoint: resolved.endpoint,
    path: "/v1/base/turns",
    method: "POST",
    token,
    timeoutMs: resolved.timeoutMs,
    body: {
      protocol: CLOUD_BASE_PROTOCOL,
      sessionId: resolved.sessionId,
      requestId,
      prompt,
      promptFile,
      configPath,
    },
  });

  if (response.ok === false) {
    throw new Error(response.error || "cloud base turn failed");
  }
  return String(response.reply || response.message || "Done.").trim() || "Done.";
}
