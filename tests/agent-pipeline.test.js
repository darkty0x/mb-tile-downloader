import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDashboardStore } from "../dashboard/src/server/store.js";
import { runCommand } from "../src/agent/agent.js";
import { createJobReporter } from "../src/agent/job-reporter.js";
import { createProcessRunner, resolveManagedCommand } from "../src/agent/process-runner.js";
import { createCliJobReporterFactory, parseStorjProofFromLine, runRangePipeline, stageArgs } from "../src/agent/pipeline.js";

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("dashboard command queue rejects unknown commands", () => {
  const store = createDashboardStore();

  const queued = store.queueCommand({
    machineId: "worker-a",
    commandType: "git_pull_restart",
    payload: {},
  });
  assert.equal(queued.commandType, "git_pull_restart");

  assert.throws(
    () =>
      store.queueCommand({
        machineId: "worker-a",
        commandType: "rm -rf",
        payload: {},
      }),
    /unsupported command/
  );
});

test("process runner resolves only whitelisted commands", () => {
  const start = resolveManagedCommand({
    commandType: "start_pipeline",
    payload: { configPath: "configs/a.json", command: "rm -rf ." },
  });
  const preflight = resolveManagedCommand({
    commandType: "run_preflight",
    payload: { configPath: "configs/a.json" },
  });
  const updateRestart = resolveManagedCommand({
    commandType: "git_pull_restart",
    payload: { command: "rm -rf ." },
  });
  const writeConfig = resolveManagedCommand({
    commandType: "write_config",
    payload: { configPath: "configs/a.json", configText: "{}" },
  });
  const clearAgentLog = resolveManagedCommand({
    commandType: "clear_agent_log",
    payload: {},
  });

  assert.equal(start.command, process.execPath);
  assert.deepEqual(start.args, ["src/agent/pipeline.js", "configs/a.json"]);
  assert.equal(preflight.command, process.execPath);
  assert.deepEqual(preflight.args, ["src/agent/preflight.js", "configs/a.json"]);
  assert.equal(updateRestart.command, "agent-internal");
  assert.deepEqual(updateRestart.args, ["git_pull_restart"]);
  assert.equal(writeConfig.command, "agent-internal");
  assert.deepEqual(writeConfig.args, ["write_config"]);
  assert.equal(clearAgentLog.command, "agent-internal");
  assert.deepEqual(clearAgentLog.args, ["clear_agent_log"]);
  assert.throws(
    () => resolveManagedCommand({ commandType: "shell", payload: { command: "echo bad" } }),
    /unsupported command/
  );
});

test("process runner preserves ordered config paths for pipeline commands", () => {
  const start = resolveManagedCommand({
    commandType: "start_pipeline",
    payload: { configPaths: ["configs/second.json", "configs/first.json"] },
  });
  const resume = resolveManagedCommand({
    commandType: "resume_pipeline",
    payload: { configPaths: ["configs/b.json", "configs/a.json"] },
  });

  assert.deepEqual(start.args, ["src/agent/pipeline.js", "configs/second.json", "configs/first.json"]);
  assert.deepEqual(resume.args, ["src/agent/pipeline.js", "configs/b.json", "configs/a.json"]);
});

test("dashboard config reporter id comes from each selected config path", async () => {
  const posts = [];
  const client = {
    postJob: async (job) => posts.push(job),
    updateJob: async () => {},
  };
  const env = {
    DASHBOARD_URL: "https://dashboard.example",
    AGENT_TOKEN: "agent-token",
    MACHINE_ID: "server-02",
    DASHBOARD_CONFIG_ID: "stale-active-config",
  };

  const firstFactory = createCliJobReporterFactory({
    env,
    configPath: ".tile-state/dashboard/configs/cfg-first.json",
    client,
    idGenerator: () => "job-1",
  });
  const secondFactory = createCliJobReporterFactory({
    env,
    configPath: ".tile-state/dashboard/configs/cfg-second.json",
    client,
    idGenerator: () => "job-2",
  });

  await firstFactory({ rangeIndex: 0, range: { label: "r1" } }).start({ stage: "download" });
  await secondFactory({ rangeIndex: 0, range: { label: "r1" } }).start({ stage: "download" });

  assert.deepEqual(posts.map((job) => [job.configId, job.jobId]), [
    ["cfg-first", "cfg-first:range-0:job-1"],
    ["cfg-second", "cfg-second:range-0:job-2"],
  ]);
});

