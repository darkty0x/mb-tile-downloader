import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardApp } from "../dashboard/src/server/app.js";
import { createDashboardStore } from "../dashboard/src/server/store.js";
import { createControlClient } from "../src/agent/control-client.js";

async function withServer(t) {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
    idGenerator: () => "record-a",
  });
  const server = createDashboardApp({
    store,
    agentToken: "agent-token",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, store };
}

test("control client registers and heartbeats with bearer auth", async (t) => {
  const { baseUrl } = await withServer(t);
  const client = createControlClient({ baseUrl, agentToken: "agent-token" });

  const registered = await client.register({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A",
  });
  const heartbeat = await client.heartbeat({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    disk: [{ name: "C:", freeBytes: 100 }],
  });

  assert.equal(registered.status, "registered");
  assert.equal(heartbeat.machine.disk[0].name, "C:");
});

test("control client raises a conflict error when machine id is live elsewhere", async (t) => {
  const { baseUrl } = await withServer(t);
  const first = createControlClient({ baseUrl, agentToken: "agent-token" });
  const second = createControlClient({ baseUrl, agentToken: "agent-token" });

  await first.register({ machineId: "worker-a", agentInstanceId: "agent-1" });

  await assert.rejects(
    () => second.register({ machineId: "worker-a", agentInstanceId: "agent-2" }),
    (err) => err.status === 409 && /already registered/.test(err.message)
  );
});

test("control client fetches dashboard-managed configs and env profiles", async (t) => {
  const { baseUrl, store } = await withServer(t);
  store.createConfig({
    machineId: "worker-a",
    name: "ukraine",
    config: {
      provider: "esri",
      ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    },
    active: true,
  });
  store.createEnvProfile({
    machineId: "worker-a",
    name: "default",
    env: { TILE_DOWNLOADER_MAX_CONCURRENCY: 16 },
    active: true,
  });
  const client = createControlClient({ baseUrl, agentToken: "agent-token" });

  const configs = await client.listConfigs("worker-a");
  const envProfiles = await client.listEnvProfiles("worker-a");

  assert.equal(configs.configs[0].name, "ukraine");
  assert.equal(envProfiles.envProfiles[0].env.TILE_DOWNLOADER_MAX_CONCURRENCY, 16);
});

test("control client posts and updates dashboard jobs", async (t) => {
  const { baseUrl } = await withServer(t);
  const client = createControlClient({ baseUrl, agentToken: "agent-token" });

  const created = await client.postJob({
    jobId: "job-1",
    machineId: "worker-a",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 10 },
  });
  const updated = await client.updateJob("job-1", {
    machineId: "worker-a",
    configId: "cfg-1",
    status: "completed",
    stage: "upload",
    progress: { percent: 100 },
  });

  assert.equal(created.job.stage, "download");
  assert.equal(updated.job.status, "completed");
  assert.equal(updated.job.progress.percent, 100);
});
