const PIPELINE_STEPS = [
  ["download", "내려받기"],
  ["validate", "검증"],
  ["zip", "압축"],
  ["upload", "올리기"],
];
const SERVER_CREDENTIAL_SECRET_TYPES = new Set(["server_rdp_credential"]);

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function buildServerOnboarding({ dashboardUrl = "", machineId = "" } = {}) {
  const normalizedMachineId = String(machineId || "SERVER-01").trim() || "SERVER-01";
  const normalizedDashboardUrl = String(dashboardUrl || "https://your-railway-app.up.railway.app").trim() || "https://your-railway-app.up.railway.app";
  return {
    machineId: normalizedMachineId,
    dashboardUrl: normalizedDashboardUrl,
    command: [
      `MACHINE_ID=${shellQuote(normalizedMachineId)}`,
      `DASHBOARD_URL=${shellQuote(normalizedDashboardUrl)}`,
      "AGENT_TOKEN=your-agent-token",
      "npm run agent",
    ].join(" \\\n"),
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
  return Math.max(0, ...((machine?.disk || []).map((disk) => Number(disk.percentUsed) || 0)));
}

function secretCounts(secrets, secretType) {
  const items = secrets.filter((secret) => secret.secretType === secretType);
  const available = items.filter((secret) => secret.status === "active" && !secret.machineId).length;
  const assigned = items.filter((secret) => secret.status === "active" && secret.machineId).length;
  const disabled = items.length - available - assigned;
  return { total: items.length, available, assigned, disabled };
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

function rangeTileCount(range = {}) {
  const width = Math.max(0, Number(range.xEnd) - Number(range.xStart) + 1);
  const height = Math.max(0, Number(range.yEnd) - Number(range.yStart) + 1);
  return width * height;
}

function buildActiveRanges(configs) {
  return configs
    .filter((config) => config.active || configs.length === 1)
    .flatMap((config) => (config.config?.ranges || []).slice(0, 3).map((range, index) => ({
      name: config.name || `range-${index + 1}`,
      z: range.zoom ?? range.z ?? "-",
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
  secretPool = [],
  settings = {},
} = {}) {
  const online = machines.filter((machine) => machine.status === "online").length;
  const failedJobs = events.filter((event) => event.severity === "error" || event.type === "range.failed").length;
  const activeJobs = events.filter((event) => /\.started$/.test(event.type || "")).length;
  const diskPressure = Math.max(0, ...machines.map(diskPeak));
  const mapbox = secretCounts(secretPool, "mapbox_token");
  const proxies = secretCounts(secretPool, "proxy_txt");
  const mapboxThreshold = thresholdValue(settings, "mapboxTokensPerServer", 2) * machines.length;
  const proxyThreshold = thresholdValue(settings, "proxiesPerServer", 50) * machines.length;
  const resourceAlerts = [
    {
      type: "mapbox_token",
      label: "Mapbox API 키",
      available: mapbox.available,
      threshold: mapboxThreshold,
      status: machines.length && mapbox.available <= mapboxThreshold ? "low" : "ok",
    },
    {
      type: "proxy_txt",
      label: "프록시풀",
      available: proxies.available,
      threshold: proxyThreshold,
      status: machines.length && proxies.available <= proxyThreshold ? "low" : "ok",
    },
  ].filter((alert) => alert.status === "low");
  const health = machines.reduce((acc, machine) => {
    acc[healthBucket(machine)] += 1;
    return acc;
  }, { healthy: 0, warning: 0, critical: 0, offline: 0 });

  return {
    kpis: {
      serversOnline: { label: "련결된 봉사기", value: `${online} / ${machines.length}`, detail: machines.length ? `${Math.round((online / machines.length) * 100)}% 련결됨` : "agent 대기중" },
      activeJobs: { label: "활성 작업", value: activeJobs, detail: `${Math.max(0, configs.length - activeJobs)}개 대기렬` },
      throughput: { label: "타일 처리속도", value: "0 tiles/s", detail: "실시간 agent 지표 대기중" },
      storagePressure: { label: "저장공간 압력", value: `${diskPressure}%`, detail: diskPressure >= 85 ? "높음" : diskPressure >= 70 ? "상승" : "정상" },
      failedJobs: { label: "실패한 타일", value: failedJobs, detail: failedJobs ? "주의 필요" : "정상" },
      resourceAlerts: { label: "자원경보", value: resourceAlerts.length, detail: resourceAlerts.length ? "주의 필요" : "정상" },
    },
    pipeline: PIPELINE_STEPS.map(([key, label]) => ({
      key,
      label,
      status: pipelineStatus(events, key),
      progress: pipelineStatus(events, key) === "complete" ? 100 : pipelineStatus(events, key) === "running" ? 57 : 0,
    })),
    diskPressure,
    health,
    resourceAlerts,
    activeRanges: buildActiveRanges(configs),
    recentEvents: [...events].slice(-7).reverse(),
  };
}