test("agent git pull restart trusts the managed project directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-git-safe-"));
  const binDir = path.join(dir, "bin");
  const projectDir = path.join(dir, "project");
  const gitLogPath = path.join(dir, "git-args.txt");
  await mkdir(binDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const gitPath = path.join(binDir, "git");
  await writeFile(
    gitPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" > ${JSON.stringify(gitLogPath)}`,
      `if [ \"$1\" = \"-c\" ] && [ \"$2\" = \"safe.directory=${projectDir}\" ] && [ \"$3\" = \"pull\" ] && [ \"$4\" = \"--ff-only\" ]; then`,
      "  echo pull-ok",
      "  exit 0",
      "fi",
      "echo \"fatal: detected dubious ownership in repository\" >&2",
      "exit 128",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const calls = [];
  const client = {
    ackCommand: async (commandId, payload = {}) => calls.push(["ack", commandId, payload.error || null]),
    postEvent: async (event) => calls.push(["event", event.severity, event.type, event.message]),
  };
  const runner = {
    restartActiveAfter: async (task) => {
      await task();
      return { restarted: false };
    },
  };
  const restartRequests = [];
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
  try {
    await runCommand(
      {
        id: "cmd-git",
        commandType: "git_pull_restart",
        payload: {},
        claimedAt: "claim-git",
      },
      {
        client,
        runner,
        machineId: "worker-a",
        projectDir,
        requestAgentRestart: (request) => restartRequests.push(request),
      }
    );
  } finally {
    process.env.PATH = originalPath;
  }

  assert.equal(await readFile(gitLogPath, "utf8"), `-c safe.directory=${projectDir} pull --ff-only\n`);
  assert.deepEqual(calls, [
    ["event", "success", "command.accepted", "Git pull completed; agent is restarting."],
    ["ack", "cmd-git", null],
  ]);
  assert.deepEqual(restartRequests, [{ when: "now", commandId: "cmd-git", reinstallInstalledAgent: true }]);
});

test("agent git pull restart defers agent reload while managed command is active", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-git-idle-"));
  const binDir = path.join(dir, "bin");
  const projectDir = path.join(dir, "project");
  await mkdir(binDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const gitPath = path.join(binDir, "git");
  await writeFile(
    gitPath,
    [
      "#!/bin/sh",
      `if [ \"$1\" = \"-c\" ] && [ \"$2\" = \"safe.directory=${projectDir}\" ] && [ \"$3\" = \"pull\" ] && [ \"$4\" = \"--ff-only\" ]; then`,
      "  echo pull-ok",
      "  exit 0",
      "fi",
      "exit 128",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const calls = [];
  const client = {
    ackCommand: async (commandId, payload = {}) => calls.push(["ack", commandId, payload.error || null]),
    postEvent: async (event) => calls.push(["event", event.severity, event.type, event.message, event.data?.agentRestart]),
  };
  const runner = {
    restartActiveAfter: async (task) => {
      await task();
      return { restarted: true };
    },
  };
  const restartRequests = [];
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
  try {
    await runCommand(
      {
        id: "cmd-git-active",
        commandType: "git_pull_restart",
        payload: {},
        claimedAt: "claim-git-active",
      },
      {
        client,
        runner,
        machineId: "worker-a",
        projectDir,
        requestAgentRestart: (request) => restartRequests.push(request),
      }
    );
  } finally {
    process.env.PATH = originalPath;
  }

  assert.deepEqual(calls, [
    [
      "event",
      "success",
      "command.accepted",
      "Git pull completed; active command restarted and agent will reload when idle.",
      "idle",
    ],
    ["ack", "cmd-git-active", null],
  ]);
  assert.deepEqual(restartRequests, [{ when: "idle", commandId: "cmd-git-active", reinstallInstalledAgent: true }]);
});

test("process runner uses root env over stale service env for managed child commands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-runner-env-"));
  await writeFile(
    path.join(dir, ".env"),
    [
      "STORJ_PASSPHRASE=real passphrase",
      "DASHBOARD_URL=https://correct.example",
    ].join("\n") + "\n",
    "utf8"
  );
  const scriptPath = path.join(dir, "print-env.mjs");
  await writeFile(
    scriptPath,
    [
      "console.log(process.env.STORJ_PASSPHRASE);",
      "console.log(process.env.DASHBOARD_URL);",
      "console.log(process.env.EXTRA_VALUE);",
    ].join("\n"),
    "utf8"
  );
  const lines = [];
  const runner = createProcessRunner({
    cwd: dir,
    env: {
      STORJ_PASSPHRASE: "********",
      DASHBOARD_URL: "https://stale.example",
      EXTRA_VALUE: "kept",
    },
    onLine: (line) => lines.push(line),
  });

  const result = await runner.run({ command: process.execPath, args: [scriptPath] });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(lines, ["real passphrase", "https://correct.example", "kept"]);
});

