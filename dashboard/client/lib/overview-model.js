const PIPELINE_STEPS = [
  ["download", "내리적재"],
  ["validate", "검증"],
  ["zip", "압축"],
  ["upload", "올리적재"],
];
const SERVER_CREDENTIAL_SECRET_TYPES = new Set(["server_rdp_credential"]);
const RUNNING_JOB_STATUSES = new Set(["running", "queued", "claimed"]);
const CONTROL_UTILITY_COMMANDS = [
  ["sync_config", "Config 화일 동기화", "sync"],
  ["sync_env", ".Env 동기화", "sync"],
];

export function buildServerOnboarding({ dashboardUrl = "", machineId = "" } = {}) {
  const normalizedMachineId = String(machineId || "SERVER-01").trim() || "SERVER-01";
  const normalizedDashboardUrl = String(dashboardUrl || "https://your-railway-app.up.railway.app").trim() || "https://your-railway-app.up.railway.app";
  return {
    machineId: normalizedMachineId,
    dashboardUrl: normalizedDashboardUrl,
    command: buildWindowsAgentInstallCommand(),
  };
}

export function buildWindowsAgentEnv({ dashboardUrl = "", agentToken = "", machineId = "" } = {}) {
  const normalizedDashboardUrl = String(dashboardUrl || "https://your-railway-app.up.railway.app").trim() || "https://your-railway-app.up.railway.app";
  const normalizedAgentToken = String(agentToken || "").trim();
  const normalizedMachineId = (String(machineId || "server-01").trim() || "server-01").toLowerCase();
  return [
    `DASHBOARD_URL=${normalizedDashboardUrl}`,
    `AGENT_TOKEN=${normalizedAgentToken}`,
    `MACHINE_ID=${normalizedMachineId}`,
  ].join("\n");
}

export function buildWindowsAgentInstallCommand() {
  return [
    "npm run agent:install",
    "npm run agent:start-service",
    "npm run agent:status-service",
  ].join("\n");
}

function serverNumberFromText(value) {
  const match = /\bserver[\s_-]*(\d+)\b/i.exec(String(value || ""));
  return match ? Number.parseInt(match[1], 10) : null;
}

function collectServerNumbers({ machines = [], secretPool = [] } = {}) {
  const numbers = [];
  const add = (value) => {
    const number = serverNumberFromText(value);
    if (Number.isInteger(number) && number > 0) numbers.push(number);
  };
  for (const machine of machines) {
    add(machine.machineId);
    add(machine.displayName);
  }
  for (const secret of secretPool) {
    if (!SERVER_CREDENTIAL_SECRET_TYPES.has(secret.secretType)) continue;
    add(secret.label);
    add(secret.machineId);
    add(secret.targetMachineId);
    add(secret.credential?.machineId);
  }
  return numbers;
}

export function nextServerDefaults(source = {}) {
  const highest = Math.max(0, ...collectServerNumbers(source));
  const number = highest + 1;
  const suffix = String(number).padStart(2, "0");
  return {
    number,
    label: `봉사기 ${suffix}`,
    machineId: `server-${suffix}`,
  };
}

export function buildCredentialSecretValue({
  protocolUrl = "",
  machineId = "",
  username = "",
  password = "",
} = {}) {
  const normalizedMachineId = String(machineId || "").trim().toLowerCase();
  return JSON.stringify({
    protocolUrl: String(protocolUrl || "").trim(),
    ...(normalizedMachineId ? { machineId: normalizedMachineId } : {}),
    username: String(username || "").trim(),
    password: String(password ?? ""),
  });
}

