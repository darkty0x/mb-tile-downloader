import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardStore } from "../dashboard/src/server/store.js";
import { runCommand } from "../src/agent/agent.js";
import { resolveManagedCommand } from "../src/agent/process-runner.js";
import { runRangePipeline, stageArgs } from "../src/agent/pipeline.js";

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

  assert.equal(start.command, process.execPath);
  assert.deepEqual(start.args, ["src/agent/pipeline.js", "configs/a.json"]);
  assert.equal(preflight.command, process.execPath);
  assert.deepEqual(preflight.args, ["src/agent/preflight.js", "configs/a.json"]);
  assert.equal(updateRestart.command, "agent-internal");
  assert.deepEqual(updateRestart.args, ["git_pull_restart"]);
  assert.throws(
    () => resolveManagedCommand({ commandType: "shell", payload: { command: "echo bad" } }),
    /unsupported command/
  );
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

test("agent stop command records a stop request and signals the active runner", async () => {
  const calls = [];
  const client = {
    ackCommand: async (commandId) => calls.push(["ack", commandId]),
    postEvent: async (event) => calls.push(["event", event.type, event.message]),
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
    ["event", "command.accepted", "Stop signal sent to the active managed process."],
    ["ack", "cmd-stop"],
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

  await runCommand(
    {
      id: "cmd-1",
      commandType: "start_pipeline",
      payload: { configPath: "configs/a.json" },
      claimedAt: "claim-1",
    },
    { client, runner, machineId: "worker-a", control }
  );

  assert.deepEqual(calls.slice(0, 2).map((call) => call[0]), ["clear-pause", "ack"]);
  assert.equal(calls[1][1], "cmd-1");

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

test("range pipeline executes download validate zip upload in order", async () => {
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
  });

  assert.deepEqual(calls, [
    "0:download",
    "0:validate",
    "0:zip",
    "0:upload",
    "1:download",
    "1:validate",
    "1:zip",
    "1:upload",
  ]);
  assert.equal(events.at(0), "pipeline.started");
  assert.equal(events.at(-1), "pipeline.completed");
});

test("range pipeline pauses after the current range when requested", async () => {
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
    shouldPauseAfterRange: async ({ rangeIndex }) => rangeIndex === 0,
  });

  assert.deepEqual(calls, [
    "0:download",
    "0:validate",
    "0:zip",
    "0:upload",
  ]);
  assert.equal(events.includes("pipeline.paused"), true);
  assert.equal(events.includes("pipeline.completed"), false);
});

test("pipeline CLI stages pass the selected range index to each script", () => {
  assert.deepEqual(stageArgs("download", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "downloader.js",
    "configs/a.json",
    "--range-index=3",
  ]);
  assert.deepEqual(stageArgs("validate", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "downloader.js",
    "configs/a.json",
    "--validate",
    "--force-verify",
    "--range-index=3",
  ]);
  assert.deepEqual(stageArgs("zip", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "zip-maker.js",
    "configs/a.json",
    "--range-index=3",
  ]);
  assert.deepEqual(stageArgs("upload", { configPath: "configs/a.json", rangeIndex: 3 }), [
    "storj-uploader.js",
    "configs/a.json",
    "--range-index=3",
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

  await runRangePipeline({
    config: { ranges: [{ label: "r1" }] },
    configPath: "configs/a.json",
    createJobReporter: ({ rangeIndex, range }) => {
      assert.equal(rangeIndex, 0);
      assert.equal(range.label, "r1");
      return {
        start: async ({ stage }) => reports.push(`start:${stage}`),
        stage: async ({ stage }) => reports.push(`stage:${stage}`),
        complete: async ({ stage }) => reports.push(`complete:${stage}`),
        fail: async ({ stage, error }) => reports.push(`fail:${stage}:${error.message}`),
      };
    },
    runStage: async () => ({ ok: true }),
    emitEvent: () => {},
  });

  assert.deepEqual(reports, [
    "start:download",
    "stage:validate",
    "stage:zip",
    "stage:upload",
    "complete:upload",
  ]);
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
