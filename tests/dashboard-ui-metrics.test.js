import test from "node:test";
import assert from "node:assert/strict";

import { buildGlobalSearchResults } from "../dashboard/client/lib/global-search.js";
import { completedConfigDeleteCandidates, completedConfigPromptKey } from "../dashboard/client/lib/completed-configs.js";
import { eventDisplayMessage, eventDisplayTitle, formatEventConsoleLine } from "../dashboard/client/lib/event-display.js";
import { eventNotificationId, eventRecordId } from "../dashboard/client/lib/event-identity.js";
import { buildCredentialSecretValue, buildMachineCommandRows, buildOverviewModel, buildServerOnboarding, buildWindowsAgentEnv, buildWindowsAgentInstallCommand, nextServerDefaults } from "../dashboard/client/lib/overview-model.js";
import { buildDashboardDocumentTitle } from "../dashboard/client/lib/page-title.js";
import { defaultConfigSplitAcrossMachines, diskPeakForMachine, envValueFromText, mergeDashboardSettings } from "../dashboard/client/components/dashboard-core.js";

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
  assert.equal(model.diskPressure, 67);
  assert.deepEqual(model.pipeline.map((step) => step.label), ["내리적재", "검증", "압축", "올리적재"]);
  assert.equal(model.pipeline[0].status, "running");
  assert.equal(model.pipeline[1].status, "complete");
  assert.equal(model.resourceAlerts.length, 2);
  assert.equal(model.activeRanges[0].name, "ukraine-range-01");
});

test("client settings preserve global env template values", () => {
  const settings = mergeDashboardSettings({
    rootEnvTemplate: {
      envText: "DASHBOARD_URL=https://dashboard.example\nTELEGRAM_CHAT_ID=-100123\n",
      sourceMachineId: "global",
      updatedAt: "2026-06-16T00:00:00.000Z",
    },
  });

  assert.equal(settings.rootEnvTemplate.envText.includes("TELEGRAM_CHAT_ID=-100123"), true);
  assert.equal(settings.rootEnvTemplate.sourceMachineId, "global");
  assert.equal(envValueFromText(settings.rootEnvTemplate.envText, "TELEGRAM_CHAT_ID"), "-100123");
});

test("client settings preserve runtime telegram chat id fallback", () => {
  const settings = mergeDashboardSettings({
    telegramEnv: {
      botTokenConfigured: true,
      chatId: "-100456",
    },
  });

  assert.equal(settings.telegramEnv.botTokenConfigured, true);
  assert.equal(settings.telegramEnv.chatId, "-100456");
});

test("config editor defaults range splitting on for multiple selected servers", () => {
  assert.equal(defaultConfigSplitAcrossMachines(["worker-a", "worker-b"]), true);
  assert.equal(defaultConfigSplitAcrossMachines(["worker-a"]), false);
  assert.equal(defaultConfigSplitAcrossMachines([]), false);
});

test("event notification identity uses the durable event id field", () => {
  const localStoreEvent = { id: "evt-local", type: "command.accepted", message: "accepted" };
  const postgresEvent = { eventId: "evt-postgres", type: "command.accepted", message: "accepted" };

  assert.equal(eventRecordId(localStoreEvent), "evt-local");
  assert.equal(eventRecordId(postgresEvent), "evt-postgres");
  assert.equal(eventNotificationId(localStoreEvent), "event-evt-local");
  assert.equal(eventNotificationId(postgresEvent), "event-evt-postgres");
});

test("event display localizes dashboard-run sync records", () => {
  const event = {
    type: "dashboard-run.synced",
    severity: "info",
    message: "Local command loaded dashboard-managed config, env, and secrets.",
    createdAt: "2026-06-22T01:12:00.000Z",
  };

  assert.equal(eventDisplayTitle(event), "대시보드 설정 동기화 완료");
  assert.equal(eventDisplayMessage(event), "이 작업기가 대시보드의 Config, .Env, API Key/Proxy 설정을 불러왔습니다.");
  assert.match(formatEventConsoleLine(event), /정보\s+대시보드 설정 동기화 완료/);
});

