import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeProxyText(value) {
  return String(value)
    .split(/[,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

function envLine(name, value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error(`secret env "${name}" contains newline`);
  return `${name}=${text}`;
}

export async function materializeSecrets({
  projectDir = process.cwd(),
  stateDir = ".tile-state",
  secrets = [],
} = {}) {
  const dashboardDir = path.join(stateDir, "dashboard");
  await mkdir(dashboardDir, { recursive: true });

  const mapboxTokens = secrets
    .filter((secret) => secret.secretType === "mapbox_token")
    .map((secret) => secret.value)
    .filter(Boolean);

  const env = {};
  if (mapboxTokens.length > 0) env.MAPBOX_ACCESS_TOKENS = mapboxTokens.join(",");

  const envPath = path.join(dashboardDir, "secrets.env.generated");
  const tmpEnvPath = `${envPath}.tmp`;
  const envLines = Object.entries(env).map(([name, value]) => envLine(name, value));
  await writeFile(tmpEnvPath, `${envLines.join("\n")}${envLines.length ? "\n" : ""}`);
  await rename(tmpEnvPath, envPath);

  const proxySecret = secrets.find((secret) => secret.secretType === "proxy_txt" && secret.value);
  let proxyPath = null;
  if (proxySecret) {
    proxyPath = path.join(projectDir, "proxy.txt");
    const tmpProxyPath = `${proxyPath}.tmp`;
    const normalized = normalizeProxyText(proxySecret.value);
    await writeFile(tmpProxyPath, `${normalized}${normalized ? "\n" : ""}`);
    await rename(tmpProxyPath, proxyPath);
  }

  return { env, envPath, proxyPath };
}