test("process runner restarts a managed process when output goes stale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-stale-restart-"));
  const countPath = path.join(dir, "runs.txt");
  const scriptPath = path.join(dir, "child.mjs");
  await writeFile(
    scriptPath,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const countPath = process.argv[2];',
      'let count = 0;',
      'try { count = Number(readFileSync(countPath, "utf8")) || 0; } catch {}',
      'count += 1;',
      'writeFileSync(countPath, String(count));',
      'console.log(`run:${count}`);',
      'if (count === 1) setInterval(() => {}, 1000);',
      'else process.exit(0);',
    ].join("\n"),
    "utf8"
  );
  const lines = [];
  const staleRestarts = [];
  const runner = createProcessRunner({
    cwd: dir,
    env: { DASHBOARD_AGENT_STALE_OUTPUT_RESTART_MS: "50" },
    onLine: (line) => lines.push(line),
    onStaleRestart: (event) => staleRestarts.push(event),
  });

  const result = await runner.run({ command: process.execPath, args: [scriptPath, countPath] });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(lines, ["run:1", "run:2"]);
  assert.equal(staleRestarts.length, 1);
  assert.equal(staleRestarts[0].timeoutMs, 50);
  assert.equal(await readFile(countPath, "utf8"), "2");
});

test("job reporter coalesces burst progress updates and flushes the latest before completion", async () => {
  let currentTime = 0;
  const posts = [];
  const updates = [];
  const reporter = createJobReporter({
    client: {
      postJob: async (payload) => posts.push(payload),
      updateJob: async (jobId, payload) => updates.push({ jobId, ...payload }),
    },
    machineId: "server-01",
    configId: "cfg-a",
    jobId: "job-a",
    progressUpdateMs: 1_000,
    now: () => currentTime,
  });

  await reporter.start({ stage: "download", progress: { percent: 0 } });
  await reporter.progress({ stage: "download", progress: { percent: 1 } });
  currentTime = 100;
  await reporter.progress({ stage: "download", progress: { percent: 2 } });
  currentTime = 200;
  await reporter.progress({ stage: "download", progress: { percent: 3 } });
  await reporter.complete({ stage: "upload", progress: { percent: 100 } });

  assert.equal(posts.length, 1);
  assert.deepEqual(
    updates.map((update) => [update.status, update.stage, update.progress.percent]),
    [
      ["running", "download", 1],
      ["running", "download", 3],
      ["completed", "upload", 100],
    ]
  );
});

test("job reporter retries failed coalesced progress with the newest snapshot", async () => {
  let currentTime = 0;
  let failNext = true;
  const updates = [];
  const reporter = createJobReporter({
    client: {
      postJob: async () => {},
      updateJob: async (jobId, payload) => {
        if (failNext) {
          failNext = false;
          throw new Error("dashboard unavailable");
        }
        updates.push({ jobId, ...payload });
      },
    },
    machineId: "server-01",
    configId: "cfg-a",
    jobId: "job-a",
    progressUpdateMs: 1_000,
    now: () => currentTime,
  });

  await assert.rejects(
    () => reporter.progress({ stage: "download", progress: { percent: 1 } }),
    /dashboard unavailable/
  );
  currentTime = 100;
  await reporter.progress({ stage: "download", progress: { percent: 2 } });
  assert.equal(updates.length, 0);

  currentTime = 1_100;
  await reporter.progress({ stage: "download", progress: { percent: 3 } });

  assert.deepEqual(
    updates.map((update) => [update.status, update.stage, update.progress.percent]),
    [["running", "download", 3]]
  );
});