test("event display includes the event machine source", () => {
  const event = {
    machineId: "server-03",
    type: "command.failed",
    severity: "error",
    message: "Command failed: git pull --ff-only",
    createdAt: "2026-06-22T10:07:00.000Z",
  };

  assert.equal(eventDisplayTitle(event), "server-03 · 명령 실패");
  assert.equal(eventDisplayTitle(event, { machineLabel: "SERVER-03" }), "SERVER-03 · 명령 실패");
  assert.match(formatEventConsoleLine(event), /server-03\s+오류\s+명령 실패/);
});

test("event display includes config and range context for pipeline lifecycle events", () => {
  const completed = {
    machineId: "server-02",
    type: "pipeline.completed",
    severity: "success",
    message: "pipeline completed",
    createdAt: "2026-06-22T10:26:06.000Z",
    data: {
      configName: "1-pyongyang-esri-satellite",
      configPath: ".tile-state/dashboard/configs/cfg-a.json",
      ranges: 10,
    },
  };
  const rangeFailed = {
    machineId: "server-02",
    type: "range.failed",
    severity: "error",
    message: "zip failed",
    createdAt: "2026-06-22T10:26:06.000Z",
    data: {
      configName: "1-pyongyang-esri-satellite",
      rangeIndex: 2,
      ranges: 10,
    },
  };

  assert.match(formatEventConsoleLine(completed), /pipeline completed \| Config 1-pyongyang-esri-satellite/);
  assert.match(formatEventConsoleLine(rangeFailed), /zip failed \| Config 1-pyongyang-esri-satellite \| 범위 3\/10/);
});

test("global search uses localized event labels and messages", () => {
  const [result] = buildGlobalSearchResults({
    globalEvents: [{
      eventId: "evt-sync",
      machineId: "worker-a",
      type: "dashboard-run.synced",
      severity: "info",
      message: "Local command loaded dashboard-managed config, env, and secrets.",
    }],
  }, "대시보드 설정");

  assert.equal(result.title, "worker-a · 대시보드 설정 동기화 완료");
  assert.equal(result.detail, "worker-a | 이 작업기가 대시보드의 Config, .Env, API Key/Proxy 설정을 불러왔습니다.");
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

  assert.equal(model.activeRanges.length, 1);
  assert.equal(model.activeRanges[0].z, "18-19");
  assert.equal(model.activeRanges[0].rangeCount, 2);
  assert.equal(model.activeRanges[0].tiles, 61915617);
});

test("overview model summarizes each active config once with full range and tile totals", () => {
  const model = buildOverviewModel({
    configs: [
      {
        name: "1-pyongyang-mapbox-satellite",
        active: true,
        config: {
          ranges: [
            { zoomStart: 7, zoomEnd: 7, xStart: 1, xEnd: 2, yStart: 1, yEnd: 1 },
            { zoomStart: 8, zoomEnd: 8, xStart: 1, xEnd: 2, yStart: 1, yEnd: 1 },
            { zoomStart: 9, zoomEnd: 9, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1 },
          ],
        },
      },
      {
        name: "2-chiba-narita-esri-satellite",
        active: true,
        config: {
          ranges: [
            { zoomStart: 7, zoomEnd: 8, xStart: 1, xEnd: 2, yStart: 1, yEnd: 1 },
          ],
        },
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        name: `extra-config-${index + 1}`,
        active: true,
        config: {
          ranges: [{ zoom: 10 + index, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1 }],
        },
      })),
    ],
  });

  assert.equal(model.activeRanges.length, 7);
  assert.deepEqual(
    model.activeRanges.map((range) => range.name),
    [
      "1-pyongyang-mapbox-satellite",
      "2-chiba-narita-esri-satellite",
      "extra-config-1",
      "extra-config-2",
      "extra-config-3",
      "extra-config-4",
      "extra-config-5",
    ],
  );
  assert.deepEqual(model.activeRanges[0], {
    name: "1-pyongyang-mapbox-satellite",
    z: "7-9",
    rangeCount: 3,
    tiles: 5,
    progress: 0,
    throughput: 0,
    status: "queued",
  });
  assert.equal(model.activeRanges[1].z, "7-8");
  assert.equal(model.activeRanges[1].rangeCount, 1);
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

