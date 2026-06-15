import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function stringifyEnvValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function envFileLine(name, value) {
  const stringValue = stringifyEnvValue(value);
  if (/[\r\n]/.test(stringValue)) {
    throw new Error(`env "${name}" contains a newline and cannot be materialized`);
  }
  return `${name}=${stringValue}`;
}

export async function materializeEnvProfile({ stateDir = ".tile-state", profile } = {}) {
  if (!profile) throw new Error("env profile is required");
  const dashboardDir = path.join(stateDir, "dashboard");
  await mkdir(dashboardDir, { recursive: true });

  const env = {};
  for (const [name, value] of Object.entries(profile.env || {})) {
    env[name] = stringifyEnvValue(value);
  }

  const lines = Object.keys(env)
    .sort()
    .map((name) => envFileLine(name, env[name]));
  const envPath = path.join(dashboardDir, "env.generated");
  const tmpPath = `${envPath}.tmp`;
  await writeFile(tmpPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
  await rename(tmpPath, envPath);

  return {
    env,
    envPath,
    envProfileId: profile.envProfileId,
    version: profile.version,
  };
}
