import test from "node:test";
import assert from "node:assert/strict";

import { createJobReporter } from "../src/agent/job-reporter.js";

test("job reporter posts start stage and completion updates", async () => {
  const calls = [];
  const client = {
    postJob: async (body) => calls.push(["post", body]),
    updateJob: async (jobId, body) => calls.push(["put", jobId, body]),
  };

  const reporter = createJobReporter({
    client,
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    jobId: "job-1",
  });

  await reporter.start({ stage: "download" });
  await reporter.stage({ stage: "validate", progress: { tilesDone: 100, tilesTotal: 100 } });
  await reporter.complete({ stage: "upload" });

  assert.deepEqual(calls.map((call) => call[0]), ["post", "put", "put"]);
  assert.equal(calls[0][1].status, "running");
  assert.equal(calls[1][2].stage, "validate");
  assert.equal(calls[2][2].status, "completed");
});