test("overview model preserves multiple active config processes for one server", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-02", status: "online", currentJobId: "job-esri" }],
    configs: [
      { configId: "cfg-esri", name: "1-pyongyang-esri-satellite" },
      { configId: "cfg-mapbox", name: "2-chiba-mapbox-pbf" },
    ],
    jobs: [
      {
        jobId: "job-esri",
        machineId: "server-02",
        configId: "cfg-esri",
        status: "running",
        stage: "upload",
        startedAt: "2026-06-22T10:00:00.000Z",
        progress: {
          percent: 75,
          tilesDone: 750,
          tilesTotal: 1000,
          tilesPerSecond: 25,
        },
      },
      {
        jobId: "job-mapbox",
        machineId: "server-02",
        configId: "cfg-mapbox",
        status: "running",
        stage: "download",
        startedAt: "2026-06-22T10:01:00.000Z",
        progress: {
          percent: 50,
          tilesDone: 250,
          tilesTotal: 500,
          tilesPerSecond: 50,
        },
      },
    ],
    machineId: "server-02",
  });

  assert.equal(model.kpis.activeJobs.value, 2);
  assert.equal(model.pipelineSummary.activeProcesses, 2);
  assert.equal(model.pipelineSummary.processedTiles, 1000);
  assert.equal(model.pipelineSummary.totalTiles, 1500);
  assert.equal(model.pipelineSummary.completedConfigLabel, "0/2 완료");
  assert.equal(model.pipelineProgress, "53%");
  assert.equal(model.pipelineStage, "여러 단계");
  assert.deepEqual(
    model.pipeline.map((step) => [step.key, step.progress]),
    [
      ["download", 75],
      ["validate", 50],
      ["zip", 50],
      ["upload", 38],
    ]
  );
  assert.equal(model.pipelineProcesses.length, 2);
  assert.deepEqual(
    model.pipelineProcesses.map((process) => [process.configName, process.stageLabel, process.progressLabel]),
    [
      ["1-pyongyang-esri-satellite", "올리적재", "94%"],
      ["2-chiba-mapbox-pbf", "내리적재", "13%"],
    ]
  );
  assert.equal(model.machineProcesses["server-02"].processLabel, "2개 공정");
  assert.equal(model.machineProcesses["server-02"].progressLabel, "67%");
});

test("selected server pipeline stats include pending assigned configs when only one config is active", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-02", status: "online", currentJobId: "job-esri" }],
    configs: [
      { configId: "cfg-satellite", machineId: "server-02", name: "1-pyongyang-mapbox-satellite" },
      { configId: "cfg-pbf", machineId: "server-02", name: "1-pyongyang-mapbox-pbf" },
      { configId: "cfg-esri", machineId: "server-02", name: "1-pyongyang-esri-satellite" },
    ],
    jobs: [
      {
        jobId: "job-esri",
        machineId: "server-02",
        configId: "cfg-esri",
        status: "running",
        stage: "download",
        startedAt: "2026-06-23T11:37:00.000Z",
        progress: {
          percent: 100,
          rangeIndex: 8,
          rangeCount: 10,
          tilesDone: 110,
          tilesTotal: 110,
          tilesPerSecond: 47,
        },
      },
    ],
    machineId: "server-02",
  });

  assert.equal(model.pipelineSummary.totalConfigs, 3);
  assert.equal(model.pipelineSummary.completedConfigLabel, "0/3 완료");
  assert.equal(model.pipelineProgress, "25%");
  assert.equal(model.pipelineStage, "내리적재");
  assert.equal(model.pipelineEta, "계산중");
  assert.deepEqual(
    model.pipeline.map((step) => [step.key, step.progress, step.status]),
    [
      ["download", 100, "running"],
      ["validate", 0, "pending"],
      ["zip", 0, "pending"],
      ["upload", 0, "pending"],
    ]
  );
  assert.deepEqual(
    model.pipelineProcesses.map((process) => [process.configName, process.stageLabel, process.statusLabel, process.progressLabel]),
    [
      ["1-pyongyang-mapbox-satellite", "대기중", "대기중", "0%"],
      ["1-pyongyang-mapbox-pbf", "대기중", "대기중", "0%"],
      ["1-pyongyang-esri-satellite", "내리적재", "진행중", "25%"],
    ]
  );
});

