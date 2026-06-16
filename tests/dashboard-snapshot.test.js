import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardApp } from "../dashboard/src/server/app.js";
import { createDashboardStore } from "../dashboard/src/server/store.js";

async function request(server, { path = "/" } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function withServer(t, options = {}) {
  const app = createDashboardApp({
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
    agentToken: "agent-token",
    ...options,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  return app;
}

test("snapshot returns fleet data in one read model", async () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-1",
    displayName: "Server 01",
    platform: "win32",
    version: "test",
  });
  store.createConfig({
    machineId: "server-01",
    name: "Ukraine Range 01",
    active: true,
    config: {
      provider: "esri",
      ranges: [{ zoom: 14, xStart: 9600, xEnd: 9601, yStart: 5265, yEnd: 5266 }],
    },
  });
  store.recordEvent({
    machineId: "server-01",
    severity: "info",
    type: "range.download.started",
    message: "download started",
  });
  store.upsertJob({
    jobId: "job-1",
    machineId: "server-01",
    configId: "cfg-1",
    status: "running",
    stage: "download",
    progress: { percent: 35 },
  });

  const snapshot = await store.getSnapshot();

  assert.equal(snapshot.machines.length, 1);
  assert.equal(snapshot.jobs[0].stage, "download");
  assert.equal(snapshot.jobs[0].progress.percent, 35);
  assert.equal(snapshot.configs[0].name, "Ukraine Range 01");
  assert.equal(snapshot.events[0].type, "range.download.started");
  assert.equal(snapshot.settings.alertThresholds.mapboxTokensPerServer, 2);
});

test("snapshot endpoint includes secret pool from encrypted vault", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  const server = await withServer(t, {
    store,
    secretVault: {
      async listSecretsForBrowser() {
        return [{ secretId: "secret-1", secretType: "mapbox_token", status: "active" }];
      },
    },
  });

  const response = await request(server, { path: "/api/snapshot" });

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.snapshot).sort(), [
    "configs",
    "envProfiles",
    "events",
    "jobs",
    "machines",
    "secretPool",
    "settings",
  ]);
  assert.equal(response.body.snapshot.secretPool[0].secretType, "mapbox_token");
});
