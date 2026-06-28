export const TABS = [
  ["overview", "첫페지", "overview"],
  ["servers", "봉사기", "servers"],
  ["configs", "Config 화일", "config"],
  ["pipelines", "공정흐름", "pipelines"],
  ["secrets", "API Key 및 Proxy", "secrets"],
  ["credentials", "계정정보", "credentials"],
  ["events", "Event 기록", "console"],
  ["alerts", "경보", "alerts"],
  ["settings", "설정", "settings"],
  ["help", "도움말", "help"],
];

export const PAGE_META = {
  overview: ["첫페지", "전체 공정흐름을 감시 및 관리합니다"],
  servers: ["봉사기", "작업기대 봉사기들을 관리합니다"],
  secrets: ["API Key 및 Proxy", "Mapbox API Key 및 Proxy정보들을 관리합니다"],
  credentials: ["계정정보", "웹싸이트 및 RDP 접속자료와 접근권한을 관리합니다"],
  settings: ["설정", "체계와 환경을 설정합니다"],
  pipelines: ["공정흐름", "활성화된 봉사기들의 작업공정흐름을 관리합니다"],
  configs: ["Config 화일", "내리적재설정을 만들고 배정합니다"],
  events: ["Event 기록", "관리체계 및 Agent Event목록을 실시간으로 봅니다"],
  alerts: ["경보", "용량 및 실패상태를 검토합니다"],
  help: ["도움말", "페지별 사용법과 화면그림을 봅니다"],
};

export const SERVER_TABS = [
  ["control", "공정흐름", "control"],
  ["configs", "Config", "config"],
  ["env", ".Env", "env"],
  ["secrets", "API Key 및 Proxy", "secrets"],
  ["console", "Console", "console"],
];

export const SECRET_LABELS = {
  mapbox_token: "Mapbox API Key",
  proxy_txt: "Proxy",
  storj_access: "Storj Access",
  credential: "계정정보",
};

export const DEFAULT_DASHBOARD_SETTINGS = {
  alertThresholds: {
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50,
  },
  sync: {
    dashboardPollMs: 5000,
  },
  workflow: {
    autoStartNextRange: true,
    requirePreflightBeforeStart: false,
    stopTimeoutMs: 30000,
  },
  notifications: {
    telegramEnabled: false,
    webConsoleEnabled: true,
    dedupeWindowMs: 60000,
    minSeverity: "error",
  },
  retry: {
    commandRetryLimit: 3,
    reportBackoffMs: 5000,
  },
  rootEnvTemplate: {
    envText: "",
    sourceMachineId: "",
    updatedAt: "",
  },
  telegramEnv: {
    botTokenConfigured: false,
    chatId: "",
  },
};

export const SECRET_STATUSES = ["active", "disabled", "inactive", "error", "invalid", "exhausted"];
export const SAMPLE_CONFIG = {
  provider: "esri",
  layer: "esri-satellite",
  ranges: [{ zoom: 14, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
};

export function mergeDashboardSettings(settings = {}) {
  return {
    alertThresholds: {
      ...DEFAULT_DASHBOARD_SETTINGS.alertThresholds,
      ...(settings.alertThresholds || {}),
    },
    sync: {
      ...DEFAULT_DASHBOARD_SETTINGS.sync,
      ...(settings.sync || {}),
    },
    workflow: {
      ...DEFAULT_DASHBOARD_SETTINGS.workflow,
      ...(settings.workflow || {}),
    },
    notifications: {
      ...DEFAULT_DASHBOARD_SETTINGS.notifications,
      ...(settings.notifications || {}),
    },
    retry: {
      ...DEFAULT_DASHBOARD_SETTINGS.retry,
      ...(settings.retry || {}),
    },
    rootEnvTemplate: {
      ...DEFAULT_DASHBOARD_SETTINGS.rootEnvTemplate,
      ...(settings.rootEnvTemplate || {}),
    },
    telegramEnv: {
      ...DEFAULT_DASHBOARD_SETTINGS.telegramEnv,
      ...(settings.telegramEnv || {}),
    },
  };
}

export function envValueFromText(envText, name) {
  const target = String(name || "").trim();
  if (!target) return "";
  for (const line of String(envText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    if (trimmed.slice(0, separator).trim() === target) {
      return trimmed.slice(separator + 1).trim();
    }
  }
  return "";
}

export function thresholdValue(settings, name) {
  const value = Number(settings?.alertThresholds?.[name]);
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_DASHBOARD_SETTINGS.alertThresholds[name];
}

export function defaultConfigSplitAcrossMachines(machineIds = []) {
  return Array.isArray(machineIds) && machineIds.filter(Boolean).length > 1;
}

export function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const KOREAN_DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

export function shortDate(value) {
  if (!value) return "없음";
  const parts = Object.fromEntries(
    KOREAN_DATE_FORMATTER
      .formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}년 ${Number(parts.month)}월 ${Number(parts.day)}일 ${Number(parts.hour)}시 ${parts.minute}분`;
}

export function statusKind(status) {
  if (status === "online") return "online";
  if (status === "error" || status === "conflict") return "error";
  if (status === "busy" || status === "warn") return "warn";
  return "neutral";
}

const STATUS_LABELS = {
  active: "활성",
  available: "리용가능",
  busy: "처리중",
  clear: "정상",
  complete: "완료",
  conflict: "충돌",
  critical: "위험",
  debug: "조사",
  disabled: "비활성",
  error: "오유",
  exhausted: "소진됨",
  healthy: "정상",
  inactive: "비활성",
  info: "정보",
  invalid: "무효",
  low: "낮음",
  neutral: "일반",
  offline: "련결안됨",
  ok: "정상",
  online: "련결됨",
  pending: "대기중",
  queued: "대기",
  running: "실행중",
  stopped: "정지됨",
  success: "성공",
  warn: "경고",
  warning: "경고",
};

export function displayStatus(value, fallback = "없음") {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const normalized = text.toLowerCase();
  if (STATUS_LABELS[normalized]) return STATUS_LABELS[normalized];
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function displayProtocol(value) {
  const text = String(value || "").trim();
  return text ? text.toUpperCase() : "N/A";
}

export function displayMachineId(value) {
  const text = String(value || "").trim();
  return text ? text.toUpperCase() : "Agent ID 없음";
}

export function normalizeMachineId(value) {
  return String(value || "").trim().toLowerCase();
}

export function sameMachineId(a, b) {
  const left = normalizeMachineId(a);
  const right = normalizeMachineId(b);
  return Boolean(left && right && left === right);
}

export function findMachineById(machines = [], machineId) {
  return machines.find((machine) => sameMachineId(machine.machineId, machineId)) || null;
}

export function fleetState(state) {
  return {
    ...state,
    configs: state.globalConfigs?.length ? state.globalConfigs : state.configs,
    events: state.globalEvents?.length ? state.globalEvents : state.events,
    jobs: state.globalJobs?.length ? state.globalJobs : state.jobs,
  };
}

export function diskPeakForMachine(machine) {
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