test("selected server pipeline step progress follows the active config job", () => {
  const model = buildOverviewModel({
    now: new Date("2026-06-23T14:04:00.000Z"),
    machines: [{ machineId: "server-02", status: "online", currentJobId: "job-satellite-active" }],
    configs: [
      { configId: "cfg-esri", machineId: "server-02", name: "1-pyongyang-esri-satellite" },
      { configId: "cfg-pbf", machineId: "server-02", name: "1-pyongyang-mapbox-pbf" },
      { configId: "cfg-satellite", machineId: "server-02", name: "1-pyongyang-mapbox-satellite" },
    ],
    jobs: [
      {
        jobId: "job-esri-complete",
        machineId: "server-02",
        configId: "cfg-esri",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T12:00:00.000Z",
        finishedAt: "2026-06-23T12:05:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-esri-satellite/",
        },
      },
      {
        jobId: "job-pbf-complete",
        machineId: "server-02",
        configId: "cfg-pbf",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T12:10:00.000Z",
        finishedAt: "2026-06-23T12:15:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-mapbox-pbf/",
        },
      },
      {
        jobId: "job-satellite-old-complete",
        machineId: "server-02",
        configId: "cfg-satellite",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T12:20:00.000Z",
        finishedAt: "2026-06-23T12:25:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-mapbox-satellite/",
        },
      },
      {
        jobId: "job-satellite-active",
        machineId: "server-02",
        configId: "cfg-satellite",
        status: "running",
        stage: "download",
        startedAt: "2026-06-23T14:03:00.000Z",
        updatedAt: "2026-06-23T14:03:30.000Z",
        progress: {
          percent: 81,
          tilesDone: 323,
          tilesTotal: 399,
          tilesPerSecond: 19,
          etaSeconds: 3,
        },
      },
    ],
    machineId: "server-02",
  });

  assert.equal(model.pipelineProgress, "20%");
  assert.equal(model.pipelineEta, "3초");
  assert.equal(model.pipelineSummary.completedConfigLabel, "2/3 완료");
  assert.equal(model.pipelineSummary.processedTiles, 323);
  assert.equal(model.pipelineSummary.totalTiles, 399);
  assert.deepEqual(
    model.pipeline.map((step) => [step.key, step.progress, step.status]),
    [
      ["download", 81, "running"],
      ["validate", 0, "pending"],
      ["zip", 0, "pending"],
      ["upload", 0, "pending"],
    ]
  );
  assert.deepEqual(
    model.pipelineProcesses.map((process) => [process.configName, process.stageLabel, process.statusLabel, process.progressLabel]),
    [
      ["1-pyongyang-esri-satellite", "올리적재", "완료", "100%"],
      ["1-pyongyang-mapbox-pbf", "올리적재", "완료", "100%"],
      ["1-pyongyang-mapbox-satellite", "내리적재", "진행중", "20%"],
    ]
  );
});

test("selected server pipeline upload phase is not marked complete until active upload completes", () => {
  const model = buildOverviewModel({
    now: new Date("2026-06-23T14:11:00.000Z"),
    machines: [{ machineId: "server-02", status: "online", currentJobId: "job-satellite-upload" }],
    configs: [
      { configId: "cfg-esri", machineId: "server-02", name: "1-pyongyang-esri-satellite" },
      { configId: "cfg-pbf", machineId: "server-02", name: "1-pyongyang-mapbox-pbf" },
      { configId: "cfg-satellite", machineId: "server-02", name: "1-pyongyang-mapbox-satellite" },
    ],
    jobs: [
      {
        jobId: "job-esri-complete",
        machineId: "server-02",
        configId: "cfg-esri",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T12:00:00.000Z",
        finishedAt: "2026-06-23T12:05:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-esri-satellite/",
        },
      },
      {
        jobId: "job-pbf-complete",
        machineId: "server-02",
        configId: "cfg-pbf",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T12:10:00.000Z",
        finishedAt: "2026-06-23T12:15:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-mapbox-pbf/",
        },
      },
      {
        jobId: "job-satellite-old-complete",
        machineId: "server-02",
        configId: "cfg-satellite",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T12:20:00.000Z",
        finishedAt: "2026-06-23T12:25:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-mapbox-satellite/",
        },
      },
      {
        jobId: "job-satellite-upload",
        machineId: "server-02",
        configId: "cfg-satellite",
        status: "running",
        stage: "upload",
        startedAt: "2026-06-23T14:10:00.000Z",
        updatedAt: "2026-06-23T14:10:30.000Z",
        progress: {
          percent: 0,
        },
      },
    ],
    machineId: "server-02",
  });

  assert.equal(model.pipelineProgress, "75%");
  assert.equal(model.pipelineStage, "올리적재");
  assert.equal(model.pipelineEta, "계산중");
  assert.equal(model.pipelineSummary.completedConfigLabel, "2/3 완료");
  assert.deepEqual(
    model.pipeline.map((step) => [step.key, step.progress, step.status]),
    [
      ["download", 100, "complete"],
      ["validate", 100, "complete"],
      ["zip", 100, "complete"],
      ["upload", 0, "running"],
    ]
  );
  assert.deepEqual(
    model.pipelineProcesses.map((process) => [process.configName, process.stageLabel, process.statusLabel, process.progressLabel]),
    [
      ["1-pyongyang-esri-satellite", "올리적재", "완료", "100%"],
      ["1-pyongyang-mapbox-pbf", "올리적재", "완료", "100%"],
      ["1-pyongyang-mapbox-satellite", "올리적재", "진행중", "75%"],
    ]
  );
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

