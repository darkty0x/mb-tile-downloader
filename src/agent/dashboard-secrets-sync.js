import { createControlClient } from "./control-client.js";
import { materializeSecrets } from "./secret-materializer.js";

function envValue(env, name) {
  return String(env?.[name] || "").trim();
}

export async function syncDashboardSecretsIfConfigured({
  env = process.env,
  projectDir = process.cwd(),
  stateDir = ".tile-state",
  createClient = createControlClient,
  log = () => {},
} = {}) {
  const baseUrl = envValue(env, "DASHBOARD_URL");
  const agentToken = envValue(env, "AGENT_TOKEN");
  const machineId = envValue(env, "MACHINE_ID");
  if (!baseUrl || !agentToken || !machineId) {
    return { synced: false, reason: "dashboard env is incomplete" };
  }

  const client = createClient({ baseUrl, agentToken });
  const { secrets = [] } = await client.listSecrets(machineId);
  const result = await materializeSecrets({
    projectDir,
    stateDir,
    secrets,
    preserveLocalProxyWhenUnassigned: true,
  });
  for (const [name, value] of Object.entries(result.env || {})) env[name] = value;

  log(
    `Dashboard secrets synced: mapbox=${result.mapboxTokenCount || 0} ` +
      `proxies=${result.proxyCount || 0} ` +
      `proxy=${result.proxyPath ? "dashboard" : "local-preserved"}`
  );
  return { synced: true, machineId, secrets, ...result };
}
