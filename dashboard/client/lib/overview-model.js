const PIPELINE_STEPS = [
  ["download", "내리적재"],
  ["validate", "검증"],
  ["zip", "압축"],
  ["upload", "올리적재"],
];
const SERVER_CREDENTIAL_SECRET_TYPES = new Set(["server_rdp_credential"]);
const RUNNING_JOB_STATUSES = new Set(["running", "queued", "claimed"]);
const ACTIVE_PROCESS_STATUSES = new Set(["running", "claimed"]);
const STALE_PROGRESS_MS = 5 * 60 * 1000;
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

function diskPressureForFleet(machines = []) {
  let totalBytes = 0;
  let usedBytes = 0;
  for (const machine of machines) {
    for (const disk of machine?.disk || []) {
      const total = Number(disk.totalBytes) || 0;
      if (total <= 0) continue;
      const explicitUsed = Number(disk.usedBytes);
      const used = Number.isFinite(explicitUsed) && explicitUsed >= 0
        ? explicitUsed
        : Math.max(0, total - (Number(disk.freeBytes) || 0));
      totalBytes += total;
      usedBytes += Math.min(total, used);
    }
  }
  if (totalBytes > 0) return Math.round((usedBytes / totalBytes) * 100);
  return Math.max(0, ...machines.map(diskPeak));
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

function machineIsOnline(machine = {}) {
  return String(machine.status || "").toLowerCase() === "online";
}

function liveMachineIds(machines = []) {
  return new Set(machines.filter(machineIsOnline).map((machine) => normalizeMachineId(machine.machineId)).filter(Boolean));
}

function newestJob(jobA, jobB) {
  return newestFirst(jobA, jobB) <= 0 ? jobA : jobB;
}

function jobId(value) {
  return String(value?.jobId || value?.id || "").trim();
}

function jobStatus(job) {
  return String(job?.status || "").toLowerCase();
}

function jobsById(jobs = []) {
  return new Map(jobs.map((job) => [jobId(job), job]).filter(([id]) => id));
}

function currentMachineJobs(jobs = [], { machineId, machines = [], statuses = RUNNING_JOB_STATUSES } = {}) {
  if (!machines.length) return null;

  const byId = jobsById(jobs);
  const scopedMachineId = normalizeMachineId(machineId);
  if (scopedMachineId) {
    const machine = machines.find((item) => normalizeMachineId(item.machineId) === scopedMachineId);
    if (machine && machineIsOnline(machine)) {
      return scopedJobsForMachine(jobs, scopedMachineId)
        .filter((job) => statuses.has(jobStatus(job)))
        .sort(newestFirst);
    }
    return null;
  }

  const currentJobs = [];

  for (const machine of machines) {
    const liveMachineId = normalizeMachineId(machine.machineId);
    if (!liveMachineId || !machineIsOnline(machine)) continue;
    if (scopedMachineId && liveMachineId !== scopedMachineId) continue;

    const currentJobId = String(machine.currentJobId || "").trim();
    if (!currentJobId) continue;

    const job = byId.get(currentJobId);
    if (!job) continue;

    const jobMachineId = normalizeMachineId(job.machineId);
    if (jobMachineId && jobMachineId !== liveMachineId) continue;
    if (!statuses.has(jobStatus(job))) continue;

    currentJobs.push(job);
  }

  return currentJobs.sort(newestFirst);
}

function latestLiveJobsByMachine(jobs = [], { machineId, machines = [], statuses = RUNNING_JOB_STATUSES } = {}) {
  const currentJobs = currentMachineJobs(jobs, { machineId, machines, statuses });
  if (currentJobs) return currentJobs;

  const liveIds = liveMachineIds(machines);
  const hasMachineSnapshot = machines.length > 0;
  const scopedMachineId = normalizeMachineId(machineId);
  const latest = new Map();

  for (const job of scopedJobsForMachine(jobs, machineId)) {
    const status = jobStatus(job);
    if (!statuses.has(status)) continue;

    const jobMachineId = normalizeMachineId(job.machineId) || scopedMachineId;
    if (!jobMachineId) continue;
    if (hasMachineSnapshot && !liveIds.has(jobMachineId)) continue;

    const existing = latest.get(jobMachineId);
    latest.set(jobMachineId, existing ? newestJob(job, existing) : job);
  }

  return [...latest.values()].sort(newestFirst);
}

function activeJobCount(jobs = [], machineId, machines = []) {
  return latestLiveJobsByMachine(jobs, { machineId, machines, statuses: ACTIVE_PROCESS_STATUSES }).length;
}

function queuedJobCount(jobs = [], machineId, machines = []) {
  return latestLiveJobsByMachine(jobs, { machineId, machines, statuses: new Set(["queued"]) }).length;
}

function averageDownloadThroughput(jobs = [], machineId, machines = []) {
  const downloadingJobs = latestLiveJobsByMachine(jobs, { machineId, machines, statuses: ACTIVE_PROCESS_STATUSES })
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

function jobUpdatedTime(job = {}) {
  const value = Date.parse(job.updatedAt || "");
  return Number.isFinite(value) ? value : null;
}

function jobProgressIsStale(job, machine, nowMs, staleMs = STALE_PROGRESS_MS) {
  if (!job || !machine || !machineIsOnline(machine)) return false;
  const status = jobStatus(job);
  if (status !== "running" && status !== "claimed") return false;
  const updatedAt = jobUpdatedTime(job);
  if (updatedAt === null || !Number.isFinite(nowMs)) return false;
  return nowMs - updatedAt >= staleMs;
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
  const completed = events.some((event) => event.type === `pipeline.${step}.completed` || event.type === `range.${step}.completed`);
  if (completed) return "complete";
  const running = events.some((event) => event.type === `pipeline.${step}.started` || event.type === `range.${step}.started`);
  if (running) return "running";
  const failed = events.some((event) => event.type === `pipeline.${step}.failed` || event.type === `range.${step}.failed` || event.type === "range.failed");
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

function jobPipelineProgress(job) {
  const index = stageIndex(String(job?.stage || "").toLowerCase());
  return Math.max(0, Math.min(100, ((index * 100) + jobStageProgress(job)) / PIPELINE_STEPS.length));
}

export function jobPipelineStepNumber(job) {
  const stage = String(job?.stage || "").toLowerCase();
  return stage ? stageIndex(stage) + 1 : null;
}

export function jobStageProgressPercent(job) {
  return jobStageProgress(job);
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
  const isFleet = !normalizeMachineId(machineId);
  const runningJobs = latestLiveJobsByMachine(scopedJobs, { machineId, machines, statuses: RUNNING_JOB_STATUSES });
  const summaryJobs = runningJobs.length ? runningJobs : (isFleet ? [] : scopedJobs.slice(0, 1));
  const activeMachineIds = [...new Set(summaryJobs.map((job) => normalizeMachineId(job.machineId)).filter(Boolean))];
  const activeProcesses = summaryJobs.filter((job) => RUNNING_JOB_STATUSES.has(jobStatus(job))).length;
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
  const stageSourceJobs = runningJobs.length ? runningJobs : (isFleet ? [] : summaryJobs);
  const runningStageKeys = [...new Set(stageSourceJobs.map((job) => String(job.stage || "download").toLowerCase()).filter(Boolean))];
  const stageLabel = runningStageKeys.length > 1
    ? "여러 단계"
    : (runningStageKeys.length === 1 ? PIPELINE_STEPS[stageIndex(runningStageKeys[0])]?.[1] || runningStageKeys[0] : "대기중");
  const etaSeconds = totalTiles > processedTiles && speedTilesPerSecond > 0
    ? (totalTiles - processedTiles) / speedTilesPerSecond
    : NaN;
  const totalMachines = isFleet ? machines.length : (activeMachineIds.length || 1);
  return {
    scope: isFleet ? "fleet" : "machine",
    activeMachines: activeMachineIds.length,
    activeProcesses,
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

function aggregatePipelineSteps(scopedJobs = [], events = [], { allowStaleFallback = true } = {}) {
  const runningJobs = scopedJobs.filter((job) => RUNNING_JOB_STATUSES.has(jobStatus(job)));
  const sourceJobs = runningJobs.length ? runningJobs : (allowStaleFallback ? scopedJobs.slice(0, 1) : []);
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

function jobEtaLabel(job, { stale = false } = {}) {
  if (stale) return "진행 멈춤";
  const status = String(job?.status || "").toLowerCase();
  if (status === "queued" || status === "stopped") return "대기중";
  if (status === "completed") return "완료";
  if (status === "failed") return "실패";

  const progress = job?.progress || {};
  const etaSeconds = Number(progress.etaSeconds ?? progress.etaSec);
  if (Number.isFinite(etaSeconds) && etaSeconds >= 0) return formatDuration(etaSeconds);
  const done = Number(progress.tilesDone ?? progress.done);
  const total = Number(progress.tilesTotal ?? progress.total);
  const rate = Number(progress.tilesPerSecond ?? progress.tileRate ?? progress.rate);
  if (Number.isFinite(done) && Number.isFinite(total) && total > done && Number.isFinite(rate) && rate > 0) {
    return formatDuration((total - done) / rate);
  }
  return "계산중";
}

function jobStatusLabel(job, { stale = false } = {}) {
  if (stale) return "멈춤";
  const status = String(job?.status || "").toLowerCase();
  if (status === "running" || status === "claimed") return "진행중";
  if (status === "queued") return "대기중";
  if (status === "completed") return "완료";
  if (status === "failed") return "실패";
  if (status === "stopped") return "정지됨";
  return "대기중";
}

function jobStatusTone(job, { stale = false } = {}) {
  if (stale) return "error";
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

function buildMachineProcessSummary(jobs = [], machineId, { machine = null, nowMs = Date.now() } = {}) {
  const scopedJobs = scopedJobsForMachine(jobs, machineId).sort(newestFirst);
  const liveJobs = scopedJobs.filter((item) => RUNNING_JOB_STATUSES.has(jobStatus(item)));
  const job = liveJobs[0] || scopedJobs[0] || null;
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
  const stale = jobProgressIsStale(job, machine, nowMs);
  if (liveJobs.length > 1) {
    const summary = buildPipelineSummary(liveJobs, { machineId, machines: machine ? [machine] : [] });
    return {
      jobId: job.jobId || job.id || "",
      processLabel: `${liveJobs.length}개 공정`,
      statusLabel: "진행중",
      status,
      tone: "active",
      stale: liveJobs.every((item) => jobProgressIsStale(item, machine, nowMs)),
      progress: Number.parseInt(summary.progressLabel, 10) || 0,
      progressLabel: summary.progressLabel,
      etaLabel: summary.etaLabel,
    };
  }
  return {
    jobId: job.jobId || job.id || "",
    processLabel: jobStageLabel(job),
    statusLabel: jobStatusLabel(job, { stale }),
    status,
    tone: jobStatusTone(job, { stale }),
    stale,
    progress,
    progressLabel: `${progress}%`,
    etaLabel: jobEtaLabel(job, { stale }),
  };
}

function buildMachineProcesses(machines = [], jobs = [], { nowMs = Date.now() } = {}) {
  const byId = jobsById(jobs);
  return machines.reduce((acc, machine) => {
    const machineId = normalizeMachineId(machine.machineId);
    if (!machineId) return acc;

    const currentJobId = String(machine.currentJobId || "").trim();
    const currentJob = currentJobId ? byId.get(currentJobId) : null;
    const liveJobs = scopedJobsForMachine(jobs, machineId).filter((job) => RUNNING_JOB_STATUSES.has(jobStatus(job)));
    const sourceJobs = liveJobs.length ? liveJobs : (currentJob ? [currentJob] : []);
    acc[machineId] = buildMachineProcessSummary(sourceJobs, machineId, { machine, nowMs });
    return acc;
  }, {});
}

function pipelineProcessFromJob(job, { configs = [], machine = null, nowMs = Date.now() } = {}) {
  const config = configs.find((item) => item.configId === job.configId);
  const progress = jobStageProgress(job);
  const stale = jobProgressIsStale(job, machine, nowMs);
  return {
    jobId: job.jobId || job.id || "",
    machineId: job.machineId || "",
    configId: job.configId || "",
    configName: config?.name || job.configName || job.configId || "Config 화일",
    rangeId: job.rangeId || "",
    stage: job.stage || "",
    stageLabel: jobStageLabel(job),
    status: jobStatus(job),
    statusLabel: jobStatusLabel(job, { stale }),
    tone: jobStatusTone(job, { stale }),
    stale,
    progress,
    progressLabel: `${progress}%`,
    etaLabel: jobEtaLabel(job, { stale }),
    storjShareUrl: job.progress?.storjShareUrl || "",
    storjRawLinkPrefix: job.progress?.storjRawLinkPrefix || "",
    processedTiles: Math.max(0, jobProgressNumber(job, "tilesDone", "done", "processedTiles")),
    totalTiles: Math.max(0, jobProgressNumber(job, "tilesTotal", "total", "totalTiles")),
    speedTilesPerSecond: Math.max(0, jobProgressNumber(job, "tilesPerSecond", "tileRate", "rate", "speedTilesPerSecond")),
    missingTiles: Math.max(0, jobProgressNumber(job, "tilesMissing", "missing", "missingTiles")),
    failedTiles: Math.max(0, jobProgressNumber(job, "tilesFailed", "failedTiles", "failures", "failed")),
  };
}

function configIdValue(value) {
  return String(value || "").trim();
}

function latestJobsByConfig(jobs = []) {
  const latest = new Map();
  for (const job of jobs) {
    const configId = configIdValue(job.configId);
    if (!configId) continue;
    const existing = latest.get(configId);
    latest.set(configId, existing ? newestJob(job, existing) : job);
  }
  return latest;
}

function pipelineProcessFromConfig(config = {}, { link = null } = {}) {
  const configId = configIdValue(config.configId) || configIdValue(link?.configId);
  const configName = config.name || link?.configName || configId || "Config 화일";
  if (link) {
    return {
      jobId: link.jobId || "",
      machineId: link.machineId || config.machineId || "",
      configId,
      configName,
      rangeId: "",
      stage: "upload",
      stageLabel: "올리적재",
      status: "completed",
      statusLabel: "완료",
      tone: "success",
      stale: false,
      progress: 100,
      progressLabel: "100%",
      etaLabel: "완료",
      storjShareUrl: link.shareUrl || "",
      storjRawLinkPrefix: link.rawLinkPrefix || "",
      processedTiles: 0,
      totalTiles: 0,
      speedTilesPerSecond: 0,
      missingTiles: 0,
      failedTiles: 0,
    };
  }
  return {
    jobId: "",
    machineId: config.machineId || "",
    configId,
    configName,
    rangeId: "",
    stage: "",
    stageLabel: "대기중",
    status: "pending",
    statusLabel: "대기중",
    tone: "neutral",
    stale: false,
    progress: 0,
    progressLabel: "0%",
    etaLabel: "대기중",
    storjShareUrl: "",
    storjRawLinkPrefix: "",
    processedTiles: 0,
    totalTiles: 0,
    speedTilesPerSecond: 0,
    missingTiles: 0,
    failedTiles: 0,
  };
}

function configNameFromStorjShareUrl(shareUrl = "") {
  try {
    const url = new URL(String(shareUrl || ""));
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    return parts.at(-1) || "";
  } catch {
    const parts = String(shareUrl || "").split("/").filter(Boolean);
    return parts.at(-1) || "";
  }
}

function configDisplayNameFromJob({ job = {}, config = null, shareUrl = "" } = {}) {
  const urlConfigName = configNameFromStorjShareUrl(shareUrl);
  const jobConfigName = String(job.configName || "").trim();
  const configId = String(job.configId || "").trim();
  const opaqueJobName = jobConfigName && (jobConfigName === configId || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(jobConfigName));
  return config?.name || (opaqueJobName ? "" : jobConfigName) || urlConfigName || configId || "Config 화일";
}

function buildStorjLinks(jobs = [], configs = []) {
  const seen = new Set();
  return jobs
    .filter((job) => jobHasCompletedStorjProof(job))
    .sort(newestFirst)
    .map((job) => {
      const shareUrl = String(job.progress?.storjShareUrl || "").trim();
      const configId = String(job.configId || "").trim();
      const urlConfigName = configNameFromStorjShareUrl(shareUrl);
      const seenKey = urlConfigName
        ? `folder:${normalizeMachineId(job.machineId)}:${urlConfigName}`
        : configId ? `config:${normalizeMachineId(job.machineId)}:${configId}` : `url:${shareUrl}`;
      if (!shareUrl || seen.has(seenKey)) return null;
      seen.add(seenKey);
      const config = configs.find((item) => item.configId === job.configId);
      return {
        jobId: job.jobId || job.id || "",
        machineId: job.machineId || "",
        configId,
        configName: configDisplayNameFromJob({ job, config, shareUrl }),
        rangeId: job.rangeId || "",
        shareUrl,
        rawLinkPrefix: job.progress?.storjRawLinkPrefix || "",
      };
    })
    .filter(Boolean);
}

function jobHasCompletedStorjProof(job = {}) {
  const progress = job.progress || {};
  const percent = Number(progress.percent);
  return jobStatus(job) === "completed"
    && String(job.stage || "").toLowerCase() === "upload"
    && String(progress.storjShareUrl || "").trim()
    && (!Number.isFinite(percent) || percent >= 100);
}

function completedConfigSummaryFromLinks(storjLinks = [], configs = []) {
  const total = configs.length;
  if (total <= 1) return null;
  const completed = Math.min(total, storjLinks.length);
  if (completed <= 0) return null;
  return {
    completed,
    total,
    progress: Math.max(0, Math.min(100, Math.round((completed / total) * 100))),
    label: `${completed}/${total} 완료`,
    complete: completed >= total,
  };
}

function completedConfigSteps(summary) {
  const uploadProgress = summary?.progress ?? 0;
  return PIPELINE_STEPS.map(([key, label], index) => {
    if (index < PIPELINE_STEPS.length - 1) return { key, label, status: "complete", progress: 100 };
    return {
      key,
      label,
      status: uploadProgress >= 100 ? "complete" : "running",
      progress: uploadProgress,
    };
  });
}

function aggregateConfigPipelineSteps(configs = [], { liveJobsByConfig = new Map(), completedLinksByConfig = new Map() } = {}) {
  const totalConfigs = Math.max(1, configs.length);
  const completedConfigCount = configs.filter((config) => completedLinksByConfig.has(configIdValue(config.configId))).length;
  if (configs.length > 0 && completedConfigCount >= configs.length) {
    return PIPELINE_STEPS.map(([key, label]) => ({ key, label, status: "complete", progress: 100 }));
  }
  return PIPELINE_STEPS.map(([key, label], index) => {
    let progressTotal = 0;
    const sameStageJobs = [];

    for (const config of configs) {
      const configId = configIdValue(config.configId);
      const job = liveJobsByConfig.get(configId);
      if (!job) continue;

      const currentIndex = stageIndex(String(job.stage || "").toLowerCase());
      if (currentIndex > index) {
        progressTotal += 100;
      } else if (currentIndex === index) {
        progressTotal += jobStageProgress(job);
        sameStageJobs.push(job);
      }
    }

    const progress = Math.max(0, Math.min(100, Math.round(progressTotal / totalConfigs)));
    const stageStatuses = new Set(sameStageJobs.map((job) => jobStatus(job)));
    let status = "pending";
    if (stageStatuses.has("failed")) status = "error";
    else if (stageStatuses.has("stopped")) status = "stopped";
    else if (sameStageJobs.some((job) => RUNNING_JOB_STATUSES.has(jobStatus(job)))) {
      status = sameStageJobs.some((job) => jobStatus(job) === "queued") ? "queued" : "running";
    } else if (progress >= 100) status = "complete";
    else if (progress > 0) status = "running";
    return { key, label, status, progress };
  });
}

function configPipelineSummary({
  configs = [],
  liveJobs = [],
  liveJobsByConfig = new Map(),
  completedLinksByConfig = new Map(),
  baseSummary = {},
} = {}) {
  const total = configs.length;
  const completed = Math.min(total, completedLinksByConfig.size);
  const completedLabel = `${completed}/${total} 완료`;
  const progressTotal = configs.reduce((sum, config) => {
    const configId = configIdValue(config.configId);
    if (completedLinksByConfig.has(configId)) return sum + 100;
    const job = liveJobsByConfig.get(configId);
    return sum + (job ? jobPipelineProgress(job) : 0);
  }, 0);
  const progress = total > 0 ? Math.max(0, Math.min(100, Math.round(progressTotal / total))) : 0;
  const runningStageKeys = [...new Set(liveJobs.map((job) => String(job.stage || "download").toLowerCase()).filter(Boolean))];
  const stageLabel = completed >= total
    ? "올리적재"
    : runningStageKeys.length > 1
      ? "여러 단계"
      : (runningStageKeys.length === 1 ? PIPELINE_STEPS[stageIndex(runningStageKeys[0])]?.[1] || runningStageKeys[0] : "대기중");
  const processedTiles = liveJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesDone", "done", "processedTiles")), 0);
  const totalTiles = liveJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesTotal", "total", "totalTiles")), 0);
  const speedTilesPerSecond = liveJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesPerSecond", "tileRate", "rate", "speedTilesPerSecond")), 0);
  const missingTiles = liveJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesMissing", "missing", "missingTiles")), 0);
  const failedTiles = liveJobs.reduce((sum, job) => sum + Math.max(0, jobProgressNumber(job, "tilesFailed", "failedTiles", "failures", "failed")), 0);
  return {
    ...baseSummary,
    activeProcesses: liveJobs.length,
    completedConfigs: completed,
    totalConfigs: total,
    pendingConfigs: Math.max(0, total - completed - liveJobs.length),
    completedConfigLabel: completedLabel,
    stageLabel,
    processedTiles,
    totalTiles,
    speedTilesPerSecond,
    missingTiles,
    failedTiles,
    progressLabel: `${progress}%`,
    etaLabel: completed >= total ? "완료" : completedLabel,
  };
}

function buildConfigPipelineModel({ configs = [], scopedJobs = [], liveScopedJobs = [], completedStorjLinks = [], machine = null, nowMs = Date.now(), summary = {} } = {}) {
  const activeConfigIds = new Set(liveScopedJobs.map((job) => configIdValue(job.configId)).filter(Boolean));
  const completedLinksByConfig = new Map();
  for (const link of completedStorjLinks) {
    const configId = configIdValue(link.configId);
    if (activeConfigIds.has(configId)) continue;
    if (configId && !completedLinksByConfig.has(configId)) completedLinksByConfig.set(configId, link);
  }

  const liveJobsByConfig = latestJobsByConfig(liveScopedJobs);
  const liveJobs = [...liveJobsByConfig.values()].sort(newestFirst);
  const processes = configs.map((config) => {
    const configId = configIdValue(config.configId);
    const liveJob = liveJobsByConfig.get(configId);
    if (liveJob) return pipelineProcessFromJob(liveJob, { configs, machine, nowMs });
    return pipelineProcessFromConfig(config, { link: completedLinksByConfig.get(configId) || null });
  });
  const configSummary = configPipelineSummary({
    configs,
    liveJobs,
    liveJobsByConfig,
    completedLinksByConfig,
    baseSummary: summary,
  });
  const focusedJob = liveJobs.length === 1 ? liveJobs[0] : null;
  const focusedSteps = focusedJob
    ? aggregatePipelineSteps([focusedJob], [], { allowStaleFallback: false })
    : null;
  const focusedProgress = focusedJob ? Math.round(jobPipelineProgress(focusedJob)) : null;
  const focusedSummary = focusedJob
    ? {
        ...configSummary,
        stageLabel: jobStageLabel(focusedJob),
        progressLabel: `${focusedProgress}%`,
        etaLabel: jobEtaLabel(focusedJob, { stale: jobProgressIsStale(focusedJob, machine, nowMs) }),
      }
    : configSummary;
  return {
    steps: focusedSteps || aggregateConfigPipelineSteps(configs, { liveJobsByConfig, completedLinksByConfig }),
    activeJob: liveJobs[0] || null,
    activeJobs: liveJobs,
    pipelineProcesses: processes,
    etaLabel: focusedSummary.etaLabel,
    stageLabel: focusedSummary.stageLabel,
    progressLabel: focusedSummary.progressLabel,
    summary: focusedSummary,
  };
}

function storjLinksArePublishable({ storjLinks = [], configs = [], scopedJobs = [], liveScopedJobs = [] } = {}) {
  if (!storjLinks.length) return false;
  if (liveScopedJobs.length) return false;

  const latestJob = scopedJobs[0] || null;
  if (latestJob && jobStatus(latestJob) !== "completed") return false;

  if (configs.length > 0) {
    const completedConfigIds = new Set(storjLinks.map((link) => String(link.configId || "").trim()).filter(Boolean));
    return configs.every((config) => completedConfigIds.has(String(config.configId || "").trim()));
  }

  return true;
}

function buildPipelineFromJobs(jobs = [], events = [], { machineId, machines = [], configs = [], nowMs = Date.now() } = {}) {
  const isFleet = !normalizeMachineId(machineId);
  const scopedMachineId = normalizeMachineId(machineId);
  const scopedConfigs = scopedMachineId
    ? configs.filter((config) => !normalizeMachineId(config.machineId) || normalizeMachineId(config.machineId) === scopedMachineId)
    : configs;
  const scopedJobs = jobs
    .filter((job) => jobMachineMatches(job, machineId))
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  const liveScopedJobs = latestLiveJobsByMachine(scopedJobs, { machineId, machines, statuses: RUNNING_JOB_STATUSES });
  const summary = buildPipelineSummary(scopedJobs, { machineId, machines });
  const stepJobs = liveScopedJobs.length ? liveScopedJobs : (isFleet ? [] : scopedJobs);
  const activeJob = liveScopedJobs[0] || (isFleet ? null : scopedJobs[0]) || null;
  const machine = scopedMachineId
    ? machines.find((item) => normalizeMachineId(item.machineId) === scopedMachineId) || null
    : null;
  const pipelineProcesses = stepJobs
    .filter((job) => RUNNING_JOB_STATUSES.has(jobStatus(job)) || (!liveScopedJobs.length && job === activeJob))
    .map((job) => pipelineProcessFromJob(job, { configs: scopedConfigs, machine, nowMs }));
  const completedStorjLinks = buildStorjLinks(scopedJobs, scopedConfigs);
  const storjLinks = storjLinksArePublishable({ storjLinks: completedStorjLinks, configs: scopedConfigs, scopedJobs, liveScopedJobs })
    ? completedStorjLinks
    : [];
  if (!isFleet && scopedConfigs.length > 1) {
    const configPipeline = buildConfigPipelineModel({
      configs: scopedConfigs,
      scopedJobs,
      liveScopedJobs,
      completedStorjLinks,
      machine,
      nowMs,
      summary,
    });
    return {
      ...configPipeline,
      storjLinks,
      storjShareUrl: storjLinks[0]?.shareUrl || "",
      storjRawLinkPrefix: storjLinks[0]?.rawLinkPrefix || "",
    };
  }
  const completedConfigSummary = !isFleet && !liveScopedJobs.length
    ? completedConfigSummaryFromLinks(completedStorjLinks, scopedConfigs)
    : null;
  if (completedConfigSummary && !completedConfigSummary.complete) {
    return {
      steps: completedConfigSteps(completedConfigSummary),
      activeJob: null,
      activeJobs: [],
      pipelineProcesses,
      etaLabel: completedConfigSummary.label,
      stageLabel: "올리적재",
      progressLabel: `${completedConfigSummary.progress}%`,
      summary: {
        ...summary,
        completedConfigs: completedConfigSummary.completed,
        totalConfigs: completedConfigSummary.total,
        completedConfigLabel: completedConfigSummary.label,
        progressLabel: `${completedConfigSummary.progress}%`,
        stageLabel: "올리적재",
        etaLabel: completedConfigSummary.label,
      },
      storjLinks,
      storjShareUrl: storjLinks[0]?.shareUrl || "",
      storjRawLinkPrefix: storjLinks[0]?.rawLinkPrefix || "",
    };
  }
  if (!activeJob) {
    return {
      steps: aggregatePipelineSteps(stepJobs, events, { allowStaleFallback: !isFleet }),
      activeJob: null,
      activeJobs: [],
      pipelineProcesses,
      etaLabel: summary.etaLabel,
      stageLabel: summary.stageLabel,
      progressLabel: summary.progressLabel,
      summary,
      storjLinks,
      storjShareUrl: storjLinks[0]?.shareUrl || "",
      storjRawLinkPrefix: storjLinks[0]?.rawLinkPrefix || "",
    };
  }

  return {
    steps: aggregatePipelineSteps(stepJobs, events, { allowStaleFallback: !isFleet }),
    activeJob,
    activeJobs: liveScopedJobs,
    pipelineProcesses,
    etaLabel: normalizeMachineId(machineId)
      ? (liveScopedJobs.length > 1 ? summary.etaLabel : jobEtaLabel(activeJob))
      : summary.etaLabel,
    stageLabel: normalizeMachineId(machineId) ? summary.stageLabel : summary.stageLabel,
    progressLabel: normalizeMachineId(machineId) ? summary.progressLabel : summary.progressLabel,
    summary,
    storjLinks,
    storjShareUrl: storjLinks[0]?.shareUrl || activeJob.progress?.storjShareUrl || "",
    storjRawLinkPrefix: storjLinks[0]?.rawLinkPrefix || activeJob.progress?.storjRawLinkPrefix || "",
  };
}

function rangeTileCount(range = {}) {
  const width = Math.max(0, Number(range.xEnd) - Number(range.xStart) + 1);
  const height = Math.max(0, Number(range.yEnd) - Number(range.yStart) + 1);
  const start = Number(range.zoom ?? range.z ?? range.zoomStart);
  const end = Number(range.zoom ?? range.z ?? range.zoomEnd ?? start);
  const zooms = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start + 1) : 1;
  return width * height * zooms;
}

function rangeZoomSegments(ranges = []) {
  const segments = ranges
    .map((range) => {
      const start = Number(range.zoom ?? range.z ?? range.zoomStart);
      const end = Number(range.zoom ?? range.z ?? range.zoomEnd ?? start);
      if (!Number.isFinite(start)) return null;
      return { start, end: Number.isFinite(end) ? end : start };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && segment.start <= last.end + 1) {
      last.end = Math.max(last.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged.map((segment) => (
    segment.start === segment.end ? String(segment.start) : `${segment.start}-${segment.end}`
  )).join(", ") || "-";
}

function buildActiveRanges(configs) {
  return configs
    .filter((config) => config.active || configs.length === 1)
    .map((config, index) => {
      const ranges = config.config?.ranges || [];
      return {
        name: config.name || `config-${index + 1}`,
        z: rangeZoomSegments(ranges),
        rangeCount: ranges.length,
        tiles: ranges.reduce((sum, range) => sum + rangeTileCount(range), 0),
        progress: 0,
        throughput: 0,
        status: config.active ? "queued" : "available",
      };
    });
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
  now = new Date(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const online = machines.filter((machine) => machine.status === "online").length;
  const dashboardEvents = events.filter((event) => !isConsoleOutputEvent(event));
  const failedTiles = failedTileCount(jobs, machineId);
  const failedMachines = failedTileMachines(jobs, machineId);
  const activeJobs = activeJobCount(jobs, machineId, machines);
  const queuedJobs = queuedJobCount(jobs, machineId, machines);
  const throughput = averageDownloadThroughput(jobs, machineId, machines);
  const diskPressure = diskPressureForFleet(machines);
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

  const pipelineModel = buildPipelineFromJobs(jobs, dashboardEvents, { machineId, machines, configs, nowMs });

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
    machineProcesses: buildMachineProcesses(machines, jobs, { nowMs }),
    storjShareUrl: pipelineModel.storjShareUrl,
    storjRawLinkPrefix: pipelineModel.storjRawLinkPrefix,
    storjLinks: pipelineModel.storjLinks,
    activeJob: pipelineModel.activeJob,
    activeJobs: pipelineModel.activeJobs,
    pipelineProcesses: pipelineModel.pipelineProcesses,
    failedTileMachines: failedMachines,
    diskPressure,
    health,
    resourceAlerts,
    activeRanges: buildActiveRanges(configs),
    recentEvents: [...dashboardEvents].slice(-7).reverse(),
  };
}
