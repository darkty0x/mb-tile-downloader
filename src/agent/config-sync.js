import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function materializeConfig({ stateDir = ".tile-state", configRecord } = {}) {
  if (!configRecord?.configId) throw new Error("configRecord.configId is required");
  const configDir = path.join(stateDir, "dashboard", "configs");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, `${configRecord.configId}.json`);
  const tmpPath = `${configPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(configRecord.config, null, 2)}\n`);
  await rename(tmpPath, configPath);
  return {
    configId: configRecord.configId,
    version: configRecord.version,
    configPath,
  };
}
