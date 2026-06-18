export const DEFAULT_DASHBOARD_SETTINGS = Object.freeze({
  alertThresholds: Object.freeze({
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50,
  }),
  sync: Object.freeze({
    dashboardPollMs: 5000,
  }),
  workflow: Object.freeze({
    autoStartNextRange: true,
    requirePreflightBeforeStart: false,
    stopTimeoutMs: 30000,
  }),
  notifications: Object.freeze({
    telegramEnabled: false,
    webConsoleEnabled: true,
    dedupeWindowMs: 60000,
    minSeverity: "error",
  }),
  retry: Object.freeze({
    commandRetryLimit: 3,
    reportBackoffMs: 5000,
  }),
  rootEnvTemplate: Object.freeze({
    envText: "",
    sourceMachineId: "",
    updatedAt: "",
  }),
});

function normalizeNonNegativeInteger(value, name, fallback) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return candidate;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("boolean setting must be true or false");
}

function normalizeSeverity(value, fallback) {
  const candidate = value === undefined || value === null || value === "" ? fallback : String(value).trim().toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(candidate)) {
    throw new Error("settings.notifications.minSeverity must be one of debug, info, warn, error");
  }
  return candidate;
}

export function normalizeDashboardSettings(input = {}, existing = DEFAULT_DASHBOARD_SETTINGS) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const current = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing
    : DEFAULT_DASHBOARD_SETTINGS;
  const alertThresholds = source.alertThresholds && typeof source.alertThresholds === "object" && !Array.isArray(source.alertThresholds)
    ? source.alertThresholds
    : {};
  const currentThresholds = current.alertThresholds || DEFAULT_DASHBOARD_SETTINGS.alertThresholds;
  const sync = source.sync && typeof source.sync === "object" && !Array.isArray(source.sync)
    ? source.sync
    : {};
  const currentSync = current.sync || DEFAULT_DASHBOARD_SETTINGS.sync;
  const workflow = source.workflow && typeof source.workflow === "object" && !Array.isArray(source.workflow)
    ? source.workflow
    : {};
  const currentWorkflow = current.workflow || DEFAULT_DASHBOARD_SETTINGS.workflow;
  const notifications = source.notifications && typeof source.notifications === "object" && !Array.isArray(source.notifications)
    ? source.notifications
    : {};
  const currentNotifications = current.notifications || DEFAULT_DASHBOARD_SETTINGS.notifications;
  const retry = source.retry && typeof source.retry === "object" && !Array.isArray(source.retry)
    ? source.retry
    : {};
  const currentRetry = current.retry || DEFAULT_DASHBOARD_SETTINGS.retry;
  const rootEnvTemplate = source.rootEnvTemplate && typeof source.rootEnvTemplate === "object" && !Array.isArray(source.rootEnvTemplate)
    ? source.rootEnvTemplate
    : {};
  const currentRootEnvTemplate = current.rootEnvTemplate || DEFAULT_DASHBOARD_SETTINGS.rootEnvTemplate;

  return {
    alertThresholds: {
      mapboxTokensPerServer: normalizeNonNegativeInteger(
        alertThresholds.mapboxTokensPerServer,
        "settings.alertThresholds.mapboxTokensPerServer",
        currentThresholds.mapboxTokensPerServer
      ),
      proxiesPerServer: normalizeNonNegativeInteger(
        alertThresholds.proxiesPerServer,
        "settings.alertThresholds.proxiesPerServer",
        currentThresholds.proxiesPerServer
      ),
    },
    sync: {
      dashboardPollMs: normalizeNonNegativeInteger(
        sync.dashboardPollMs,
        "settings.sync.dashboardPollMs",
        currentSync.dashboardPollMs
      ),
    },
    workflow: {
      autoStartNextRange: normalizeBoolean(
        workflow.autoStartNextRange,
        currentWorkflow.autoStartNextRange
      ),
      requirePreflightBeforeStart: normalizeBoolean(
        workflow.requirePreflightBeforeStart,
        currentWorkflow.requirePreflightBeforeStart
      ),
      stopTimeoutMs: normalizeNonNegativeInteger(
        workflow.stopTimeoutMs,
        "settings.workflow.stopTimeoutMs",
        currentWorkflow.stopTimeoutMs
      ),
    },
    notifications: {
      telegramEnabled: normalizeBoolean(
        notifications.telegramEnabled,
        currentNotifications.telegramEnabled
      ),
      webConsoleEnabled: normalizeBoolean(
        notifications.webConsoleEnabled,
        currentNotifications.webConsoleEnabled
      ),
      dedupeWindowMs: normalizeNonNegativeInteger(
        notifications.dedupeWindowMs,
        "settings.notifications.dedupeWindowMs",
        currentNotifications.dedupeWindowMs
      ),
      minSeverity: normalizeSeverity(
        notifications.minSeverity,
        currentNotifications.minSeverity
      ),
    },
    retry: {
      commandRetryLimit: normalizeNonNegativeInteger(
        retry.commandRetryLimit,
        "settings.retry.commandRetryLimit",
        currentRetry.commandRetryLimit
      ),
      reportBackoffMs: normalizeNonNegativeInteger(
        retry.reportBackoffMs,
        "settings.retry.reportBackoffMs",
        currentRetry.reportBackoffMs
      ),
    },
    rootEnvTemplate: {
      envText: rootEnvTemplate.envText === undefined || rootEnvTemplate.envText === null
        ? String(currentRootEnvTemplate.envText || "")
        : String(rootEnvTemplate.envText),
      sourceMachineId: rootEnvTemplate.sourceMachineId === undefined || rootEnvTemplate.sourceMachineId === null
        ? String(currentRootEnvTemplate.sourceMachineId || "")
        : String(rootEnvTemplate.sourceMachineId),
      updatedAt: rootEnvTemplate.updatedAt === undefined || rootEnvTemplate.updatedAt === null
        ? String(currentRootEnvTemplate.updatedAt || "")
        : String(rootEnvTemplate.updatedAt),
    },
  };
}