test("overview model marks online running jobs stale when progress stops updating", () => {
  const model = buildOverviewModel({
    now: new Date("2026-06-19T12:00:00.000Z"),
    machines: [
      { machineId: "server-08", status: "online", currentJobId: "job-server-08" },
      { machineId: "server-09", status: "online", currentJobId: "job-server-09" },
    ],
    jobs: [
      {
        jobId: "job-server-08",
        machineId: "server-08",
        status: "running",
        stage: "download",
        updatedAt: "2026-06-19T11:55:00.000Z",
        progress: {
          percent: 52,
          tilesDone: 520,
          tilesTotal: 1000,
          tilesPerSecond: 0,
        },
      },
      {
        jobId: "job-server-09",
        machineId: "server-09",
        status: "running",
        stage: "download",
        updatedAt: "2026-06-19T11:55:01.000Z",
        progress: {
          percent: 53,
          tilesDone: 530,
          tilesTotal: 1000,
          tilesPerSecond: 300,
        },
      },
    ],
  });

  assert.equal(model.machineProcesses["server-08"].statusLabel, "멈춤");
  assert.equal(model.machineProcesses["server-08"].etaLabel, "진행 멈춤");
  assert.equal(model.machineProcesses["server-08"].tone, "error");
  assert.equal(model.machineProcesses["server-09"].statusLabel, "진행중");
  assert.equal(model.machineProcesses["server-09"].stale, false);
});

test("server management document title shows server number step and active job percent", () => {
  const title = buildDashboardDocumentTitle({
    authStatus: "authenticated",
    selectedTab: "servers",
    selectedMachineId: "server-06",
    editor: { type: "server-management", machineId: "server-06" },
    machines: [{ machineId: "server-06", status: "online", currentJobId: "job-server-06" }],
    jobs: [
      {
        jobId: "job-server-06",
        machineId: "server-06",
        status: "running",
        stage: "download",
        progress: { percent: 73 },
      },
    ],
    events: [],
    configs: [],
    secretPool: [],
    settings: {},
  });

  assert.equal(title, "PTG 관리체계 | 06:1:73%");
});

test("server management document title waits for authenticated dashboard state", () => {
  const title = buildDashboardDocumentTitle({
    authStatus: "unauthenticated",
    selectedTab: "servers",
    selectedMachineId: "server-06",
    editor: { type: "server-management", machineId: "server-06" },
  });

  assert.equal(title, "PTG 관리체계");
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
    configs: [
      { configId: "cfg-1", name: "1-pyongyang-esri-satellite" },
      { configId: "cfg-2", name: "2-chiba-mapbox-pbf" },
      { configId: "cfg-3", name: "3-tokyo-mapbox-satellite" },
    ],
    jobs: [
      {
        jobId: "job-server-09",
        machineId: "server-09",
        configId: "cfg-1",
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
      {
        jobId: "job-server-09-b",
        machineId: "server-09",
        configId: "cfg-2",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-16T00:20:00.000Z",
        finishedAt: "2026-06-16T00:30:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/testshare/mapbox/range-2/",
          storjRawLinkPrefix: "https://link.storjshare.io/raw/testshare/mapbox/range-2/",
        },
      },
      {
        jobId: "job-server-09-c",
        machineId: "server-09",
        configId: "cfg-3",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-16T00:15:00.000Z",
        finishedAt: "2026-06-16T00:25:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/testshare/mapbox/range-3/",
          storjRawLinkPrefix: "https://link.storjshare.io/raw/testshare/mapbox/range-3/",
        },
      },
    ],
    machineId: "server-09",
  });

  assert.equal(model.pipelineStage, "올리적재");
  assert.equal(model.pipelineProgress, "100%");
  assert.equal(model.pipelineEta, "완료");
  assert.equal(model.storjShareUrl, "https://link.storjshare.io/s/testshare/mapbox/range-1/");
  assert.deepEqual(
    model.storjLinks.map((link) => [link.machineId, link.jobId, link.configName, link.shareUrl]),
    [
      ["server-09", "job-server-09", "1-pyongyang-esri-satellite", "https://link.storjshare.io/s/testshare/mapbox/range-1/"],
      ["server-09", "job-server-09-b", "2-chiba-mapbox-pbf", "https://link.storjshare.io/s/testshare/mapbox/range-2/"],
      ["server-09", "job-server-09-c", "3-tokyo-mapbox-satellite", "https://link.storjshare.io/s/testshare/mapbox/range-3/"],
    ]
  );
});

