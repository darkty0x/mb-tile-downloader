#!/usr/bin/env node
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./src/config/config-loader.js";
import { splitConfigByRows } from "./src/config/config-splitter.js";
import { runDownloadJob } from "./src/engine/downloader-engine.js";
import { configureNetworking } from "./src/runtime/platform-profile.js";
import { TileStateDb } from "./src/state/state-db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MAX_OLD_SPACE_MB = 8192;
const PROXY_RUNTIME_PROXY_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
]);

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (label) throw new Error(`${label} must be a positive integer`);
    return null;
  }
  return parsed;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    if (label) throw new Error(`${label} must be a non-negative integer`);
    return null;
  }
  return parsed;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function ensureDownloaderHeapLimit() {
  if (process.env.TILE_DOWNLOADER_HEAP_REEXEC === "1") return;
  if (process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))) return;
  const requested = Number(process.env.TILE_DOWNLOADER_MAX_OLD_SPACE_MB);
  const heapMb = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_OLD_SPACE_MB;
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMb}`, ...process.execArgv, __filename, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, TILE_DOWNLOADER_HEAP_REEXEC: "1" },
    }
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

ensureDownloaderHeapLimit();

function loadDotEnvIfPresent(envPath = path.join(__dirname, ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function stripProcessProxyEnv(env = process.env) {
  const sanitized = { ...env };
  for (const key of PROXY_RUNTIME_PROXY_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

function renderUrlTemplate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) {
      throw new Error(`Missing URL template value: ${key}`);
    }
    return encodeURIComponent(String(values[key]));
  });
}

function esriRequestY(z, y, yScheme) {
  if (String(yScheme || "xyz").toLowerCase() !== "tms") return y;
  return 2 ** z - 1 - y;
}

function proxyHealthcheckUrlForConfig(config) {
  if (config.provider !== "esri") return "";
  const range = Array.isArray(config.ranges) ? config.ranges[0] : null;
  if (!range) return "";
  const z = range.zoomStart;
  const x = range.xStart;
  const y = esriRequestY(z, range.yStart, config.tile?.yScheme || config.requestYScheme || "xyz");
  const template =
    config.url?.template ||
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  return renderUrlTemplate(template, { z, x, y });
}

function printUsage(exitCode = 0) {
  console.log(`
Production tile downloader

Usage:
  node downloader.js <configPath...> [--validate] [--force-verify] [--dry-run] [--skip-verify]
  [--row-recovery-passes N] [--recovery-backoff-ms N] [--max-rows-in-flight N] [--max-concurrent-requests N] [--esri-fast]
  [--state-db path-or-dir]
  node downloader.js split <configPath> --parts N [--out dir] [--names cig,cmi,kuh]
  node downloader.js clear-token-state [--state-db path-or-dir]

Examples:
  node downloader.js configs/mapbox-pbf.config.json
  node downloader.js configs/cig.config.json configs/cmi.config.json --dry-run
  node downloader.js configs/mapbox-pbf.config.json --validate --force-verify
  node downloader.js split configs/mapbox-pbf.config.json --parts 6 --out configs/mapbox-pbf-machines
  node downloader.js split configs/esri-satellite.config.json --names cig,cmi,kuh --out configs/esri-machines
`);
  process.exit(exitCode);
}

function parseSplitArgs(args) {
  const opts = {
    command: "split",
    configPath: null,
    outDir: null,
    parts: null,
    names: null,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--parts") {
      opts.parts = Number(args[++i]);
      if (!Number.isInteger(opts.parts) || opts.parts < 1) {
        throw new Error("--parts must be a positive integer");
      }
    } else if (arg === "--out") {
      opts.outDir = args[++i];
      if (!opts.outDir) throw new Error("--out requires a directory");
    } else if (arg === "--names") {
      opts.names = String(args[++i] || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (opts.names.length === 0) throw new Error("--names requires at least one name");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown split option: ${arg}`);
    } else if (!opts.configPath) {
      opts.configPath = arg;
    } else {
      throw new Error(`Unexpected split argument: ${arg}`);
    }
  }

  if (!opts.configPath) throw new Error("split requires a config path");
  if (!opts.parts && !opts.names?.length) throw new Error("split requires --parts or --names");
  return opts;
}

