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
  await store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-01",
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

test("dashboard store stops active jobs and clears machine active job state", async () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-01",
  });

  await store.upsertJob({
    jobId: "job-stop",
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 7 },
  });

  const stopped = await store.stopRunningJobs({
    machineId: "SERVER-01",
    error: "dashboard stop command",
  });
  const jobs = await store.listJobs({ machineId: "server-01" });
  const machines = await store.listMachines();

  assert.equal(stopped.length, 1);
  assert.equal(jobs[0].status, "stopped");
  assert.equal(jobs[0].finishedAt, "2026-06-16T00:00:00.000Z");
  assert.equal(jobs[0].error, "dashboard stop command");
  assert.equal(machines.find((machine) => machine.machineId === "server-01")?.currentJobId, null);
});

test("dashboard store does not revive stopped jobs from late progress", async () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-01",
  });
  await store.upsertJob({
    jobId: "job-stop",
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 7 },
  });
  await store.stopRunningJobs({
    machineId: "server-01",
    error: "dashboard stop command",
  });

  await store.upsertJob({
    jobId: "job-stop",
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 9 },
  });

  const jobs = await store.listJobs({ machineId: "server-01" });
  const machine = await store.getMachine("server-01");
  assert.equal(jobs[0].status, "stopped");
  assert.equal(jobs[0].progress.percent, 7);
  assert.equal(machine.currentJobId, null);
});

test("dashboard store config-scoped stop does not clear an unrelated active job", async () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-01",
  });

  await store.upsertJob({
    jobId: "job-a",
    machineId: "server-01",
    configId: "cfg-a",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 7 },
  });
  await store.upsertJob({
    jobId: "job-b",
    machineId: "server-01",
    configId: "cfg-b",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 9 },
  });

  const stopped = await store.stopRunningJobs({
    machineId: "server-01",
    configId: "cfg-a",
    error: "config deleted",
  });
  const jobs = await store.listJobs({ machineId: "server-01" });
  const machine = await store.getMachine("server-01");

  assert.deepEqual(stopped.map((job) => job.jobId), ["job-a"]);
  assert.equal(jobs.find((job) => job.jobId === "job-a")?.status, "stopped");
  assert.equal(jobs.find((job) => job.jobId === "job-b")?.status, "running");
  assert.equal(machine.currentJobId, "job-b");
});

test("canonical agent job routes require token and expose dashboard job list", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  const server = await withServer(t, store);
  const headers = { authorization: "Bearer agent-token" };

  const rejected = await request(server, {
    method: "POST",
    path: "/api/agents/jobs",
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
    path: "/api/agents/jobs",
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
    path: "/api/agents/jobs/job-1",
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

test("canonical agent stop route marks active jobs stopped", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  const server = await withServer(t, store);
  const headers = { authorization: "Bearer agent-token" };

  await request(server, {
    method: "POST",
    path: "/api/agents/jobs",
    headers,
    body: {
      jobId: "job-stop-route",
      machineId: "server-01",
      configId: "cfg-1",
      rangeId: "range-0",
      status: "running",
      stage: "download",
      progress: { percent: 12 },
    },
  });

  const stopped = await request(server, {
    method: "POST",
    path: "/api/agents/jobs/stop-running",
    headers,
    body: { machineId: "server-01", error: "dashboard stop command" },
  });
  const listed = await request(server, { path: "/api/jobs?machineId=server-01" });

  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.jobs.length, 1);
  assert.equal(stopped.body.jobs[0].status, "stopped");
  assert.equal(listed.body.jobs[0].status, "stopped");
});

test("legacy singular agent job routes remain compatibility aliases", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  const server = await withServer(t, store);
  const headers = { authorization: "Bearer agent-token" };

  const created = await request(server, {
    method: "POST",
    path: "/api/agent/jobs",
    headers,
    body: {
      jobId: "job-legacy",
      machineId: "server-01",
      configId: "cfg-1",
      status: "running",
      stage: "download",
    },
  });
  const updated = await request(server, {
    method: "PUT",
    path: "/api/agent/jobs/job-legacy",
    headers,
    body: {
      status: "completed",
      stage: "upload",
    },
  });

  assert.equal(created.status, 200);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.job.status, "completed");
});
