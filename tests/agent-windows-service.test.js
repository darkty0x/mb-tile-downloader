import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildUnlimitedExecutionTimeArgs,
  buildSchtasksCreateArgs,
  buildWindowsAgentWrapper,
  installWindowsAgentService,
} from "../src/agent/windows-agent-service.js";

test("windows agent service wrapper runs the dashboard agent in a restart loop", () => {
  const wrapper = buildWindowsAgentWrapper({
    projectDir: "C:\\mb-tile-downloader",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    restartDelaySeconds: 7,
  });

  assert.match(wrapper, /cd \/d "C:\\mb-tile-downloader"/);
  assert.match(wrapper, /chcp 65001 >nul/);
  assert.match(wrapper, /"C:\\Program Files\\nodejs\\node.exe" --env-file-if-exists=.env src\\agent\\agent.js/);
  assert.match(wrapper, /timeout \/t 7 \/nobreak >nul/);
  assert.match(wrapper, /goto loop/);
});

test("windows agent service creates an on-startup SYSTEM scheduled task", () => {
  assert.deepEqual(
    buildSchtasksCreateArgs({
      taskName: "PTG Dashboard Agent",
      wrapperPath: "C:\\mb-tile-downloader\\.tile-state\\run-dashboard-agent.cmd",
    }),
    [
      "/Create",
      "/TN",
      "PTG Dashboard Agent",
      "/SC",
      "ONSTART",
      "/TR",
      "C:\\mb-tile-downloader\\.tile-state\\run-dashboard-agent.cmd",
      "/F",
      "/RU",
      "SYSTEM",
      "/RL",
      "HIGHEST",
    ]
  );
});

test("windows agent service removes execution time limit after creating the task", () => {
  const args = buildUnlimitedExecutionTimeArgs({ taskName: "PTG Dashboard Agent" });
  const command = args.at(-1);

  assert.equal(args[0], "-NoProfile");
  assert.match(command, /ExecutionTimeLimit = 'PT0S'/);
  assert.match(command, /DisallowStartIfOnBatteries = \$false/);
  assert.match(command, /StopIfGoingOnBatteries = \$false/);
});

test("windows agent service install stops previous task recreates it and starts it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-windows-service-"));
  const calls = [];

  const result = await installWindowsAgentService({
    projectDir: dir,
    nodePath: "C:\\node\\node.exe",
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "SUCCESS", stderr: "" };
    },
  });

  assert.deepEqual(calls.map((call) => call.command), [
    "schtasks.exe",
    "schtasks.exe",
    "schtasks.exe",
    "powershell.exe",
    "schtasks.exe",
  ]);
  assert.deepEqual(calls[0].args.slice(0, 4), ["/End", "/TN", "PTG Dashboard Agent"]);
  assert.deepEqual(calls[1].args.slice(0, 4), ["/Delete", "/TN", "PTG Dashboard Agent", "/F"]);
  assert.equal(calls[2].args.includes("/SC"), true);
  assert.equal(calls[2].args.includes("ONSTART"), true);
  assert.match(calls[3].args.at(-1), /ExecutionTimeLimit = 'PT0S'/);
  assert.deepEqual(calls[4].args.slice(0, 4), ["/Run", "/TN", "PTG Dashboard Agent"]);
  assert.equal(result.started, true);
  assert.match(await readFile(result.wrapperPath, "utf8"), /src\\agent\\agent.js/);
});