test("overview model shows partial config completion from storj proofs", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-02", status: "online" }],
    configs: [
      { configId: "cfg-satellite", machineId: "server-02", name: "1-pyongyang-mapbox-satellite" },
      { configId: "cfg-pbf", machineId: "server-02", name: "1-pyongyang-mapbox-pbf" },
      { configId: "cfg-esri", machineId: "server-02", name: "1-pyongyang-esri-satellite" },
    ],
    jobs: [
      {
        jobId: "job-pbf",
        machineId: "server-02",
        configId: "cfg-pbf",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T01:40:00.000Z",
        finishedAt: "2026-06-23T01:45:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-mapbox-pbf/",
        },
      },
      {
        jobId: "job-esri",
        machineId: "server-02",
        configId: "cfg-esri",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T01:35:00.000Z",
        finishedAt: "2026-06-23T01:39:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-esri-satellite/",
        },
      },
    ],
    machineId: "server-02",
  });

  assert.equal(model.pipelineProgress, "67%");
  assert.equal(model.pipelineEta, "2/3 완료");
  assert.equal(model.pipelineSummary.completedConfigLabel, "2/3 완료");
  assert.equal(model.pipelineStage, "대기중");
  assert.deepEqual(
    model.pipeline.map((step) => [step.key, step.progress, step.status]),
    [
      ["download", 0, "pending"],
      ["validate", 0, "pending"],
      ["zip", 0, "pending"],
      ["upload", 0, "pending"],
    ]
  );
  assert.deepEqual(
    model.storjLinks.map((link) => [link.configName, link.shareUrl]),
    [
      ["1-pyongyang-mapbox-pbf", "https://link.storjshare.io/s/token/mapbox/1-pyongyang-mapbox-pbf/"],
      ["1-pyongyang-esri-satellite", "https://link.storjshare.io/s/token/mapbox/1-pyongyang-esri-satellite/"],
    ]
  );
});

test("overview model does not turn completed proofs into active stage progress", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-02", status: "online" }],
    configs: [
      { configId: "cfg-esri", machineId: "server-02", name: "1-pyongyang-esri-satellite" },
      { configId: "cfg-pbf", machineId: "server-02", name: "1-pyongyang-mapbox-pbf" },
      { configId: "cfg-satellite", machineId: "server-02", name: "1-pyongyang-mapbox-satellite" },
    ],
    jobs: [
      {
        jobId: "job-esri",
        machineId: "server-02",
        configId: "cfg-esri",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-23T11:40:00.000Z",
        finishedAt: "2026-06-23T11:45:00.000Z",
        progress: {
          percent: 100,
          storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-esri-satellite/",
        },
      },
    ],
    machineId: "server-02",
  });

  assert.equal(model.pipelineProgress, "33%");
  assert.equal(model.pipelineEta, "1/3 완료");
  assert.equal(model.pipelineStage, "대기중");
  assert.deepEqual(
    model.pipeline.map((step) => [step.key, step.progress, step.status]),
    [
      ["download", 0, "pending"],
      ["validate", 0, "pending"],
      ["zip", 0, "pending"],
      ["upload", 0, "pending"],
    ]
  );
});

