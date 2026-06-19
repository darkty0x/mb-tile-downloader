import test from "node:test";
import assert from "node:assert/strict";

import { buildGlobalSearchResults } from "../dashboard/client/lib/global-search.js";
import { eventNotificationId, eventRecordId } from "../dashboard/client/lib/event-identity.js";
import { buildCredentialSecretValue, buildMachineCommandRows, buildOverviewModel, buildServerOnboarding, buildWindowsAgentEnv, buildWindowsAgentInstallCommand, nextServerDefaults } from "../dashboard/client/lib/overview-model.js";
import { diskPeakForMachine } from "../dashboard/client/components/dashboard-core.js";

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
  assert.equal(model.kpis.failedJobs.value, 0);
  assert.equal(model.diskPressure, 92);
  assert.deepEqual(model.pipeline.map((step) => step.label), ["내리적재", "검증", "압축", "올리적재"]);
  assert.equal(model.pipeline[0].status, "running");
  assert.equal(model.pipeline[1].status, "complete");
  assert.equal(model.resourceAlerts.length, 2);
  assert.equal(model.activeRanges[0].name, "ukraine-range-01");
});

test("event notification identity uses the durable event id field", () => {
  const localStoreEvent = { id: "evt-local", type: "command.accepted", message: "accepted" };
  const postgresEvent = { eventId: "evt-postgres", type: "command.accepted", message: "accepted" };

  assert.equal(eventRecordId(localStoreEvent), "evt-local");
  assert.equal(eventRecordId(postgresEvent), "evt-postgres");
  assert.equal(eventNotificationId(localStoreEvent), "event-evt-local");
  assert.equal(eventNotificationId(postgresEvent), "event-evt-postgres");
});

test("overview model displays dashboard-created zoom ranges", () => {
  const model = buildOverviewModel({
    configs: [
      {
        name: "1-ukraine-mapbox-pbf-cig",
        active: true,
        config: {
          ranges: [
            { zoomStart: 19, zoomEnd: 19, xStart: 309998, xEnd: 313424, yStart: 168505, yEnd: 186571 },
            { zoomStart: 18, zoomEnd: 19, xStart: 1, xEnd: 2, yStart: 3, yEnd: 4 },
          ],
        },
      },
    ],
  });

  assert.equal(model.activeRanges[0].z, "19");
  assert.equal(model.activeRanges[0].tiles, 61915609);
  assert.equal(model.activeRanges[1].z, "18-19");
  assert.equal(model.activeRanges[1].tiles, 4);
});

test("overview model excludes downloader console output from events", () => {
  const model = buildOverviewModel({
    events: [
      { type: "process.output", severity: "info", message: "range row output", createdAt: "2026-06-18T01:00:00.000Z" },
      { type: "range.failed", severity: "error", message: "real failure", createdAt: "2026-06-18T01:01:00.000Z" },
    ],
  });

  assert.equal(model.kpis.failedJobs.value, 0);
  assert.equal(model.recentEvents.length, 1);
  assert.equal(model.recentEvents[0].type, "range.failed");
});

test("overview model counts failed tile progress instead of generic failed events", () => {
  const model = buildOverviewModel({
    events: [
      { type: "command.failed", severity: "error", message: "unsupported command", createdAt: "2026-06-18T01:00:00.000Z" },
      { type: "range.failed", severity: "error", message: "stage failed", createdAt: "2026-06-18T01:01:00.000Z" },
    ],
    jobs: [
      {
        machineId: "server-01",
        status: "running",
        stage: "download",
        progress: { tilesFailed: 7 },
      },
      {
        machineId: "server-02",
        status: "running",
        stage: "download",
        progress: { failed: 3 },
      },
    ],
  });

  assert.equal(model.kpis.failedJobs.value, 10);
  assert.equal(model.kpis.failedJobs.detail, "주의 필요");
  assert.deepEqual(model.failedTileMachines, [
    { machineId: "server-01", failedTiles: 7 },
    { machineId: "server-02", failedTiles: 3 },
  ]);
});