function parseClearTokenStateArgs(args) {
  const opts = {
    command: "clear-token-state",
    stateDbPath: ".tile-state",
  };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--state-db") {
      opts.stateDbPath = args[++i];
      if (!opts.stateDbPath) throw new Error("--state-db requires a path");
    } else {
      throw new Error(`Unknown clear-token-state option: ${arg}`);
    }
  }
  return opts;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) printUsage(0);
  if (args[0] === "split") return parseSplitArgs(args);
  if (args[0] === "clear-token-state") return parseClearTokenStateArgs(args);

  const opts = {
    command: "run",
    validate: false,
    forceVerify: false,
    dryRun: false,
    skipVerifyAfterDownload: false,
    esriFastMode: false,
    maxConcurrentRequests: null,
    rowRecoveryPasses: null,
    recoveryBackoffMs: null,
    maxRowsInFlight: null,
    stateDbPath: null,
    configPaths: [],
    usedDefaultConfig: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--validate" || arg === "-v") opts.validate = true;
    else if (arg === "--force-verify") opts.forceVerify = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-verify") opts.skipVerifyAfterDownload = true;
    else if (arg === "--esri-fast") opts.esriFastMode = true;
    else if (arg === "--proxy-trace") {
      // Deprecated compatibility no-op. Proxy pickup logs are automatic for Esri health checks.
    }
    else if (arg === "--max-concurrent-requests") {
      opts.maxConcurrentRequests = parsePositiveInt(args[++i], "--max-concurrent-requests");
      if (opts.maxConcurrentRequests === null) {
        throw new Error("--max-concurrent-requests must be a positive integer");
      }
    }
    else if (arg === "--state-db") {
      opts.stateDbPath = args[++i];
      if (!opts.stateDbPath) throw new Error("--state-db requires a path");
    } else if (arg === "--row-recovery-passes") {
      opts.rowRecoveryPasses = parseNonNegativeInt(args[++i], "--row-recovery-passes");
      if (opts.rowRecoveryPasses === null) throw new Error("--row-recovery-passes must be a non-negative integer");
    } else if (arg === "--recovery-backoff-ms") {
      const value = args[++i];
      opts.recoveryBackoffMs = parsePositiveInt(value, "--recovery-backoff-ms");
      if (opts.recoveryBackoffMs === null) {
        throw new Error("--recovery-backoff-ms must be a positive integer");
      }
    } else if (arg === "--max-rows-in-flight") {
      opts.maxRowsInFlight = parsePositiveInt(args[++i], "--max-rows-in-flight");
      if (opts.maxRowsInFlight === null) {
        throw new Error("--max-rows-in-flight must be a positive integer");
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      opts.configPaths.push(arg);
    }
  }

  if (opts.skipVerifyAfterDownload && (opts.validate || opts.forceVerify)) {
    throw new Error("--skip-verify cannot be used with --validate or --force-verify");
  }

  const esriFastModeFromEnv = parseBoolean(process.env.TILE_DOWNLOADER_ESRI_FAST_MODE);
  if (esriFastModeFromEnv !== null) opts.esriFastMode = esriFastModeFromEnv;
  const skipVerifyFromEnv = parseBoolean(process.env.TILE_DOWNLOADER_SKIP_VERIFY);
  if (skipVerifyFromEnv !== null) opts.skipVerifyAfterDownload = skipVerifyFromEnv;
  const maxConcurrentFromEnv = parsePositiveInt(process.env.TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS);
  if (maxConcurrentFromEnv !== null && opts.maxConcurrentRequests === null) {
    opts.maxConcurrentRequests = maxConcurrentFromEnv;
  }

  if (opts.configPaths.length === 0) {
    opts.usedDefaultConfig = true;
    opts.configPaths.push(path.join(__dirname, "configs", "mapbox-pbf.config.json"));
  }
  return opts;
}

