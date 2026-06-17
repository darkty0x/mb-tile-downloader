export const COMMANDS = [
  ["run_preflight", "Preflight", "play"],
  ["start_pipeline", "Start", "play"],
  ["pause_after_range", "Pause", "pause"],
  ["stop_pipeline", "Stop", "stop"],
  ["sync_config", "Sync Config", "sync"],
  ["sync_env", "Sync Env", "sync"],
];

export const TABS = [
  ["overview", "Overview", "overview"],
  ["servers", "Servers", "servers"],
  ["configs", "Configs", "config"],
  ["pipelines", "Pipelines", "pipelines"],
  ["secrets", "Secrets", "secrets"],
  ["credentials", "Credentials", "credentials"],
  ["events", "Events", "console"],
  ["alerts", "Alerts", "alerts"],
  ["settings", "Settings", "settings"],
];

export const PAGE_META = {
  overview: ["Overview", "Distributed tile pipeline command center"],
  servers: ["Servers", "Monitor and manage the server fleet"],
  secrets: ["Secrets", "Manage Mapbox and proxy resource pools"],
  credentials: ["Credentials", "Manage protocol credentials and access"],
  settings: ["Settings", "Configure system behavior and preferences"],
  pipelines: ["Pipelines", "Track active range workflow stages"],
  configs: ["Configs", "Create and assign downloader configuration"],
  events: ["Events", "Inspect live dashboard and agent events"],
  alerts: ["Alerts", "Review capacity and failure conditions"],
};

export const SERVER_TABS = [
  ["control", "Control", "control"],
  ["configs", "Config", "config"],
  ["env", "Env", "env"],
  ["secrets", "Secrets", "secrets"],
  ["console", "Console", "console"],
];

export const SECRET_LABELS = {
  mapbox_token: "Mapbox Token",
  proxy_txt: "Proxy",
  storj_access: "Storj Access",
  credential: "Credential",
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
  };
}

export function thresholdValue(settings, name) {
  const value = Number(settings?.alertThresholds?.[name]);
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_DASHBOARD_SETTINGS.alertThresholds[name];
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

export function shortDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function statusKind(status) {
  if (status === "online") return "online";
  if (status === "error" || status === "conflict") return "error";
  if (status === "busy" || status === "warn") return "warn";
  return "neutral";
}

export function displayStatus(value, fallback = "None") {
  const text = String(value || "").trim();
  if (!text) return fallback;
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
  return text ? text.toUpperCase() : "No Agent ID";
}

export function fleetState(state) {
  return {
    ...state,
    configs: state.globalConfigs?.length ? state.globalConfigs : state.configs,
    events: state.globalEvents?.length ? state.globalEvents : state.events,
  };
}

export function diskPeakForMachine(machine) {
  return Math.max(0, ...((machine?.disk || []).map((disk) => Number(disk.percentUsed) || 0)));
}