test("agent clear_agent_log command truncates the local downloader console log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-clear-log-"));
  const agentLogPath = path.join(dir, ".tile-state", "dashboard-agent.log");
  await mkdir(path.dirname(agentLogPath), { recursive: true });
  await writeFile(agentLogPath, "old log line\n", "utf8");
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type, event.message]),
  };

  await runCommand(
    {
      id: "cmd-clear-log",
      commandType: "clear_agent_log",
      payload: {},
      claimedAt: "claim-clear-log",
    },
    {
      client,
      runner: {},
      machineId: "worker-a",
      projectDir: dir,
      agentLogPath,
      syncNow: async ({ reason }) => calls.push(["sync", reason]),
    }
  );

  assert.equal(await readFile(agentLogPath, "utf8"), "");
  assert.deepEqual(calls, [
    ["sync", "clear_agent_log"],
    ["event", "command.accepted", "Downloader console log cleared."],
    ["ack", "cmd-clear-log"],
  ]);
});

test("agent sync commands force immediate materialization before acknowledgement", async () => {
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type, event.message]),
  };

  await runCommand(
    {
      id: "cmd-sync",
      commandType: "sync_config",
      payload: {},
      claimedAt: "claim-sync",
    },
    {
      client,
      runner: {},
      machineId: "worker-a",
      syncNow: async ({ reason }) => calls.push(["sync", reason]),
    }
  );

  assert.deepEqual(calls, [
    ["sync", "sync_config"],
    ["event", "command.accepted", "Sync config completed."],
    ["ack", "cmd-sync"],
  ]);
});

test("agent write_config command updates a local config file inside configs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-write-config-"));
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type, event.data.configPath]),
  };

  await runCommand(
    {
      id: "cmd-config",
      commandType: "write_config",
      payload: {
        configPath: "configs/local.config.json",
        configText: JSON.stringify({ provider: "mapbox", ranges: [{ zoom: 1 }] }),
      },
      claimedAt: "claim-config",
    },
    {
      client,
      runner: {},
      machineId: "worker-a",
      projectDir: dir,
      syncNow: async ({ reason }) => calls.push(["sync", reason]),
    }
  );

  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "configs", "local.config.json"), "utf8")), {
    provider: "mapbox",
    ranges: [{ zoom: 1 }],
  });
  assert.deepEqual(calls, [
    ["sync", "write_config"],
    ["event", "command.accepted", path.join("configs", "local.config.json")],
    ["ack", "cmd-config"],
  ]);

  const escapeCalls = [];
  await runCommand(
    {
      id: "cmd-config-escape",
      commandType: "write_config",
      payload: { configPath: "../escape.json", configText: "{}" },
      claimedAt: "claim-config-escape",
    },
    {
      client: {
        ackCommand: async (commandId, ack = {}) => escapeCalls.push(["ack", commandId, ack.error]),
        postEvent: async (event) => escapeCalls.push(["event", event.type, event.message]),
      },
      runner: {},
      machineId: "worker-a",
      projectDir: dir,
    }
  );
  assert.deepEqual(escapeCalls, [
    ["event", "command.failed", "Config writes are limited to the project configs folder"],
    ["ack", "cmd-config-escape", "Config writes are limited to the project configs folder"],
  ]);
});

test("agent stop command records a stop request and signals the active runner", async () => {
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type, event.message]),
    stopRunningJobs: async (machineId) => {
      calls.push(["stop-jobs", machineId]);
      return { jobs: [{ jobId: "job-stop" }] };
    },
  };
  const control = {
    requestStopPipeline: async () => calls.push(["stop-file"]),
  };
  const runner = {
    stop() {
      calls.push(["runner-stop"]);
      return true;
    },
  };

  await runCommand(
    {
      id: "cmd-stop",
      commandType: "stop_pipeline",
      payload: {},
      claimedAt: "claim-stop",
    },
    { client, runner, machineId: "worker-a", control }
  );

  assert.deepEqual(calls, [
    ["stop-file"],
    ["runner-stop"],
    ["stop-jobs", "worker-a"],
    ["event", "command.accepted", "Stop signal sent to the active managed process."],
    ["ack", "cmd-stop"],
  ]);
});