test("overview model ignores completed proofs for configs deleted from the current selection", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-02", status: "online" }],
    configs: Array.from({ length: 15 }, (_, index) => ({
      configId: `active-cfg-${index + 1}`,
      machineId: "server-02",
      name: `active-config-${index + 1}`,
    })),
    jobs: Array.from({ length: 6 }, (_, index) => ({
      jobId: `deleted-complete-${index + 1}`,
      machineId: "server-02",
      configId: `deleted-cfg-${index + 1}`,
      status: "completed",
      stage: "upload",
      startedAt: `2026-06-23T11:${String(index).padStart(2, "0")}:00.000Z`,
      finishedAt: `2026-06-23T11:${String(index).padStart(2, "0")}:30.000Z`,
      progress: {
        percent: 100,
        storjShareUrl: `https://link.storjshare.io/s/token/mapbox/deleted-config-${index + 1}/`,
      },
    })),
    machineId: "server-02",
  });

  assert.equal(model.pipelineProgress, "0%");
  assert.equal(model.pipelineEta, "0/15 완료");
  assert.equal(model.pipelineSummary.completedConfigLabel, "0/15 완료");
  assert.equal(model.pipelineSummary.completedConfigs, 0);
  assert.equal(model.pipelineSummary.totalConfigs, 15);
  assert.equal(model.storjLinks.length, 0);
});

test("overview model publishes each completed config storj link before every selected config completes", () => {
  const base = {
    machines: [{ machineId: "server-02", status: "online" }],
    configs: [
      { configId: "cfg-satellite", machineId: "server-02", name: "1-pyongyang-mapbox-satellite" },
      { configId: "cfg-pbf", machineId: "server-02", name: "1-pyongyang-mapbox-pbf" },
      { configId: "cfg-esri", machineId: "server-02", name: "1-pyongyang-esri-satellite" },
    ],
    machineId: "server-02",
  };
  const completedJobs = [
    ["cfg-satellite", "1-pyongyang-mapbox-satellite", "2026-06-23T01:50:00.000Z"],
    ["cfg-pbf", "1-pyongyang-mapbox-pbf", "2026-06-23T01:45:00.000Z"],
    ["cfg-esri", "1-pyongyang-esri-satellite", "2026-06-23T01:40:00.000Z"],
  ].map(([configId, name, startedAt]) => ({
    jobId: `job-${configId}`,
    machineId: "server-02",
    configId,
    status: "completed",
    stage: "upload",
    startedAt,
    finishedAt: startedAt,
    progress: {
      percent: 100,
      storjShareUrl: `https://link.storjshare.io/s/token/mapbox/${name}/`,
    },
  }));

  const incomplete = buildOverviewModel({
    ...base,
    jobs: [
      ...completedJobs.slice(0, 2),
      {
        jobId: "job-stopped-upload",
        machineId: "server-02",
        configId: "cfg-esri",
        status: "stopped",
        stage: "upload",
        startedAt: "2026-06-23T01:55:00.000Z",
        progress: {
          percent: 75,
          rangeIndex: 3,
          rangeCount: 10,
        },
      },
    ],
  });

  assert.equal(incomplete.pipelineProgress, "67%");
  assert.equal(incomplete.pipelineEta, "2/3 완료");
  assert.deepEqual(
    incomplete.storjLinks.map((link) => link.configName),
    ["1-pyongyang-mapbox-satellite", "1-pyongyang-mapbox-pbf"]
  );
  assert.equal(incomplete.storjShareUrl, "https://link.storjshare.io/s/token/mapbox/1-pyongyang-mapbox-satellite/");

  const complete = buildOverviewModel({
    ...base,
    jobs: completedJobs,
  });

  assert.equal(complete.pipelineProgress, "100%");
  assert.equal(complete.pipelineEta, "완료");
  assert.deepEqual(
    complete.storjLinks.map((link) => link.configName),
    ["1-pyongyang-mapbox-satellite", "1-pyongyang-mapbox-pbf", "1-pyongyang-esri-satellite"]
  );
});