function thresholdValue(settings, name, fallback) {
  const value = Number(settings?.alertThresholds?.[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function diskPeak(machine) {
  const disks = machine?.disk || [];
  const totalBytes = disks.reduce((sum, disk) => sum + (Number(disk.totalBytes) || 0), 0);
  const usedBytes = disks.reduce((sum, disk) => {
    const explicitUsed = Number(disk.usedBytes);
    if (Number.isFinite(explicitUsed) && explicitUsed >= 0) return sum + explicitUsed;
    const total = Number(disk.totalBytes) || 0;
    const free = Number(disk.freeBytes) || 0;
    return sum + Math.max(0, total - free);
  }, 0);
  if (totalBytes > 0) return Math.round((usedBytes / totalBytes) * 100);
  return Math.max(0, ...disks.map((disk) => Number(disk.percentUsed) || 0));
}

function secretCounts(secrets, secretType) {
  const items = secrets.filter((secret) => secret.secretType === secretType);
  const available = items.filter((secret) => secret.status === "active").length;
  const assigned = items.filter((secret) => secret.status === "active" && secret.machineId).length;
  const disabled = items.length - available;
  return { total: items.length, available, assigned, disabled };
}

function scopedJobsForMachine(jobs = [], machineId) {
  return jobs.filter((job) => jobMachineMatches(job, machineId));
}

function activeJobCount(jobs = [], machineId) {
  return scopedJobsForMachine(jobs, machineId).filter((job) => RUNNING_JOB_STATUSES.has(job.status)).length;
}

function queuedJobCount(jobs = [], machineId) {
  return scopedJobsForMachine(jobs, machineId).filter((job) => job.status === "queued").length;
}

function averageDownloadThroughput(jobs = [], machineId) {
  const downloadingJobs = scopedJobsForMachine(jobs, machineId)
    .filter((job) => RUNNING_JOB_STATUSES.has(job.status))
    .filter((job) => String(job.stage || "").toLowerCase() === "download")
    .map((job) => Number(job.progress?.tilesPerSecond ?? job.progress?.tileRate ?? job.progress?.rate))
    .filter((rate) => Number.isFinite(rate) && rate > 0);
  if (!downloadingJobs.length) return { average: 0, count: 0 };
  const total = downloadingJobs.reduce((sum, rate) => sum + rate, 0);
  return {
    average: total / downloadingJobs.length,
    total,
    count: downloadingJobs.length,
  };
}

function jobProgressNumber(job, ...names) {
  const progress = job?.progress || {};
  for (const name of names) {
    const value = Number(progress[name]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function jobTotalWeight(job) {
  const total = jobProgressNumber(job, "tilesTotal", "total", "totalTiles");
  return total > 0 ? total : 1;
}

function failedTileCount(jobs = [], machineId) {
  return scopedJobsForMachine(jobs, machineId).reduce((sum, job) => {
    const value = jobProgressNumber(job, "tilesFailed", "failedTiles", "failures", "failed");
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

function failedTileMachines(jobs = [], machineId) {
  const counts = new Map();
  for (const job of scopedJobsForMachine(jobs, machineId)) {
    const value = jobProgressNumber(job, "tilesFailed", "failedTiles", "failures", "failed");
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = normalizeMachineId(job.machineId);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + value);
  }
  return [...counts.entries()]
    .map(([machineId, failedTiles]) => ({ machineId, failedTiles }))
    .sort((a, b) => b.failedTiles - a.failedTiles || a.machineId.localeCompare(b.machineId));
}

function pipelineStatus(events, step) {
  const completed = events.some((event) => event.type === `range.${step}.completed`);
  if (completed) return "complete";
  const running = events.some((event) => event.type === `range.${step}.started`);
  if (running) return "running";
  const failed = events.some((event) => event.type === `range.${step}.failed` || event.type === "range.failed");
  if (failed && step === "download") return "error";
  return "pending";
}

function normalizeMachineId(value) {
  return String(value || "").trim().toLowerCase();
}

function jobMachineMatches(job, machineId) {
  const normalizedMachineId = normalizeMachineId(machineId);
  if (!normalizedMachineId) return true;
  return normalizeMachineId(job.machineId) === normalizedMachineId;
}

function eventMachineMatches(event, machineId) {
  const normalizedMachineId = normalizeMachineId(machineId);
  if (!normalizedMachineId) return true;
  return normalizeMachineId(event.machineId || event.data?.machineId) === normalizedMachineId;
}

function newestFirst(a, b) {
  return String(b.createdAt || b.startedAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.startedAt || a.updatedAt || ""));
}

function isConsoleOutputEvent(event = {}) {
  return event.type === "process.output";
}

export function buildMachineCommandRows({ jobs = [], events = [], machineId } = {}) {
  if (!normalizeMachineId(machineId)) return [];
  const scopedJobs = jobs.filter((job) => jobMachineMatches(job, machineId)).sort(newestFirst);
  const activeJob = scopedJobs.find((job) => RUNNING_JOB_STATUSES.has(job.status));
  if (activeJob) {
    return [
      ["pause_after_range", "일시중지", "pause"],
      ["stop_pipeline", "정지", "stop"],
      ...CONTROL_UTILITY_COMMANDS,
    ];
  }

  const latestJob = scopedJobs[0] || null;
  const latestPause = events
    .filter((event) => event.type === "pipeline.paused" && eventMachineMatches(event, machineId))
    .sort(newestFirst)[0] || null;
  const latestPauseTime = String(latestPause?.createdAt || "");
  const latestJobTime = String(latestJob?.finishedAt || latestJob?.updatedAt || latestJob?.startedAt || "");
  const isPaused = latestPause && (!latestJob || latestPauseTime >= latestJobTime || latestJob.status === "completed");
  const lifecycleCommands = isPaused
    ? [
        ["resume_pipeline", "재개", "play"],
        ["stop_pipeline", "정지", "stop"],
      ]
    : [["start_pipeline", "시작", "play"]];

  return [
    ...lifecycleCommands,
    ...CONTROL_UTILITY_COMMANDS,
  ];
}

function stageIndex(stage) {
  const index = PIPELINE_STEPS.findIndex(([key]) => key === stage);
  return index >= 0 ? index : 0;
}

function numericProgress(progress = {}) {
  const percent = Number(progress.percent);
  if (Number.isFinite(percent)) return Math.max(0, Math.min(100, Math.round(percent)));
  const done = Number(progress.tilesDone ?? progress.done);
  const total = Number(progress.tilesTotal ?? progress.total);
  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }
  return null;
}

function jobStageProgress(job) {
  if (job?.status === "completed") return 100;
  return numericProgress(job?.progress) ?? 0;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "계산중";
  const whole = Math.round(seconds);
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${secs}초`;
  return `${secs}초`;
}

function buildPipelineSummary(scopedJobs = [], { machineId, machines = [] } = {}) {
  const runningJobs = scopedJobs.filter((job) => RUNNING_JOB_STATUSES.has(job.status));
  const summaryJobs = runningJobs.length ? runningJobs : scopedJobs.slice(0, 1);
  const activeMachineIds = [...new Set(summaryJobs.map((job) => normalizeMachineId(job.machineId)).filter(Boolean))];
  const processedTiles = summaryJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesDone", "done", "processedTiles")), 0);
  const totalTiles = summaryJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesTotal", "total", "totalTiles")), 0);
  const speedTilesPerSecond = summaryJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesPerSecond", "tileRate", "rate", "speedTilesPerSecond")), 0);
  const missingTiles = summaryJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesMissing", "missing", "missingTiles")), 0);
  const failedTiles = summaryJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesFailed", "failedTiles", "failures", "failed")), 0);
  const weightedProgress = summaryJobs.reduce((acc, job) => {
    const index = stageIndex(job.stage);
    const progress = jobStageProgress(job);
    const weight = jobTotalWeight(job);
    return {
      total: acc.total + (((index * 100) + progress) / PIPELINE_STEPS.length) * weight,
      weight: acc.weight + weight,
    };
  }, { total: 0, weight: 0 });
  const runningStageKeys = [...new Set(runningJobs.map((job) => String(job.stage || "download").toLowerCase()).filter(Boolean))];
  const stageLabel = runningStageKeys.length > 1
    ? "여러 단계"
    : (runningStageKeys.length === 1 ? PIPELINE_STEPS[stageIndex(runningStageKeys[0])]?.[1] || runningStageKeys[0] : "대기중");
  const etaSeconds = totalTiles > processedTiles && speedTilesPerSecond > 0
    ? (totalTiles - processedTiles) / speedTilesPerSecond
    : NaN;
  const isFleet = !normalizeMachineId(machineId);
  const totalMachines = isFleet ? machines.length : (activeMachineIds.length || 1);
  return {
    scope: isFleet ? "fleet" : "machine",
    activeMachines: activeMachineIds.length,
    totalMachines,
    machineLabel: isFleet
      ? `${activeMachineIds.length} / ${totalMachines}대 진행`
      : (activeMachineIds[0] || normalizeMachineId(machineId) || "대기중"),
    stageLabel,
    processedTiles,
    totalTiles,
    speedTilesPerSecond,
    missingTiles,
    failedTiles,
    progressLabel: weightedProgress.weight > 0
      ? `${Math.max(0, Math.min(100, Math.round(weightedProgress.total / weightedProgress.weight)))}%`
      : "0%",
    etaLabel: Number.isFinite(etaSeconds) ? formatDuration(etaSeconds) : "대기중",
  };
}

function fallbackPipelineSteps(events = []) {
  return PIPELINE_STEPS.map(([key, label]) => {
    const status = pipelineStatus(events, key);
    return {
      key,
      label,
      status,
      progress: status === "complete" ? 100 : status === "running" ? 57 : 0,
    };
  });
}

function aggregatePipelineSteps(scopedJobs = [], events = []) {
  const runningJobs = scopedJobs.filter((job) => RUNNING_JOB_STATUSES.has(job.status));
  const sourceJobs = runningJobs.length ? runningJobs : scopedJobs.slice(0, 1);
  if (!sourceJobs.length) return fallbackPipelineSteps(events);

  const totalWeight = sourceJobs.reduce((sum, job) => sum + jobTotalWeight(job), 0) || sourceJobs.length || 1;
  return PIPELINE_STEPS.map(([key, label], index) => {
    const sameStageJobs = sourceJobs.filter((job) => stageIndex(job.stage) === index);
    const completedWeight = sourceJobs.reduce((sum, job) => {
      if (job.status === "completed" || stageIndex(job.stage) > index) return sum + jobTotalWeight(job);
      return sum;
    }, 0);
    const activeProgressWeight = sameStageJobs.reduce((sum, job) => sum + (jobStageProgress(job) * jobTotalWeight(job)), 0);
    const progress = Math.max(0, Math.min(100, Math.round((completedWeight * 100 + activeProgressWeight) / totalWeight)));
    const stageStatuses = new Set(sameStageJobs.map((job) => String(job.status || "").toLowerCase()));
    let status = "pending";
    if (stageStatuses.has("failed")) status = "error";
    else if (stageStatuses.has("stopped")) status = "stopped";
    else if (sameStageJobs.some((job) => RUNNING_JOB_STATUSES.has(job.status))) status = sameStageJobs.some((job) => job.status === "queued") ? "queued" : "running";
    else if (progress >= 100) status = "complete";
    return { key, label, status, progress };
  });
}

function jobEtaLabel(job) {
  const progress = job?.progress || {};
  const etaSeconds = Number(progress.etaSeconds ?? progress.etaSec);
  if (Number.isFinite(etaSeconds) && etaSeconds >= 0) return formatDuration(etaSeconds);
  const done = Number(progress.tilesDone ?? progress.done);
  const total = Number(progress.tilesTotal ?? progress.total);
  const rate = Number(progress.tilesPerSecond ?? progress.tileRate ?? progress.rate);
  if (Number.isFinite(done) && Number.isFinite(total) && total > done && Number.isFinite(rate) && rate > 0) {
    return formatDuration((total - done) / rate);
  }
  if (job?.status === "completed") return "완료";
  if (job?.status === "failed") return "실패";
  if (job?.status === "stopped") return "정지됨";
  return "계산중";
}

function jobStatusLabel(job) {
  const status = String(job?.status || "").toLowerCase();
  if (status === "running" || status === "claimed") return "진행중";
  if (status === "queued") return "대기중";
  if (status === "completed") return "완료";
  if (status === "failed") return "실패";
  if (status === "stopped") return "정지됨";
  return "대기중";
}

function jobStatusTone(job) {
  const status = String(job?.status || "").toLowerCase();
  if (status === "running" || status === "claimed") return "active";
  if (status === "queued") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "stopped") return "disabled";
  return "neutral";
}

function jobStageLabel(job) {
  const stage = String(job?.stage || "").toLowerCase();
  if (!stage) return "대기중";
  return PIPELINE_STEPS[stageIndex(stage)]?.[1] || stage;
}

function buildMachineProcessSummary(jobs = [], machineId) {
  const scopedJobs = scopedJobsForMachine(jobs, machineId).sort(newestFirst);
  const job = scopedJobs.find((item) => RUNNING_JOB_STATUSES.has(item.status)) || scopedJobs[0] || null;
  if (!job) {
    return {
      processLabel: "대기중",
      statusLabel: "작업없음",
      status: "idle",
      tone: "neutral",
      progress: 0,
      progressLabel: "0%",
      etaLabel: "대기중",
    };
  }

  const progress = jobStageProgress(job);
  const status = String(job.status || "").toLowerCase();
  return {
    jobId: job.jobId || job.id || "",
    processLabel: jobStageLabel(job),
    statusLabel: jobStatusLabel(job),
    status,
    tone: jobStatusTone(job),
    progress,
    progressLabel: `${progress}%`,
    etaLabel: status === "queued" ? "대기중" : jobEtaLabel(job),
  };
}

function buildMachineProcesses(machines = [], jobs = []) {
  return machines.reduce((acc, machine) => {
    const machineId = normalizeMachineId(machine.machineId);
    if (machineId) acc[machineId] = buildMachineProcessSummary(jobs, machineId);
    return acc;
  }, {});
}

function buildPipelineFromJobs(jobs = [], events = [], { machineId, machines = [] } = {}) {
  const scopedJobs = jobs
    .filter((job) => jobMachineMatches(job, machineId))
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  const summary = buildPipelineSummary(scopedJobs, { machineId, machines });
  const activeJob = scopedJobs.find((job) => RUNNING_JOB_STATUSES.has(job.status)) || scopedJobs[0] || null;
  if (!activeJob) {
    return {
      steps: aggregatePipelineSteps(scopedJobs, events),
      activeJob: null,
      etaLabel: summary.etaLabel,
      stageLabel: summary.stageLabel,
      progressLabel: summary.progressLabel,
      summary,
      storjShareUrl: "",
      storjRawLinkPrefix: "",
    };
  }

  return {
    steps: aggregatePipelineSteps(scopedJobs, events),
    activeJob,
    etaLabel: normalizeMachineId(machineId) ? jobEtaLabel(activeJob) : summary.etaLabel,
    stageLabel: normalizeMachineId(machineId) ? PIPELINE_STEPS[stageIndex(activeJob.stage)]?.[1] || activeJob.stage || "대기중" : summary.stageLabel,
    progressLabel: normalizeMachineId(machineId) ? summary.progressLabel : summary.progressLabel,
    summary,
    storjShareUrl: activeJob.progress?.storjShareUrl || "",
    storjRawLinkPrefix: activeJob.progress?.storjRawLinkPrefix || "",
  };
}

function rangeTileCount(range = {}) {
  const width = Math.max(0, Number(range.xEnd) - Number(range.xStart) + 1);
  const height = Math.max(0, Number(range.yEnd) - Number(range.yStart) + 1);
  return width * height;
}

function rangeZoomLabel(range = {}) {
  const start = range.zoom ?? range.z ?? range.zoomStart;
  const end = range.zoomEnd ?? start;
  if (start === undefined || start === null || start === "") return "-";
  if (end === undefined || end === null || end === "" || String(end) === String(start)) return String(start);
  return `${start}-${end}`;
}

function buildActiveRanges(configs) {
  return configs
    .filter((config) => config.active || configs.length === 1)
    .flatMap((config) => (config.config?.ranges || []).slice(0, 3).map((range, index) => ({
      name: config.name || `range-${index + 1}`,
      z: rangeZoomLabel(range),
      tiles: rangeTileCount(range),
      progress: 0,
      throughput: 0,
      status: config.active ? "queued" : "available",
    })))
    .slice(0, 5);
}

function healthBucket(machine) {
  if (machine.status === "offline") return "offline";
  if (machine.status === "error" || machine.status === "conflict" || diskPeak(machine) >= 90) return "critical";
  if (machine.status === "busy" || diskPeak(machine) >= 75) return "warning";
  return "healthy";
}

export function buildOverviewModel({
  machines = [],
  configs = [],
  events = [],
  jobs = [],
  secretPool = [],
  settings = {},
  machineId,
} = {}) {
  const online = machines.filter((machine) => machine.status === "online").length;
  const dashboardEvents = events.filter((event) => !isConsoleOutputEvent(event));
  const failedTiles = failedTileCount(jobs, machineId);
  const failedMachines = failedTileMachines(jobs, machineId);
  const activeJobs = activeJobCount(jobs, machineId)
    || dashboardEvents.filter((event) => /\.started$/.test(event.type || "")).length;
  const queuedJobs = queuedJobCount(jobs, machineId);
  const throughput = averageDownloadThroughput(jobs, machineId);
  const diskPressure = Math.max(0, ...machines.map(diskPeak));
  const mapbox = secretCounts(secretPool, "mapbox_token");
  const proxies = secretCounts(secretPool, "proxy_txt");
  const mapboxThreshold = thresholdValue(settings, "mapboxTokensPerServer", 2) * machines.length;
  const proxyThreshold = thresholdValue(settings, "proxiesPerServer", 50) * machines.length;
  const resourceAlerts = [
    {
      type: "mapbox_token",
      label: "Mapbox API Key 목록",
      available: mapbox.available,
      threshold: mapboxThreshold,
      status: machines.length && mapbox.available <= mapboxThreshold ? "low" : "ok",
    },
    {
      type: "proxy_txt",
      label: "Proxy 목록",
      available: proxies.available,
      threshold: proxyThreshold,
      status: machines.length && proxies.available <= proxyThreshold ? "low" : "ok",
    },
  ].filter((alert) => alert.status === "low");
  const health = machines.reduce((acc, machine) => {
    acc[healthBucket(machine)] += 1;
    return acc;
  }, { healthy: 0, warning: 0, critical: 0, offline: 0 });

  const pipelineModel = buildPipelineFromJobs(jobs, dashboardEvents, { machineId, machines });

  return {
    kpis: {
      serversOnline: { label: "련결된 봉사기", value: `${online} / ${machines.length}`, detail: machines.length ? `${Math.round((online / machines.length) * 100)}% 련결됨` : "agent 대기중" },
      activeJobs: { label: "활성화된 작업공정", value: activeJobs, detail: `${queuedJobs}개 대기` },
      throughput: {
        label: "타일 처리속도",
        value: `${Math.round(throughput.total || 0)} 타일/초`,
        detail: throughput.count ? `내리적재중인 봉사기 ${throughput.count}대 합계` : "내리적재중인 봉사기 없음",
      },
      storagePressure: { label: "저장공간 여부", value: `${diskPressure}%`, detail: diskPressure >= 85 ? "높음" : diskPressure >= 70 ? "상승" : "정상" },
      failedJobs: { label: "실패한 타일수", value: failedTiles, detail: failedTiles ? "주의 필요" : "정상" },
      resourceAlerts: { label: "API Key 및 Proxy상태", value: resourceAlerts.length, detail: resourceAlerts.length ? "주의 필요" : "정상" },
    },
    pipeline: pipelineModel.steps,
    pipelineEta: pipelineModel.etaLabel,
    pipelineStage: pipelineModel.stageLabel,
    pipelineProgress: pipelineModel.progressLabel,
    pipelineSummary: pipelineModel.summary,
    machineProcesses: buildMachineProcesses(machines, jobs),
    storjShareUrl: pipelineModel.storjShareUrl,
    storjRawLinkPrefix: pipelineModel.storjRawLinkPrefix,
    activeJob: pipelineModel.activeJob,
    failedTileMachines: failedMachines,
    diskPressure,
    health,
    resourceAlerts,
    activeRanges: buildActiveRanges(configs),
    recentEvents: [...dashboardEvents].slice(-7).reverse(),
  };
}
