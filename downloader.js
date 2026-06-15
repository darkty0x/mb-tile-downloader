#!/usr/bin/env node
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./src/config/config-loader.js";
import { splitConfigByRows } from "./src/config/config-splitter.js";
import { runDownloadJob } from "./src/engine/downloader-engine.js";
import { createProvider } from "./src/providers/index.js";
import { configureNetworking } from "./src/runtime/platform-profile.js";
import { TileStateDb } from "./src/state/state-db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MAX_OLD_SPACE_MB = 8192;

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

function proxyModeLabel(env = process.env) {
  const mode = String(env.TILE_DOWNLOADER_PROXY_MODE || env.PROXY_MODE || "fallback")
    .trim()
    .toLowerCase();
  return ["always", "force", "proxy"].includes(mode)
    ? "always"
    : "fallback";
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

function printUsage(exitCode = 0) {
  console.log(`
Production tile downloader

Usage:
  node downloader.js <configPath...> [--validate] [--force-verify] [--dry-run] [--skip-verify]
  [--row-recovery-passes N] [--recovery-backoff-ms N] [--max-rows-in-flight N] [--max-concurrent-requests N] [--range-index N] [--esri-fast] [--no-proxy]
  [--state-db path-or-dir]
  node downloader.js split <configPath> --parts N [--out dir] [--names cig,cmi,kuh]
  node downloader.js delete-unavailable <configPath...>
  node downloader.js clear-token-state [--state-db path-or-dir]

Proxy:
  proxy.txt in the project root is used automatically when no explicit proxy list env is set.
  Optional overrides:
    TILE_DOWNLOADER_PROXY_LIST=http://user:pass@host1:port,http://user:pass@host2:port
    TILE_DOWNLOADER_PROXY_LIST_FILE=/path/to/proxies.txt
    TILE_DOWNLOADER_PROXY_USERNAME=... and TILE_DOWNLOADER_PROXY_PASSWORD=... for host:port files without auth
    TILE_DOWNLOADER_HTTP_PROXY_LIST=... and TILE_DOWNLOADER_HTTPS_PROXY_LIST=... for protocol-specific lists

Examples:
  node downloader.js configs/mapbox-pbf.config.json
  node downloader.js configs/cig.config.json configs/cmi.config.json --dry-run
  node downloader.js configs/mapbox-pbf.config.json --validate --force-verify
  node downloader.js split configs/mapbox-pbf.config.json --parts 6 --out configs/mapbox-pbf-machines
  node downloader.js split configs/esri-satellite.config.json --names cig,cmi,kuh --out configs/esri-machines
  node downloader.js delete-unavailable configs/esri-satellite.config.json
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

function parseDeleteUnavailableArgs(args) {
  const opts = {
    command: "delete-unavailable",
    configPaths: [],
    usedDefaultConfig: false,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      throw new Error(`Unknown delete-unavailable option: ${arg}`);
    }
    opts.configPaths.push(arg);
  }

  if (opts.configPaths.length === 0) {
    throw new Error("delete-unavailable requires at least one config path");
  }
  return opts;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) printUsage(0);
  if (args[0] === "split") return parseSplitArgs(args);
  if (args[0] === "clear-token-state") return parseClearTokenStateArgs(args);
  if (args[0] === "delete-unavailable") return parseDeleteUnavailableArgs(args);

  const opts = {
    command: "run",
    validate: false,
    forceVerify: false,
    dryRun: false,
    skipVerifyAfterDownload: false,
    esriFastMode: false,
    noProxy: false,
    maxConcurrentRequests: null,
    rowRecoveryPasses: null,
    recoveryBackoffMs: null,
    maxRowsInFlight: null,
    stateDbPath: null,
    rangeIndex: null,
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
    else if (arg === "--no-proxy") opts.noProxy = true;
    else if (arg === "--proxy-trace") {
      // Deprecated compatibility no-op. Proxy use is reported automatically.
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
    } else if (arg === "--range-index") {
      opts.rangeIndex = parseNonNegativeInt(args[++i], "--range-index");
      if (opts.rangeIndex === null) throw new Error("--range-index must be a non-negative integer");
    } else if (arg.startsWith("--range-index=")) {
      opts.rangeIndex = parseNonNegativeInt(arg.slice("--range-index=".length), "--range-index");
      if (opts.rangeIndex === null) throw new Error("--range-index must be a non-negative integer");
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
  if (opts.rangeIndex !== null) {
    if (opts.rangeIndex >= config.ranges.length) {
      throw new Error(`--range-index ${opts.rangeIndex} is outside config range count ${config.ranges.length}`);
    }
    const sourceRangeIndex = opts.rangeIndex + 1;
    config.rangeCount = config.ranges.length;
    config.ranges = [{ ...config.ranges[opts.rangeIndex], sourceRangeIndex }];
  }
  const stateDbPath = stateDbPathFor(config, opts);
  const stateDb = new TileStateDb(stateDbPath);

  try {
    const proxyRuntimeEnv = opts.dryRun
      ? null
      : process.env;
    const proxyRotation = opts.dryRun || opts.noProxy
      ? null
      : await configureNetworking(config.platformProfile, proxyRuntimeEnv);
    console.log("");
    console.log(`Config: ${config.configPath}`);
    console.log(`Job: ${config.jobName}`);
    console.log(`Provider: ${config.provider}`);
    console.log(`Platform: ${config.platformProfile.os}`);
    console.log(`Output: ${config.output.dir}`);
    console.log(`State DB: ${stateDbPath}`);
    if (!opts.dryRun && proxyRotation) {
      const mode = proxyModeLabel(process.env);
      console.log(
        mode === "always"
          ? "Proxy: always enabled from env"
          : "Proxy: fallback enabled from env (direct first)"
      );
    } else if (opts.noProxy) {
      console.log("Proxy: disabled (--no-proxy)");
    } else if (!opts.dryRun) {
      console.log("Proxy: disabled (no env proxy list)");
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
      env: proxyRuntimeEnv || process.env,
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

function assertPathInsideOutput(config, filePath) {
  const outputRoot = path.resolve(config.output.dir);
  const absPath = path.resolve(filePath);
  if (absPath !== outputRoot && !absPath.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`Refusing to delete outside configured output dir: ${absPath}`);
  }
}

async function* walkExistingFiles(rootDir) {
  let dir;
  try {
    dir = await fsp.opendir(rootDir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  for await (const entry of dir) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkExistingFiles(filePath);
    } else if (entry.isFile()) {
      yield filePath;
    }
  }
}

function providerExtensionSuffix(provider) {
  const extension = String(provider.extension || "").trim().toLowerCase();
  if (!extension) return "";
  return extension.startsWith(".") ? extension : `.${extension}`;
}

async function isUnavailableTileFile(provider, filePath) {
  let buffer;
  try {
    buffer = await fsp.readFile(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  return Boolean(provider.isUnavailable?.(buffer));
}

async function deleteUnavailableForConfig(configPath) {
  const config = await loadConfig(configPath, { env: process.env });
  const provider = createProvider(config);
  if (typeof provider.isUnavailable !== "function") {
    throw new Error(`Provider ${config.provider} does not support unavailable tile detection`);
  }

  let tilesScanned = 0;
  let unavailableDeleted = 0;
  const extensionSuffix = providerExtensionSuffix(provider);

  console.log("");
  console.log(`Config: ${config.configPath}`);
  console.log(`Provider: ${config.provider}`);
  console.log(`Output: ${config.output.dir}`);

  for await (const filePath of walkExistingFiles(config.output.dir)) {
    assertPathInsideOutput(config, filePath);
    if (extensionSuffix && !filePath.toLowerCase().endsWith(extensionSuffix)) continue;
    tilesScanned++;
    if (await isUnavailableTileFile(provider, filePath)) {
      await fsp.unlink(filePath);
      unavailableDeleted++;
    }
    if (tilesScanned > 0 && tilesScanned % 10_000 === 0) {
      console.log(`  cleanup progress: scanned=${tilesScanned} deleted=${unavailableDeleted}`);
    }
  }

  console.log(`Tiles scanned: ${tilesScanned}`);
  console.log(`Unavailable tiles deleted: ${unavailableDeleted}`);
}

async function runDeleteUnavailable(opts) {
  opts.resolvedConfigPaths = resolveMachineConfigPaths(opts, process.env);
  for (let i = 0; i < opts.resolvedConfigPaths.length; i++) {
    console.log(`\n=== Config ${i + 1}/${opts.resolvedConfigPaths.length} ===`);
    await deleteUnavailableForConfig(opts.resolvedConfigPaths[i]);
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
  if (opts.command === "delete-unavailable") {
    await runDeleteUnavailable(opts);
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