test("agent scoped stop only signals a runner using that dashboard config", async () => {
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type, event.message, event.data.configId]),
    stopRunningJobs: async (machineId, payload) => {
      calls.push(["stop-jobs", machineId, payload.configId]);
      return { jobs: [{ jobId: "job-stop" }] };
    },
  };
  const control = {
    requestStopPipeline: async () => calls.push(["stop-file"]),
  };
  const runner = {
    activeCommandSpec: {
      command: "node",
      args: ["src/agent/pipeline.js", ".tile-state/dashboard/configs/cfg-a.json"],
    },
    stop() {
      calls.push(["runner-stop"]);
      return true;
    },
  };

  await runCommand(
    {
      id: "cmd-stop-scoped",
      commandType: "stop_pipeline",
      payload: { configId: "cfg-a" },
      claimedAt: "claim-stop",
    },
    { client, runner, machineId: "worker-a", control }
  );

  assert.deepEqual(calls, [
    ["stop-file"],
    ["runner-stop"],
    ["stop-jobs", "worker-a", "cfg-a"],
    ["event", "command.accepted", "Stop signal sent to the active managed process.", "cfg-a"],
    ["ack", "cmd-stop-scoped"],
  ]);
});

test("agent scoped stop does not kill an unrelated active config", async () => {
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type, event.message, event.data.configId]),
    stopRunningJobs: async (machineId, payload) => {
      calls.push(["stop-jobs", machineId, payload.configId]);
      return { jobs: [] };
    },
  };
  const control = {
    requestStopPipeline: async () => calls.push(["stop-file"]),
  };
  const runner = {
    activeCommandSpec: {
      command: "node",
      args: ["src/agent/pipeline.js", ".tile-state/dashboard/configs/cfg-b.json"],
    },
    stop() {
      calls.push(["runner-stop"]);
      return true;
    },
  };

  await runCommand(
    {
      id: "cmd-stop-unrelated",
      commandType: "stop_pipeline",
      payload: { configId: "cfg-a" },
      claimedAt: "claim-stop",
    },
    { client, runner, machineId: "worker-a", control }
  );

  assert.deepEqual(calls, [
    ["stop-jobs", "worker-a", "cfg-a"],
    ["event", "command.accepted", "No active managed process matched the deleted config.", "cfg-a"],
    ["ack", "cmd-stop-unrelated"],
  ]);
});

test("range pipeline stops before the next stage when stop is requested", async () => {
  const calls = [];
  const events = [];

  await assert.rejects(
    () =>
      runRangePipeline({
        config: { ranges: [{ label: "r1" }] },
        configPath: "configs/a.json",
        emitEvent: (event) => events.push(event.type),
        runStage: async (stage) => {
          calls.push(stage);
          return { ok: true };
        },
        shouldStop: async ({ stage }) => stage === "validate",
      }),
    /pipeline stopped/
  );

  assert.deepEqual(calls, ["download"]);
  assert.equal(events.includes("pipeline.stopped"), true);
});

test("agent accepts long pipeline commands without blocking until process completion", async () => {
  const calls = [];
  let resolveRun;
  const runner = {
    run() {
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    },
    stop() {
      return false;
    },
  };
  const client = {
    ackCommand: async (commandId, payload) => calls.push(["ack", commandId, payload]),
    postEvent: async (event) => calls.push(["event", event]),
  };
  const control = {
    clearPauseAfterRange: async () => calls.push(["clear-pause"]),
  };
  const syncNow = async ({ reason }) => calls.push(["sync", reason]);

  await runCommand(
    {
      id: "cmd-1",
      commandType: "start_pipeline",
      payload: { configPath: "configs/a.json" },
      claimedAt: "claim-1",
    },
    { client, runner, machineId: "worker-a", control, syncNow }
  );

  assert.deepEqual(calls.slice(0, 3).map((call) => call[0]), ["sync", "clear-pause", "ack"]);
  assert.equal(calls[0][1], "start_pipeline");
  assert.equal(calls[2][1], "cmd-1");

  resolveRun({ code: 1 });
  await flushMicrotasks();

  assert.equal(calls.at(-1)[0], "event");
  assert.equal(calls.at(-1)[1].type, "command.failed");
  assert.match(calls.at(-1)[1].message, /exited with code 1/);
});

test("agent pause command records a pause request and acknowledges command", async () => {
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type]),
  };
  const control = {
    requestPauseAfterRange: async () => calls.push(["pause-file"]),
  };

  await runCommand(
    {
      id: "cmd-pause",
      commandType: "pause_after_range",
      payload: {},
      claimedAt: "claim-pause",
    },
    { client, runner: {}, machineId: "worker-a", control }
  );

  assert.deepEqual(calls, [
    ["pause-file"],
    ["event", "command.accepted"],
    ["ack", "cmd-pause"],
  ]);
});

