export const DEFAULT_DASHBOARD_SETTINGS = Object.freeze({
  alertThresholds: Object.freeze({
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50,
  }),
  sync: Object.freeze({
    dashboardPollMs: 5000,
  }),
});

function normalizeNonNegativeInteger(value, name, fallback) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new Error(`${name} must be a non-negative integer`);
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
  };
}