test("overview model counts assigned active resources as usable", () => {
  const model = buildOverviewModel({
    machines: [
      { machineId: "server-01", status: "online" },
      { machineId: "server-02", status: "online" },
    ],
    secretPool: [
      { secretType: "mapbox_token", status: "active", machineId: "server-01" },
      { secretType: "mapbox_token", status: "active", machineId: "server-02" },
      { secretType: "mapbox_token", status: "active" },
      { secretType: "mapbox_token", status: "invalid" },
      { secretType: "proxy_txt", status: "active", machineId: "server-01" },
      { secretType: "proxy_txt", status: "active", machineId: "server-02" },
      { secretType: "proxy_txt", status: "active" },
      { secretType: "proxy_txt", status: "disabled" },
    ],
    settings: {
      alertThresholds: {
        mapboxTokensPerServer: 1,
        proxiesPerServer: 1,
      },
    },
  });

  assert.equal(model.resourceAlerts.length, 0);
  assert.equal(model.kpis.resourceAlerts.value, 0);
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

test("overview model aggregates fleet pipeline status across active servers", () => {
  const model = buildOverviewModel({
    machines: [
      { machineId: "server-01", status: "online", currentJobId: "job-server-01" },
      { machineId: "server-02", status: "online", currentJobId: "job-server-02" },
      { machineId: "server-03", status: "offline" },
    ],
    jobs: [
      {
        jobId: "job-server-01",
        machineId: "server-01",
        status: "running",
        stage: "download",
        startedAt: "2026-06-16T00:25:00.000Z",
        progress: {
          percent: 40,
          tilesDone: 400,
          tilesTotal: 1000,
          tilesPerSecond: 100,
          tilesMissing: 2,
          tilesFailed: 1,
        },
      },
      {
        jobId: "job-server-02",
        machineId: "server-02",
        status: "running",
        stage: "download",
        startedAt: "2026-06-16T00:26:00.000Z",
        progress: {
          percent: 20,
          tilesDone: 100,
          tilesTotal: 500,
          tilesPerSecond: 50,
          tilesMissing: 3,
          tilesFailed: 0,
        },
      },
    ],
  });

  assert.equal(model.pipelineSummary.scope, "fleet");
  assert.equal(model.pipelineSummary.machineLabel, "2 / 3대 진행");
  assert.equal(model.pipelineSummary.processedTiles, 500);
  assert.equal(model.pipelineSummary.totalTiles, 1500);
  assert.equal(model.pipelineSummary.speedTilesPerSecond, 150);
  assert.equal(model.pipelineSummary.missingTiles, 5);
  assert.equal(model.pipelineSummary.failedTiles, 1);
  assert.equal(model.pipeline[0].progress, 33);
  assert.equal(model.pipelineProgress, "8%");
  assert.equal(model.kpis.throughput.value, "150 타일/초");
});

test("overview active process KPI counts live machines, not stale job rows", () => {
  const model = buildOverviewModel({
    machines: [
      { machineId: "server-01", status: "online", currentJobId: "server-01-new" },
      { machineId: "server-02", status: "online", currentJobId: "server-02" },
      { machineId: "server-03", status: "online" },
      { machineId: "server-04", status: "online", currentJobId: "server-04" },
      { machineId: "server-05", status: "online", currentJobId: "server-05" },
    ],
    jobs: [
      { jobId: "server-01-new", machineId: "server-01", status: "running", stage: "download", startedAt: "2026-06-19T00:05:00.000Z" },
      { jobId: "server-01-old", machineId: "server-01", status: "running", stage: "download", startedAt: "2026-06-19T00:01:00.000Z" },
      { jobId: "server-02", machineId: "server-02", status: "running", stage: "download", startedAt: "2026-06-19T00:02:00.000Z" },
      { jobId: "server-03-stale", machineId: "server-03", status: "running", stage: "download", startedAt: "2026-06-19T00:03:00.000Z" },
      { jobId: "server-04", machineId: "server-04", status: "claimed", stage: "validate", startedAt: "2026-06-19T00:04:00.000Z" },
      { jobId: "server-05", machineId: "server-05", status: "running", stage: "zip", startedAt: "2026-06-19T00:06:00.000Z" },
      { jobId: "server-03-queued", machineId: "server-03", status: "queued", stage: "download", startedAt: "2026-06-19T00:07:00.000Z" },
    ],
  });

  assert.equal(model.kpis.activeJobs.value, 4);
  assert.equal(model.kpis.activeJobs.detail, "0개 대기");
  assert.equal(model.pipelineSummary.machineLabel, "4 / 5대 진행");
});

test("overview fleet pipeline ignores stale jobs without a live current job", () => {
  const model = buildOverviewModel({
    machines: [
      { machineId: "server-01", status: "online" },
      { machineId: "server-02", status: "online" },
    ],
    jobs: [
      {
        jobId: "stale-server-01",
        machineId: "server-01",
        status: "running",
        stage: "download",
        startedAt: "2026-06-19T00:01:00.000Z",
        progress: {
          percent: 50,
          tilesDone: 1000,
          tilesTotal: 2000,
          tilesPerSecond: 40,
        },
      },
    ],
  });

  assert.equal(model.pipelineSummary.scope, "fleet");
  assert.equal(model.pipelineSummary.machineLabel, "0 / 2대 진행");
  assert.equal(model.pipelineSummary.processedTiles, 0);
  assert.equal(model.pipelineSummary.totalTiles, 0);
  assert.equal(model.pipelineSummary.speedTilesPerSecond, 0);
  assert.equal(model.pipelineProgress, "0%");
  assert.equal(model.pipelineStage, "대기중");
  assert.equal(model.kpis.throughput.value, "0 타일/초");
});

test("overview model exposes per-server process status for the server list", () => {
  const model = buildOverviewModel({
    machines: [
      { machineId: "server-06", status: "online", currentJobId: "job-server-06" },
      { machineId: "server-07", status: "online", currentJobId: "job-server-07" },
    ],
    jobs: [
      {
        jobId: "job-server-06",
        machineId: "SERVER-06",
        status: "running",
        stage: "zip",
        startedAt: "2026-06-18T02:00:00.000Z",
        progress: {
          percent: 47,
          etaSeconds: 125,
        },
      },
      {
        jobId: "job-server-07",
        machineId: "server-07",
        status: "queued",
        stage: "upload",
        startedAt: "2026-06-18T02:01:00.000Z",
        progress: {},
      },
    ],
  });

  assert.equal(model.machineProcesses["server-06"].processLabel, "압축");
  assert.equal(model.machineProcesses["server-06"].statusLabel, "진행중");
  assert.equal(model.machineProcesses["server-06"].progressLabel, "47%");
  assert.equal(model.machineProcesses["server-06"].etaLabel, "2분 5초");
  assert.equal(model.machineProcesses["server-07"].processLabel, "올리적재");
  assert.equal(model.machineProcesses["server-07"].statusLabel, "대기중");
  assert.equal(model.machineProcesses["server-07"].etaLabel, "대기중");
});

test("overview model does not show stale ETA for stopped machine tasks", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-09", status: "online", currentJobId: "job-stopped" }],
    jobs: [
      {
        jobId: "job-stopped",
        machineId: "server-09",
        status: "stopped",
        stage: "download",
        startedAt: "2026-06-18T02:00:00.000Z",
        progress: {
          percent: 1,
          etaSeconds: 108000,
        },
      },
    ],
    machineId: "server-09",
  });

  assert.equal(model.machineProcesses["server-09"].processLabel, "내리적재");
  assert.equal(model.machineProcesses["server-09"].statusLabel, "정지됨");
  assert.equal(model.machineProcesses["server-09"].progressLabel, "1%");
  assert.equal(model.machineProcesses["server-09"].etaLabel, "대기중");
  assert.equal(model.pipelineEta, "대기중");
});