test("range pipeline executes config-level download validate zip upload in order", async () => {
  const calls = [];
  const events = [];

  await runRangePipeline({
    config: { jobName: "1-pyongyang-esri-satellite", ranges: [{ label: "r1" }, { label: "r2" }] },
    configPath: "configs/a.json",
    runStage: async (stage, context) => {
      calls.push(`${context.rangeIndex}:${stage}`);
      return { ok: true };
    },
    emitEvent: (event) => events.push(event.type),
  });

  assert.deepEqual(calls, [
    "null:download",
    "null:validate",
    "null:zip",
    "null:upload",
  ]);
  assert.equal(events.at(0), "pipeline.started");
  assert.equal(events.at(-1), "pipeline.completed");
});

test("range pipeline treats all ranges in a config as one stage unit", async () => {
  const calls = [];

  await runRangePipeline({
    config: { ranges: [{ label: "r1" }, { label: "r2" }, { label: "r3" }] },
    configPath: "configs/a.json",
    runStage: async (stage, context) => {
      calls.push({ stage, rangeIndex: context.rangeIndex });
      return { ok: true };
    },
    emitEvent: () => {},
  });

  assert.deepEqual(calls, [
    { stage: "download", rangeIndex: null },
    { stage: "validate", rangeIndex: null },
    { stage: "zip", rangeIndex: null },
    { stage: "upload", rangeIndex: null },
  ]);
});

test("range pipeline lifecycle events identify the config-level stage", async () => {
  const events = [];

  await runRangePipeline({
    config: { jobName: "1-pyongyang-esri-satellite", ranges: [{ label: "r1" }] },
    configPath: "configs/1-pyongyang-esri-satellite.config.json",
    runStage: async () => ({ ok: true }),
    emitEvent: (event) => events.push(event),
  });

  const started = events.find((event) => event.type === "pipeline.started");
  const downloadStarted = events.find((event) => event.type === "pipeline.download.started");
  const completed = events.find((event) => event.type === "pipeline.completed");

  assert.deepEqual(started.data, {
    configPath: "configs/1-pyongyang-esri-satellite.config.json",
    configName: "1-pyongyang-esri-satellite",
    ranges: 1,
  });
  assert.deepEqual(downloadStarted.data, {
    configPath: "configs/1-pyongyang-esri-satellite.config.json",
    configName: "1-pyongyang-esri-satellite",
    ranges: 1,
    stage: "download",
  });
  assert.equal(completed.data.configName, "1-pyongyang-esri-satellite");
});

test("range pipeline pauses after the current config-level stage when requested", async () => {
  const calls = [];
  const events = [];

  await runRangePipeline({
    config: { ranges: [{ label: "r1" }, { label: "r2" }] },
    configPath: "configs/a.json",
    runStage: async (stage, context) => {
      calls.push(`${context.rangeIndex}:${stage}`);
      return { ok: true };
    },
    emitEvent: (event) => events.push(event.type),
    shouldPauseAfterRange: async ({ stage }) => stage === "zip",
  });

  assert.deepEqual(calls, [
    "null:download",
    "null:validate",
    "null:zip",
  ]);
  assert.equal(events.includes("pipeline.paused"), true);
  assert.equal(events.includes("pipeline.completed"), false);
});

test("pipeline CLI stages run against the full config without range scoping", () => {
  assert.deepEqual(stageArgs("download", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "downloader.js",
    "configs/a.json",
  ]);
  assert.deepEqual(stageArgs("validate", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "downloader.js",
    "configs/a.json",
    "--validate",
    "--force-verify",
  ]);
  assert.deepEqual(stageArgs("zip", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "zip-maker.js",
    "configs/a.json",
  ]);
  assert.deepEqual(stageArgs("upload", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "storj-uploader.js",
    "configs/a.json",
  ]);
});

test("range pipeline stops before zip and upload when download fails", async () => {
  const calls = [];

  await assert.rejects(
    () =>
      runRangePipeline({
        config: { ranges: [{ label: "r1" }] },
        configPath: "configs/a.json",
        emitEvent: () => {},
        runStage: async (stage) => {
          calls.push(stage);
          if (stage === "download") return { ok: false, error: "download failed" };
          return { ok: true };
        },
      }),
    /download failed/
  );

  assert.deepEqual(calls, ["download"]);
});

