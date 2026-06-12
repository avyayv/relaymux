import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { installLaunchAgent, parseLaunchCtlPrint, renderLaunchAgentPlist } from "../src/launch-agent.js";


test("renderLaunchAgentPlist escapes XML and includes daemon args", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.relaymux",
    programArguments: ["/bin/node", "/tmp/a&b/relaymux", "daemon"],
    workingDirectory: "/tmp/work",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
  });

  assert.match(plist, /<string>com.example.relaymux<\/string>/);
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
});

test("renderLaunchAgentPlist can include launch environment", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.relaymux",
    programArguments: ["/bin/node", "/tmp/relaymux", "daemon", "--session", "agents"],
    workingDirectory: "/tmp/work",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
    environment: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      RELAYMUX_SESSION: "agents",
    },
  });

  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<key>RELAYMUX_SESSION<\/key>/);
});

test("installLaunchAgent direct dry-run does not invoke tmux or set tmux environment", () => {
  let stdout = "";
  const base = defaultConfig();
  const config = {
    ...base,
    daemon: {
      ...base.daemon,
      environment: {
        TMUX_TMPDIR: "/tmp/should-be-filtered",
        RELAYMUX_SESSION: "should-be-filtered",
      },
    },
  };

  installLaunchAgent({
    flags: { dryRun: true },
    configInfo: { config, path: "/tmp/relaymux-config.json", exists: true },
    binPath: "/tmp/relaymux.js",
    io: {
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: () => {} },
    },
  });

  assert.match(stdout, /<string>daemon<\/string>/);
  assert.doesNotMatch(stdout, /supervise-tmux/);
  assert.doesNotMatch(stdout, /start-tmux/);
  assert.doesNotMatch(stdout, /<string>tmux<\/string>/);
  assert.doesNotMatch(stdout, /TMUX/);
  assert.doesNotMatch(stdout, /RELAYMUX_SESSION/);
});

test("parseLaunchCtlPrint extracts running status", () => {
  const status = parseLaunchCtlPrint(`state = running\n\tpid = 1234\n\tlast exit code = 0\n`);

  assert.equal(status.state, "running");
  assert.equal(status.pid, 1234);
  assert.equal(status.lastExitCode, "0");
});