test("overview model exposes completed upload share link as pipeline proof", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-09", status: "online" }],
    jobs: [
      {
        jobId: "job-server-09",
        machineId: "server-09",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-16T00:25:00.000Z",
        finishedAt: "2026-06-16T00:35:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/testshare/mapbox/range-1/",
          storjRawLinkPrefix: "https://link.storjshare.io/raw/testshare/mapbox/range-1/",
        },
      },
    ],
    machineId: "server-09",
  });

  assert.equal(model.pipelineStage, "올리적재");
  assert.equal(model.pipelineProgress, "100%");
  assert.equal(model.pipelineEta, "완료");
  assert.equal(model.storjShareUrl, "https://link.storjshare.io/s/testshare/mapbox/range-1/");
});

test("server command rows follow selected machine lifecycle state", () => {
  assert.deepEqual(
    buildMachineCommandRows({ machineId: "server-01" }).map(([type]) => type),
    ["start_pipeline", "sync_config", "sync_env"]
  );

  assert.deepEqual(
    buildMachineCommandRows({
      machineId: "SERVER-01",
      jobs: [{ machineId: "server-01", status: "running", startedAt: "2026-06-18T01:00:00.000Z" }],
    }).map(([type]) => type),
    ["pause_after_range", "stop_pipeline", "sync_config", "sync_env"]
  );

  assert.deepEqual(
    buildMachineCommandRows({
      machineId: "server-01",
      jobs: [{ machineId: "server-01", status: "stopped", finishedAt: "2026-06-18T01:05:00.000Z" }],
    }).map(([type]) => type),
    ["start_pipeline", "sync_config", "sync_env"]
  );

  assert.deepEqual(
    buildMachineCommandRows({
      machineId: "server-01",
      jobs: [{ machineId: "server-01", status: "completed", finishedAt: "2026-06-18T01:10:00.000Z" }],
      events: [{ machineId: "server-01", type: "pipeline.paused", createdAt: "2026-06-18T01:10:00.000Z" }],
    }).map(([type]) => type),
    ["resume_pipeline", "stop_pipeline", "sync_config", "sync_env"]
  );
});

test("machine disk usage uses summed capacity instead of highest drive percent", () => {
  const machine = {
    disk: [
      { mount: "C:", totalBytes: 100, usedBytes: 82, percentUsed: 82 },
      { mount: "D:", totalBytes: 900, usedBytes: 90, percentUsed: 10 },
    ],
  };

  assert.equal(diskPeakForMachine(machine), 17);
  assert.equal(buildOverviewModel({ machines: [machine] }).diskPressure, 17);
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
  assert.equal(onboarding.dashboardUrl, "https://ptg-dashboard.example.com");
  assert.match(onboarding.command, /npm run agent:install/);
  assert.doesNotMatch(onboarding.command, /MACHINE_ID=/);
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

test("server onboarding exposes Windows startup agent commands", () => {
  const command = buildWindowsAgentInstallCommand();

  assert.match(command, /npm run agent:install/);
  assert.match(command, /npm run agent:start-service/);
  assert.match(command, /npm run agent:status-service/);
  assert.equal(command.includes("MACHINE_ID="), false);
});
