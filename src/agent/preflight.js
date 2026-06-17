import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { loadConfig } from "../config/config-loader.js";
import { assertDashboardManagedRun } from "./managed-run-guard.js";

function isCliEntrypoint() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

async function assertWritableDirectory(dir) {
  await mkdir(dir, { recursive: true });
  const probePath = path.join(dir, `.preflight-${process.pid}-${Date.now()}.tmp`);
  await writeFile(probePath, "ok", "utf8");
  await rm(probePath, { force: true });
}

function countList(value) {
  return String(value || "")
    .split(/[,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean).length;
}

export async function runPreflight({ configPath, env = process.env, projectDir = process.cwd() } = {}) {
  if (!configPath) throw new Error("configPath is required");
  const config = await loadConfig(configPath, { env, projectDir });
  const outputDirs = Array.isArray(config.output?.dirs) && config.output.dirs.length
    ? config.output.dirs
    : [config.output?.dir].filter(Boolean);
  for (const dir of outputDirs) await assertWritableDirectory(dir);

  const checks = {
    configPath: path.relative(projectDir, config.configPath) || config.configPath,
    provider: config.provider,
    ranges: config.ranges.length,
    outputDirs: outputDirs.length,
    proxyCount: countList(env.TILE_DOWNLOADER_PROXY_URLS || env.HTTP_PROXY_LIST || env.HTTPS_PROXY_LIST),
    mapboxTokenCount: countList(env.MAPBOX_ACCESS_TOKENS),
    storjConfigured: Boolean(env.STORJ_BUCKET && env.STORJ_ACCESS && env.STORJ_PASSPHRASE),
  };
  if (config.provider === "mapbox" && checks.mapboxTokenCount === 0) {
    throw new Error("MAPBOX_ACCESS_TOKENS is required for Mapbox preflight");
  }
  if (env.STORJ_BUCKET && (!env.STORJ_ACCESS || !env.STORJ_PASSPHRASE)) {
    throw new Error("STORJ_ACCESS and STORJ_PASSPHRASE are required when STORJ_BUCKET is set");
  }
  return checks;
}

if (isCliEntrypoint()) {
  assertDashboardManagedRun({
    scriptName: "src/agent/preflight.js",
    argv: process.argv.slice(2),
  });
  runPreflight({ configPath: process.argv[2] })
    .then((result) => {
      console.log(`[preflight] ${JSON.stringify({ ok: true, ...result })}`);
    })
    .catch((err) => {
      console.error(`[preflight] ${JSON.stringify({ ok: false, error: err.message })}`);
      process.exit(1);
    });
}