test("range pipeline reports durable job stages", async () => {
  const reports = [];
  const completions = [];

  await runRangePipeline({
    config: { ranges: [{ label: "r1" }] },
    configPath: "configs/a.json",
    createJobReporter: ({ rangeIndex, range }) => {
      assert.equal(rangeIndex, null);
      assert.equal(range, null);
      return {
        start: async ({ stage }) => reports.push(`start:${stage}`),
        stage: async ({ stage }) => reports.push(`stage:${stage}`),
        complete: async ({ stage, progress }) => {
          reports.push(`complete:${stage}`);
          completions.push(progress);
        },
        fail: async ({ stage, error }) => reports.push(`fail:${stage}:${error.message}`),
      };
    },
    runStage: async (stage) => stage === "upload"
      ? {
          ok: true,
          storjProof: {
            storjShareUrl: "https://link.storjshare.io/s/testshare/mapbox/r1/",
            storjRawLinkPrefix: "https://link.storjshare.io/raw/testshare/mapbox/r1/",
          },
        }
      : { ok: true },
    emitEvent: () => {},
  });

  assert.deepEqual(reports, [
    "start:download",
    "stage:validate",
    "stage:zip",
    "stage:upload",
    "complete:upload",
  ]);
  assert.equal(completions[0].storjShareUrl, "https://link.storjshare.io/s/testshare/mapbox/r1/");
  assert.equal(completions[0].percent, 100);
});

test("range pipeline parses Storj upload proof from uploader output lines", () => {
  let proof = parseStorjProofFromLine('[storj-result] {"ok":true,"status":"uploaded","bucket":"mapbox","remotePath":"job/archive.zip","remoteUrl":"sj://mapbox/job/archive.zip","bytes":123}');
  proof = parseStorjProofFromLine('[storj-result] {"ok":true,"status":"shared","bucket":"mapbox","target":"sj://mapbox/job/","shareUrl":"https://link.storjshare.io/s/testshare/mapbox/job/","rawLinkPrefix":"https://link.storjshare.io/raw/testshare/mapbox/job/"}', proof);

  assert.equal(proof.storjShareUrl, "https://link.storjshare.io/s/testshare/mapbox/job/");
  assert.equal(proof.storjRawLinkPrefix, "https://link.storjshare.io/raw/testshare/mapbox/job/");
  assert.equal(proof.storjArchives[0].remoteUrl, "sj://mapbox/job/archive.zip");
});

test("range pipeline passes reporter and base progress to stage runners", async () => {
  const reporter = {
    start: async () => {},
    stage: async () => {},
    complete: async () => {},
    fail: async () => {},
  };
  const seen = [];

  await runRangePipeline({
    config: { ranges: [{ label: "r1" }] },
    configPath: "configs/a.json",
    createJobReporter: () => reporter,
    runStage: async (stage, context) => {
      seen.push({
        stage,
        sameReporter: context.reporter === reporter,
        progressStageIndex: context.progress.stageIndex,
        progressStageCount: context.progress.stageCount,
      });
      return { ok: true };
    },
    emitEvent: () => {},
  });

  assert.deepEqual(seen, [
    { stage: "download", sameReporter: true, progressStageIndex: 0, progressStageCount: 4 },
    { stage: "validate", sameReporter: true, progressStageIndex: 1, progressStageCount: 4 },
    { stage: "zip", sameReporter: true, progressStageIndex: 2, progressStageCount: 4 },
    { stage: "upload", sameReporter: true, progressStageIndex: 3, progressStageCount: 4 },
  ]);
});

test("range pipeline reports failed stage before throwing", async () => {
  const reports = [];

  await assert.rejects(
    () =>
      runRangePipeline({
        config: { ranges: [{ label: "r1" }] },
        configPath: "configs/a.json",
        createJobReporter: () => ({
          start: async ({ stage }) => reports.push(`start:${stage}`),
          stage: async ({ stage }) => reports.push(`stage:${stage}`),
          complete: async ({ stage }) => reports.push(`complete:${stage}`),
          fail: async ({ stage, error }) => reports.push(`fail:${stage}:${error.message}`),
        }),
        runStage: async (stage) => {
          if (stage === "validate") return { ok: false, error: "validate failed" };
          return { ok: true };
        },
        emitEvent: () => {},
      }),
    /validate failed/
  );

  assert.deepEqual(reports, [
    "start:download",
    "stage:validate",
    "fail:validate:validate failed",
  ]);
});
