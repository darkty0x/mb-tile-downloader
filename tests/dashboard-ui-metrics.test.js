import test from "node:test";
import assert from "node:assert/strict";

import { buildOverviewModel, buildServerOnboarding, nextServerDefaults } from "../dashboard/client/lib/overview-model.js";

test("overview model summarizes fleet pipeline disk and resource alerts", () => {
  const model = buildOverviewModel({
    machines: [
      {
        machineId: "worker-a",
        displayName: "MB-Server-01",
        status: "online",
        platform: "Windows",
        lastSeenAt: "2026-06-16T00:25:14.000Z",
        disk: [
          { mount: "D:", percentUsed: 67, freeBytes: 354334801920, totalBytes: 1099511627776 },
          { mount: "E:", percentUsed: 41, freeBytes: 648540061696, totalBytes: 1099511627776 },
        ],
      },
      {
        machineId: "worker-b",
        displayName: "MB-Server-02",
        status: "error",
        platform: "Linux",
        lastSeenAt: "2026-06-16T00:20:14.000Z",
        disk: [{ mount: "/", percentUsed: 92, freeBytes: 85899345920, totalBytes: 1099511627776 }],
      },
    ],
    configs: [
      {
        name: "ukraine-range-01",
        active: true,
        config: { ranges: [{ zoom: 14, xStart: 9600, xEnd: 9611, yStart: 5265, yEnd: 5830 }] },
      },
    ],
    events: [
      { type: "range.download.started", severity: "info", message: "Download started", createdAt: "2026-06-16T00:21:00.000Z" },
      { type: "range.validate.completed", severity: "info", message: "Validate completed", createdAt: "2026-06-16T00:22:00.000Z" },
      { type: "range.failed", severity: "error", message: "Job failed", createdAt: "2026-06-16T00:23:00.000Z" },
    ],
    secretPool: [
      { secretType: "mapbox_token", status: "active" },
      { secretType: "proxy_txt", status: "active" },
      { secretType: "proxy_txt", status: "disabled" },
    ],
    settings: {
      alertThresholds: {
        mapboxTokensPerServer: 2,
        proxiesPerServer: 50,
      },
    },
  });

  assert.equal(model.kpis.serversOnline.value, "1 / 2");
  assert.equal(model.kpis.failedJobs.value, 1);
  assert.equal(model.diskPressure, 92);
  assert.deepEqual(model.pipeline.map((step) => step.label), ["Download", "Validate", "Zip", "Upload"]);
  assert.equal(model.pipeline[0].status, "running");
  assert.equal(model.pipeline[1].status, "complete");
  assert.equal(model.resourceAlerts.length, 2);
  assert.equal(model.activeRanges[0].name, "ukraine-range-01");
});

test("server onboarding explains agent registration instead of manual dashboard rows", () => {
  const onboarding = buildServerOnboarding({
    dashboardUrl: "https://ptg-dashboard.example.com",
    machineId: "server-10",
  });

  assert.equal(onboarding.machineId, "server-10");
  assert.match(onboarding.command, /MACHINE_ID=server-10/);
  assert.match(onboarding.command, /DASHBOARD_URL=https:\/\/ptg-dashboard.example.com/);
  assert.match(onboarding.command, /npm run agent/);
});

test("server onboarding defaults increment from saved connection profiles and machines", () => {
  const defaults = nextServerDefaults({
    machines: [
      { machineId: "server-01", displayName: "Server 01" },
      { machineId: "SERVER-03", displayName: "Server 03" },
    ],
    secretPool: [
      {
        secretType: "credential",
        label: "Server 02",
        targetMachineId: "server-02",
        credential: { protocol: "rdp", machineId: "server-02" },
      },
      {
        secretType: "credential",
        label: "Backup Login",
        credential: { protocol: "ssh", machineId: "SERVER-07" },
      },
    ],
  });

  assert.deepEqual(defaults, {
    number: 8,
    label: "Server 08",
    machineId: "SERVER-08",
  });
});