test("overview model collapses multiple range upload proofs to one link per config", () => {
  const jobs = Array.from({ length: 10 }, (_, index) => ({
    jobId: `job-range-${index}`,
    machineId: "server-02",
    configId: `old-partial-cfg-${index}`,
    status: "completed",
    stage: "upload",
    startedAt: `2026-06-22T10:${String(index).padStart(2, "0")}:00.000Z`,
    finishedAt: `2026-06-22T10:${String(index).padStart(2, "0")}:30.000Z`,
    rangeId: `range-${index}`,
    progress: {
      percent: 100,
      storjShareUrl: `https://link.storjshare.io/s/token-${index}/mapbox/1-pyongyang-esri-satellite/`,
    },
  }));
  const model = buildOverviewModel({
    machines: [{ machineId: "server-02", status: "online" }],
    configs: [],
    jobs,
    machineId: "server-02",
  });

  assert.equal(model.storjLinks.length, 1);
  assert.equal(model.storjLinks[0].configId, "old-partial-cfg-9");
  assert.equal(model.storjLinks[0].configName, "1-pyongyang-esri-satellite");
  assert.equal(model.storjLinks[0].shareUrl, "https://link.storjshare.io/s/token-9/mapbox/1-pyongyang-esri-satellite/");
});

test("overview model uses storj url path as config label when completed config was deleted", () => {
  const model = buildOverviewModel({
    machines: [{ machineId: "server-02", status: "online" }],
    configs: [],
    jobs: [{
      jobId: "job-range-1",
      machineId: "server-02",
      configId: "cfg-deleted",
      configName: "25915295-c271-4284-b21f-c79c37125865",
      status: "completed",
      stage: "upload",
      startedAt: "2026-06-22T10:00:00.000Z",
      progress: {
        percent: 100,
        storjShareUrl: "https://link.storjshare.io/s/token/mapbox/1-pyongyang-esri-satellite/",
      },
    }],
    machineId: "server-02",
  });

  assert.equal(model.storjLinks.length, 1);
  assert.equal(model.storjLinks[0].configName, "1-pyongyang-esri-satellite");
});

test("completed config delete prompt candidates come from completed storj jobs with live configs", () => {
  const candidates = completedConfigDeleteCandidates({
    machines: [{ machineId: "server-09", status: "online" }],
    configs: [
      { configId: "cfg-1", machineId: "server-09", name: "1-pyongyang-esri-satellite" },
      { configId: "cfg-2", machineId: "server-09", name: "2-chiba-mapbox-pbf" },
    ],
    jobs: [
      {
        jobId: "job-a",
        machineId: "server-09",
        configId: "cfg-1",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-16T00:25:00.000Z",
        progress: {
          storjShareUrl: "https://link.storjshare.io/s/testshare/mapbox/range-1/",
        },
      },
      {
        jobId: "job-b",
        machineId: "server-09",
        configId: "cfg-2",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-16T00:20:00.000Z",
        progress: {
          storjShareUrl: "https://link.storjshare.io/s/testshare/mapbox/range-2/",
        },
      },
      {
        jobId: "job-deleted-config",
        machineId: "server-09",
        configId: "cfg-deleted",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-16T00:15:00.000Z",
        progress: {
          storjShareUrl: "https://link.storjshare.io/s/testshare/mapbox/deleted/",
        },
      },
      {
        jobId: "job-without-proof",
        machineId: "server-09",
        configId: "cfg-2",
        status: "completed",
        stage: "upload",
        startedAt: "2026-06-16T00:10:00.000Z",
        progress: {
          percent: 100,
        },
      },
    ],
  });

  assert.deepEqual(
    candidates.map((candidate) => [candidate.configId, candidate.configName, candidate.shareUrl]),
    [
      ["cfg-1", "1-pyongyang-esri-satellite", "https://link.storjshare.io/s/testshare/mapbox/range-1/"],
      ["cfg-2", "2-chiba-mapbox-pbf", "https://link.storjshare.io/s/testshare/mapbox/range-2/"],
    ]
  );
  assert.equal(
    completedConfigPromptKey(candidates),
    "cfg-1:https://link.storjshare.io/s/testshare/mapbox/range-1/|cfg-2:https://link.storjshare.io/s/testshare/mapbox/range-2/"
  );
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

test("fleet disk pressure uses total used bytes over total available capacity", () => {
  const model = buildOverviewModel({
    machines: [
      {
        machineId: "server-a",
        disk: [{ mount: "D:", totalBytes: 100, usedBytes: 74, percentUsed: 74 }],
      },
      {
        machineId: "server-b",
        disk: [{ mount: "D:", totalBytes: 900, usedBytes: 90, percentUsed: 10 }],
      },
    ],
  });

  assert.equal(model.diskPressure, 16);
  assert.equal(model.kpis.storagePressure.value, "16%");
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
