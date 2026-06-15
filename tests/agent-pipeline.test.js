import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardStore } from "../dashboard/src/server/store.js";
import { resolveManagedCommand } from "../src/agent/process-runner.js";
import { runRangePipeline, stageArgs } from "../src/agent/pipeline.js";

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