function machineNamesFromEnv(env = process.env) {
  const raw = (
    env.MACHINE_NAME ||
    env.TILE_MACHINE_NAME ||
    env.CONFIG_NAME ||
    env.NAME ||
    ""
  ).trim();

  return raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function pathMatchesMachine(configPath, machineNames) {
  const base = path.basename(configPath).toLowerCase();
  return machineNames.some(
    (machineName) =>
      base === `${machineName}.config.json` ||
      base.endsWith(`-${machineName}.config.json`) ||
      base.includes(`-${machineName}-`)
  );
}

function resolveMachineConfigPaths(opts, env = process.env) {
  const machineNames = machineNamesFromEnv(env);
  if (machineNames.length === 0) return opts.configPaths;
  if (!opts.usedDefaultConfig && opts.configPaths.length === 1) return opts.configPaths;

  const matching = opts.configPaths.filter((configPath) =>
    pathMatchesMachine(configPath, machineNames)
  );
  if (matching.length > 0) {
    console.log(`Machine configs selected from env: ${machineNames.join(",")}`);
    return matching;
  }

  if (opts.usedDefaultConfig) {
    const machineConfigs = machineNames.map((machineName) =>
      path.join(__dirname, "configs", `mapbox-pbf-${machineName}.config.json`)
    );
    const existing = machineConfigs.filter((configPath) => fs.existsSync(configPath));
    if (existing.length > 0) {
      if (existing.length < machineNames.length) {
        console.log(
          `Machine configs partly matched from default config names (${machineNames.join(",")}); using ${existing.join(", ")}`
        );
      } else {
        console.log(`Machine configs selected from env: ${machineNames.join(",")}`);
      }
      return existing;
    }
  }

  console.log(
    `Machine names ${machineNames.join(",")} did not match machine-specific configs; using configured config list`
  );
  return opts.configPaths;
}

function stateDbPathFor(config, opts) {
  if (!opts.stateDbPath) {
    return path.resolve(
      path.join(config.configDir, "..", ".tile-state", `${config.jobName}.sqlite`)
    );
  }

  const explicit = path.resolve(opts.stateDbPath);
  if (opts.resolvedConfigPaths.length === 1 && explicit.endsWith(".sqlite")) return explicit;
  return path.join(explicit, `${config.jobName}.sqlite`);
}

async function runOneConfig(configPath, opts) {
  const configEnv = {
    ...process.env,
    ...(opts.maxRowsInFlight
      ? { TILE_DOWNLOADER_MAX_ROWS_IN_FLIGHT: String(opts.maxRowsInFlight) }
      : null),
    ...(opts.maxConcurrentRequests
      ? { TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS: String(opts.maxConcurrentRequests) }
      : null),
  };
  const config = await loadConfig(configPath, { env: configEnv });
  const stateDbPath = stateDbPathFor(config, opts);
  const stateDb = new TileStateDb(stateDbPath);
  const proxyHealthcheckUrl = proxyHealthcheckUrlForConfig(config);

  try {
    const proxyRuntimeEnv = opts.dryRun
      ? null
      : {
          ...stripProcessProxyEnv(process.env),
          ...(proxyHealthcheckUrl
            ? { TILE_DOWNLOADER_PROXY_HEALTHCHECK_URL: proxyHealthcheckUrl }
            : null),
        };
    const proxyRotation = opts.dryRun
      ? null
      : await configureNetworking(config.platformProfile, proxyRuntimeEnv);
    if (
      !opts.dryRun &&
      proxyHealthcheckUrl &&
      proxyRuntimeEnv?.TILE_DOWNLOADER_PROXY_REQUIRED !== "0" &&
      !proxyRotation
    ) {
      throw new Error("Proxy setup did not produce a healthy proxy; refusing to start download");
    }
    console.log("");
    console.log(`Config: ${config.configPath}`);
    console.log(`Job: ${config.jobName}`);
    console.log(`Provider: ${config.provider}`);
    console.log(`Platform: ${config.platformProfile.os}`);
    console.log(`Output: ${config.output.dir}`);
    console.log(`State DB: ${stateDbPath}`);
    if (!opts.dryRun && proxyHealthcheckUrl) {
      console.log("Proxy pickup: enabled");
      if (process.env.TILE_DOWNLOADER_PROXY_TRACE_REQUESTS === "1") {
        console.log("Proxy request trace: enabled");
      }
      console.log(`Proxy healthcheck: ${proxyHealthcheckUrl}`);
    }
      console.log(
        `Concurrency: requests=${config.platformProfile.maxConcurrentRequests}, rows=${config.platformProfile.maxRowsInFlight}, perRow=${config.platformProfile.perRowConcurrency}`
      );
    if (config.platformProfile.wasConcurrencyCapped) {
      console.log(
        `Concurrency capped from ${config.platformProfile.requestedConcurrency} to ${config.platformProfile.maxConcurrentRequests} for ${config.platformProfile.os}`
      );
    }
    if (config.platformProfile.wereRowsCapped) {
      console.log(
        `Rows capped from ${config.platformProfile.requestedRows} to ${config.platformProfile.maxRowsInFlight} for ${config.platformProfile.os}`
      );
    }
    if (opts.validate) {
      console.log("Mode: validate/download missing");
    } else if (opts.dryRun) {
      console.log("Mode: dry-run");
    } else {
      console.log("Mode: download/resume");
    }

    const result = await runDownloadJob({
      config,
      stateDb,
      env: process.env,
      dryRun: opts.dryRun,
      forceVerify: opts.forceVerify || opts.validate,
      esriFastMode: opts.esriFastMode,
      skipVerifyAfterDownload: opts.skipVerifyAfterDownload,
      rowRecoveryPasses: opts.rowRecoveryPasses,
      recoveryBackoffMs: opts.recoveryBackoffMs,
      proxyRotation,
    });

    console.log("Summary:");
    console.log(`  Rows planned: ${result.rowsPlanned}`);
    console.log(`  Rows skipped: ${result.rowsSkipped}`);
    console.log(`  Rows completed: ${result.rowsCompleted}`);
    console.log(`  Tiles planned: ${result.tilesPlanned}`);
    console.log(`  Tiles downloaded: ${result.tilesDownloaded}`);
    console.log(`  Tile files skipped: ${result.tileFilesSkipped}`);
    console.log(`  Tiles missing: ${result.tilesMissing}`);
    console.log(`  Tiles failed: ${result.tilesFailed}`);
    console.log(`  Ranges verified: ${result.rangesVerified}`);

    if (result.tilesFailed > 0) process.exitCode = 1;
  } finally {
    stateDb.close();
  }
}

async function runSplit(opts) {
  const absConfigPath = path.resolve(opts.configPath);
  const raw = JSON.parse(await fsp.readFile(absConfigPath, "utf8"));
  const outDir = path.resolve(
    opts.outDir || path.join(path.dirname(absConfigPath), `${path.basename(absConfigPath, ".json")}-split`)
  );
  const split = splitConfigByRows(raw, {
    parts: opts.parts,
    names: opts.names,
  });

  await fsp.mkdir(outDir, { recursive: true });
  for (const item of split) {
    const outPath = path.join(outDir, `${item.name}.config.json`);
    await fsp.writeFile(outPath, JSON.stringify(item.config, null, 2) + "\n");
    console.log(
      `Wrote ${outPath} rows=${item.rows} estimatedTiles=${item.tiles}`
    );
  }
}

async function clearTokenState(opts) {
  const root = path.resolve(opts.stateDbPath || ".tile-state");
  const files = fs.existsSync(root) && fs.statSync(root).isDirectory()
    ? fs.readdirSync(root).filter((name) => name.endsWith(".sqlite")).map((name) => path.join(root, name))
    : [root];

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const db = new TileStateDb(file);
    try {
      db.clearMapboxTokenState();
      console.log(`Cleared token state only: ${file}`);
    } finally {
      db.close();
    }
  }
}

async function main() {
  loadDotEnvIfPresent();
  const opts = parseArgs(process.argv);
  if (opts.command === "split") {
    await runSplit(opts);
    return;
  }
  if (opts.command === "clear-token-state") {
    await clearTokenState(opts);
    return;
  }

  opts.resolvedConfigPaths = resolveMachineConfigPaths(opts, process.env);
  for (let i = 0; i < opts.resolvedConfigPaths.length; i++) {
    console.log(`\n=== Config ${i + 1}/${opts.resolvedConfigPaths.length} ===`);
    await runOneConfig(opts.resolvedConfigPaths[i], opts);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
