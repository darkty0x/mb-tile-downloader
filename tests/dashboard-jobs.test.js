import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardApp } from "../dashboard/src/server/app.js";
import { createDashboardStore } from "../dashboard/src/server/store.js";

async function request(server, { method = "GET", path = "/", headers = {}, body } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function withServer(t, store = createDashboardStore()) {
  const app = createDashboardApp({ store, agentToken: "agent-token" });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  return app;
}

test("dashboard store persists job lifecycle updates", async () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });

  await store.upsertJob({
    jobId: "job-1",
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { rangeIndex: 0, tilesDone: 25, tilesTotal: 100 },
  });

  await store.upsertJob({
    jobId: "job-1",
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "validate",
    progress: { rangeIndex: 0, tilesDone: 100, tilesTotal: 100 },
  });

  const jobs = await store.listJobs({ machineId: "server-01" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "job-1");
  assert.equal(jobs[0].stage, "validate");
  assert.equal(jobs[0].progress.tilesDone, 100);
});

test("agent job routes require token and expose dashboard job list", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  const server = await withServer(t, store);
  const headers = { authorization: "Bearer agent-token" };

  const rejected = await request(server, {
    method: "POST",
    path: "/api/agent/jobs",
    body: {
      jobId: "job-1",
      machineId: "server-01",
      configId: "cfg-1",
      status: "running",
      stage: "download",
    },
  });
  const created = await request(server, {
    method: "POST",
    path: "/api/agent/jobs",
    headers,
    body: {
      jobId: "job-1",
      machineId: "server-01",
      configId: "cfg-1",
      rangeId: "range-0",
      status: "running",
      stage: "download",
      progress: { percent: 10 },
    },
  });
  const updated = await request(server, {
    method: "PUT",
    path: "/api/agent/jobs/job-1",
    headers,
    body: {
      status: "completed",
      stage: "upload",
      progress: { percent: 100 },
    },
  });
  const listed = await request(server, { path: "/api/jobs?machineId=server-01" });

  assert.equal(rejected.status, 401);
  assert.equal(created.status, 200);
  assert.equal(created.body.job.stage, "download");
  assert.equal(updated.status, 200);
  assert.equal(updated.body.job.status, "completed");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.jobs.length, 1);
  assert.equal(listed.body.jobs[0].progress.percent, 100);
});
