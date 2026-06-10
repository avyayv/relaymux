import { recordEvent } from "./state.js";
import { renderTemplate } from "./command.js";
import { runCommand } from "./process.js";

export async function handleNotify({ flags, positionals, config, stateDir, io }) {
  const runId = flags.runId || process.env.AGENTMUX_RUN_ID;
  if (!runId) {
    throw new Error("Missing --run-id, and AGENTMUX_RUN_ID is not set");
  }

  const event = {
    time: new Date().toISOString(),
    runId,
    event: flags.event || "message",
    exitCode: flags.exitCode === undefined ? undefined : Number(flags.exitCode),
    message: flags.message || positionals.join(" "),
    agent: flags.agent,
    name: flags.name,
    repo: flags.repo,
  };

  recordEvent(stateDir, event);
  await dispatchNotifiers(config, event, io);
  io.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function dispatchNotifiers(config, event, io) {
  const command = config.notifier?.command;
  if (command?.enabled) {
    if (!Array.isArray(command.argv) || command.argv.length === 0) {
      io.stderr.write("agentmux notify: command notifier enabled but argv is empty\n");
    } else {
      const argv = command.argv.map((part) => renderTemplate(part, eventTemplateContext(event)));
      const result = runCommand(argv[0], argv.slice(1), { allowFailure: true });
      if (result.status !== 0) {
        io.stderr.write(`agentmux notify: command notifier failed with ${result.status}\n`);
      }
    }
  }

  const webhook = config.notifier?.webhook;
  if (webhook?.enabled) {
    if (!webhook.url) {
      io.stderr.write("agentmux notify: webhook notifier enabled but url is empty\n");
      return;
    }
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(webhook.headers || {}),
        },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        io.stderr.write(`agentmux notify: webhook returned ${response.status}\n`);
      }
    } catch (error) {
      io.stderr.write(`agentmux notify: webhook failed: ${error.message}\n`);
    }
  }
}

function eventTemplateContext(event) {
  return {
    event: event.event || "",
    exitCode: event.exitCode ?? "",
    message: event.message || "",
    runId: event.runId || "",
    agent: event.agent || "",
    name: event.name || "",
    repo: event.repo || "",
    time: event.time || "",
  };
}
