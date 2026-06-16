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

  assert.equal(start.command, process.execPath);
  assert.deepEqual(start.args, ["src/agent/pipeline.js", "configs/a.json"]);
  assert.equal(preflight.command, process.execPath);
  assert.deepEqual(preflight.args, ["downloader.js", "--dry-run", "configs/a.json"]);
  assert.throws(
    () => resolveManagedCommand({ commandType: "shell", payload: { command: "echo bad" } }),
    /unsupported command/
  );
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
