import { createControlClient } from "./control-client.js";
import { syncManagedState } from "./agent.js";

function envValue(env, name) {
  return String(env?.[name] || "").trim();
}

export function dashboardSyncConfig(env = process.env) {
  const baseUrl = envValue(env, "DASHBOARD_URL");
  const agentToken = envValue(env, "AGENT_TOKEN");
  const machineId = envValue(env, "MACHINE_ID");
  const missingKeys = [
    ["DASHBOARD_URL", baseUrl],
    ["AGENT_TOKEN", agentToken],
    ["MACHINE_ID", machineId],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (!baseUrl || !agentToken || !machineId) {
    return {
      configured: false,
      reason: "dashboard env is incomplete",
      missingKeys,
      baseUrl,
      agentToken,
      machineId,
    };
  }
  return { configured: true, baseUrl, agentToken, machineId };
}

export async function syncDashboardStateIfConfigured({
  env = process.env,
  projectDir = process.cwd(),
  stateDir = ".tile-state",
  createClient = createControlClient,
  log = () => {},
} = {}) {
  const config = dashboardSyncConfig(env);
  if (!config.configured) return { synced: false, reason: config.reason };

  const client = createClient({
    baseUrl: config.baseUrl,
    agentToken: config.agentToken,
  });
  const result = await syncManagedState({
    client,
    machineId: config.machineId,
    stateDir,
    projectDir,
  });

  log(
    "Dashboard state synced: " +
      `machine=${config.machineId} ` +
      `config=${result.configPath ? "active" : "none"} ` +
      `env=${result.envPath ? "active" : "none"} ` +
      `mapbox=${result.secretEnv?.MAPBOX_ACCESS_TOKENS ? result.secretEnv.MAPBOX_ACCESS_TOKENS.split(",").filter(Boolean).length : 0} ` +
      `proxy=${result.proxyPath ? "materialized" : "none"}`
  );
  return { synced: true, machineId: config.machineId, ...result };
}
