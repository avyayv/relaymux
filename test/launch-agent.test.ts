import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { installLaunchAgent, isCurrentLaunchAgent, parseLaunchCtlPrint, renderLaunchAgentPlist, renderLaunchAgentReloadScript } from "../src/launch-agent.js";


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

test("isCurrentLaunchAgent detects inherited launchd service context", () => {
  const config = {
    ...defaultConfig(),
    daemon: {
      ...defaultConfig().daemon,
      launchAgentLabel: "com.example.relaymux",
    },
  };

  assert.equal(isCurrentLaunchAgent(config, { XPC_SERVICE_NAME: "com.example.relaymux" }), true);
  assert.equal(isCurrentLaunchAgent(config, { XPC_SERVICE_NAME: "com.example.other" }), false);
});

test("renderLaunchAgentReloadScript bootouts and bootstraps the main service", () => {
  const script = renderLaunchAgentReloadScript({
    delaySeconds: 15,
    domain: "gui/501",
    helperPlistPath: "/tmp/helper.plist",
    helperTarget: "gui/501/com.example.relaymux.reload.1",
    plistPath: "/tmp/main.plist",
    scriptPath: "/tmp/helper.sh",
    target: "gui/501/com.example.relaymux",
  });

  assert.match(script, /sleep 15/);
  assert.match(script, /launchctl bootout gui\/501\/com.example.relaymux/);
  assert.match(script, /launchctl bootstrap gui\/501 \/tmp\/main.plist/);
  assert.match(script, /com.example.relaymux.reload.1/);
});

test("parseLaunchCtlPrint extracts running status", () => {
  const status = parseLaunchCtlPrint(`state = running\n\tpid = 1234\n\tlast exit code = 0\n`);

  assert.equal(status.state, "running");
  assert.equal(status.pid, 1234);
  assert.equal(status.lastExitCode, "0");
});
