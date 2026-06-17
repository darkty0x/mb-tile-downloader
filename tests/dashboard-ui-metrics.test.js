import test from "node:test";
import assert from "node:assert/strict";

import { buildGlobalSearchResults } from "../dashboard/client/lib/global-search.js";
import { buildCredentialSecretValue, buildOverviewModel, buildServerOnboarding, buildWindowsAgentEnv, nextServerDefaults } from "../dashboard/client/lib/overview-model.js";

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
  assert.deepEqual(model.pipeline.map((step) => step.label), ["내리적재", "검증", "압축", "올리적재"]);
  assert.equal(model.pipeline[0].status, "running");
  assert.equal(model.pipeline[1].status, "complete");
  assert.equal(model.resourceAlerts.length, 2);
  assert.equal(model.activeRanges[0].name, "ukraine-range-01");
});

test("overview model uses durable jobs for scoped pipeline and ETA", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-09", status: "offline", disk: [] }],
    events: [
      { machineId: "server-09", type: "range.download.started", severity: "info", message: "old event" },
    ],
    jobs: [
      {
        jobId: "job-server-09",
        machineId: "server-09",
        status: "running",
        stage: "zip",
        startedAt: "2026-06-16T00:25:00.000Z",
        progress: {
          percent: 50,
          tilesDone: 750,
          tilesTotal: 1000,
          tilesPerSecond: 25,
        },
      },
      {
        jobId: "job-other",
        machineId: "server-01",
        status: "running",
        stage: "download",
        startedAt: "2026-06-16T00:26:00.000Z",
        progress: { percent: 90 },
      },
    ],
    machineId: "SERVER-09",
  });

  assert.equal(model.activeJob.jobId, "job-server-09");
  assert.equal(model.pipeline[0].status, "complete");
  assert.equal(model.pipeline[1].status, "complete");
  assert.equal(model.pipeline[2].status, "running");
  assert.equal(model.pipeline[2].progress, 50);
  assert.equal(model.pipelineStage, "압축");
  assert.equal(model.pipelineProgress, "63%");
  assert.equal(model.pipelineEta, "10초");
});

test("global search returns navigable servers configs and events", () => {
  const state = {
    machines: [
      { machineId: "server-09", displayName: "Server 09", status: "online", platform: "win32" },
    ],
    globalConfigs: [
      {
        configId: "cfg-1",
        machineId: "server-09",
        name: "ukraine-pbf",
        config: { provider: "mapbox", layer: "vector", ranges: [{ zoom: 17 }] },
      },
    ],
    globalEvents: [
      { eventId: "event-1", machineId: "server-09", type: "download.started", message: "range started", severity: "info" },
    ],
  };

  assert.deepEqual(
    buildGlobalSearchResults(state, "server-09").map((result) => result.type),
    ["machine", "config", "event"]
  );
  assert.equal(buildGlobalSearchResults(state, "ukraine")[0].tab, "configs");
  assert.equal(buildGlobalSearchResults(state, "range")[0].tab, "events");
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
        secretType: "server_rdp_credential",
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
    number: 4,
    label: "봉사기 04",
    machineId: "server-04",
  });
});

test("credential secret value preserves editable agent id", () => {
  const value = buildCredentialSecretValue({
    protocolUrl: "rdp://195.201.245.29:7777",
    machineId: " server-02 ",
    username: "root",
    password: "server-password",
  });

  assert.deepEqual(JSON.parse(value), {
    protocolUrl: "rdp://195.201.245.29:7777",
    machineId: "server-02",
    username: "root",
    password: "server-password",
  });
});

test("server onboarding builds Windows agent env instead of inline shell commands", () => {
  const env = buildWindowsAgentEnv({
    dashboardUrl: "https://ptg-dashboard.example.com",
    agentToken: "agent-token",
    machineId: " server-02 ",
  });

  assert.equal(env, [
    "DASHBOARD_URL=https://ptg-dashboard.example.com",
    "AGENT_TOKEN=agent-token",
    "MACHINE_ID=server-02",
  ].join("\n"));
  assert.equal(env.includes("npm run agent"), false);
  assert.equal(env.includes("$env:"), false);
  assert.equal(env.includes("MACHINE_ID="), true);
});
