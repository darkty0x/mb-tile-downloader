export const DASHBOARD_MANAGED_RUN_ENV = "DASHBOARD_MANAGED_RUN";

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function hasDashboardRuntimeConfig(env = process.env) {
  return Boolean(env.DASHBOARD_URL && env.AGENT_TOKEN && env.MACHINE_ID);
}

export function isDashboardManagedRun(env = process.env) {
  return enabled(env[DASHBOARD_MANAGED_RUN_ENV]);
}

export function assertDashboardManagedRun({
  env = process.env,
  scriptName = "this script",
  argv = process.argv.slice(2),
  allowCommands = [],
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) return;
  if (allowCommands.includes(argv[0])) return;
  if (!hasDashboardRuntimeConfig(env)) return;
  if (isDashboardManagedRun(env)) return;
  if (enabled(env.TILE_DOWNLOADER_ALLOW_UNMANAGED_DASHBOARD_RUN)) return;
  throw new Error(
    `${scriptName} is dashboard-configured but was started outside the managed runner. ` +
      "Use npm scripts or scripts/dashboard-run.js so config, env, Mapbox tokens, and proxies come from the dashboard."
  );
}
