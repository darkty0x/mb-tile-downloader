#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeRanges } from "./src/config/config-loader.js";
import { assertDashboardManagedRun } from "./src/agent/managed-run-guard.js";
import { enableWindowsUtf8Console } from "./src/runtime/windows-console.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
enableWindowsUtf8Console();
const LOCAL_UPLINK_BIN = path.join(
  __dirname,
  "tools",
  "uplink",
  process.platform === "win32" ? "uplink.exe" : "uplink"
);
const UPLINK_ACCESS_NAME = "mb-tile-downloader";
const DEFAULT_STORJ_PREFIX = "archives";
const DEFAULT_SOURCE_CONFIG = path.join(__dirname, "configs", "esri-satellite.config.json");
const DEFAULT_FILE_NAME_TEMPLATE = "tiles_{layer}_{z}_{xStart}-{xEnd}_y{yStart}-{yEnd}.zip";
const LEGACY_MANIFEST_NAME = "archives-manifest.json";

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
  const cmd = path.basename(process.argv[1] || "storj-uploader.js");
  console.log(
    [
      "",
      "Upload completed ZIP archives to Storj, then delete local ZIPs after remote verification.",
      "",
      `Usage: node ${cmd} [configPath] [--archive-dir=path] [--bucket=name] [--prefix=path] [--access=grant] [--dry-run] [--keep-local] [--range-index=N]`,
      "",
  "Environment:",
  "  STORJ_BUCKET          required unless --bucket is provided",
  `  STORJ_PREFIX          remote folder/prefix only when no configPath is provided; configPath defaults to jobName`,
  "  STORJ_ACCESS          serialized Access Grant, or \"satellite api-key\" pair",
  "  STORJ_PASSPHRASE      required only when STORJ_ACCESS is a satellite/api-key pair",
  "  STORJ_UPLINK_CONFIG_DIR  path to a shared uplink config dir (default: <repo>/.tile-state/storj)",
  "",
  "Uplink binary:",
  "  Uses bundled tools/uplink/uplink.exe on Windows, or PATH uplink fallback.",
  "  Override config dir with --uplink-config-dir=<path> or STORJ_UPLINK_CONFIG_DIR.",
      "",
      "Behavior:",
      "  - uploads only completed .zip files",
      "  - when configPath is provided, uploads only ZIPs expected by that config",
      "  - skips upload when the same remote object already exists",
      "  - keeps local zips skipped by remote-exists because size/hash is not proven",
      "  - deletes the local zip only after this run uploads and confirms the remote object",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    archiveDir: path.join(__dirname, "archives"),
    bucket: null,
    prefix: null,
    access: null,
    uplinkConfigDir: null,
    dryRun: false,
    keepLocal: false,
    rangeIndex: null,
    configPath: null,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") printUsage(0);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--keep-local") opts.keepLocal = true;
    else if (arg.startsWith("--archive-dir=")) opts.archiveDir = arg.slice("--archive-dir=".length);
    else if (arg.startsWith("--bucket=")) opts.bucket = arg.slice("--bucket=".length);
    else if (arg.startsWith("--prefix=")) opts.prefix = arg.slice("--prefix=".length);
    else if (arg.startsWith("--access=")) opts.access = arg.slice("--access=".length);
    else if (arg.startsWith("--uplink-config-dir=")) opts.uplinkConfigDir = arg.slice("--uplink-config-dir=".length);
    else if (arg.startsWith("--range-index=")) {
      opts.rangeIndex = Number.parseInt(arg.slice("--range-index=".length), 10);
      if (!Number.isInteger(opts.rangeIndex) || opts.rangeIndex < 0) {
        throw new Error("--range-index must be a non-negative integer");
      }
    }
    else if (!arg.startsWith("-") && !opts.configPath) opts.configPath = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (opts.configPath) opts.configPath = path.resolve(opts.configPath);
  opts.archiveDir = path.resolve(opts.archiveDir);
  opts.bucket = opts.bucket || process.env.STORJ_BUCKET;
  opts.prefix = opts.prefix ?? null;
  opts.access = opts.access || process.env.STORJ_ACCESS || process.env.STORJ_ACCESS_GRANT;
  opts.passphrase = process.env.STORJ_PASSPHRASE || process.env.STORJ_ENCRYPTION_PASSPHRASE;
  opts.uplinkConfigDir = resolveUplinkConfigDir(opts.uplinkConfigDir);
  return opts;
}

function resolveUplinkConfigDir(value) {
  if (value) return path.resolve(value);
  const envDir = process.env.STORJ_UPLINK_CONFIG_DIR;
  if (envDir && String(envDir).trim()) return path.resolve(envDir);
  return path.join(__dirname, ".tile-state", "storj");
}

function normalizePrefix(prefix) {
  return String(prefix || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function remoteUrl(bucket, prefix, name) {
  const cleanPrefix = normalizePrefix(prefix);
  const encodedName = encodeURIComponent(name).replace(/%2F/gi, "/");
  return cleanPrefix
    ? `sj://${bucket}/${cleanPrefix}/${encodedName}`
    : `sj://${bucket}/${encodedName}`;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function archiveFileName(template, { layer, z, xStart, xEnd, yStart, yEnd, xPadWidth }) {
  return template
    .replaceAll("{layer}", layer)
    .replaceAll("{z}", String(z))
    .replaceAll("{xStart}", pad(xStart, xPadWidth))
    .replaceAll("{xEnd}", pad(xEnd, xPadWidth))
    .replaceAll("{xStartRaw}", String(xStart))
    .replaceAll("{xEndRaw}", String(xEnd))
    .replaceAll("{yStart}", pad(yStart, xPadWidth))
    .replaceAll("{yEnd}", pad(yEnd, xPadWidth))
    .replaceAll("{yStartRaw}", String(yStart))
    .replaceAll("{yEndRaw}", String(yEnd));
}

function isDownloaderConfig(config) {
  return Boolean(config?.provider && Array.isArray(config?.ranges));
}

async function loadJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

function parseStorjCredentials({ access, passphrase }) {
  const rawAccess = String(access || "").trim();
  if (!rawAccess) {
    throw new Error(
      "STORJ_ACCESS is required on this server, or pass --access=grant. The repo .env file is ignored by git, so copy STORJ_BUCKET, STORJ_ACCESS, and STORJ_PASSPHRASE to each upload server."
    );
  }

  const parts = rawAccess.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && /@[^:\s]+:\d+$/.test(parts[0])) {
    const setupPassphrase = String(passphrase || "").trim();
    if (!setupPassphrase) {
      throw new Error(
        "STORJ_ACCESS contains satellite address + API key. Set STORJ_PASSPHRASE on this server to configure uplink from those two values, or replace STORJ_ACCESS with a serialized Access Grant."
      );
    }
    return {
      type: "api-key",
      satellite: parts[0],
      apiKey: parts[1],
      passphrase: setupPassphrase,
    };
  }

  if (/\s/.test(rawAccess)) {
    throw new Error("STORJ_ACCESS must be one serialized Access Grant value without spaces.");
  }

  return { type: "access-grant", access: rawAccess };
}

function uplinkArgs(args, configDir) {
  return ["--config-dir", configDir, ...args];
}

async function commandWorks(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["version"], { stdio: "ignore", env: process.env });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

let cachedUplinkBinary = null;
async function resolveUplinkBinary() {
  if (cachedUplinkBinary) return cachedUplinkBinary;
  if (await commandWorks(LOCAL_UPLINK_BIN)) {
    cachedUplinkBinary = LOCAL_UPLINK_BIN;
    return cachedUplinkBinary;
  }
  if (await commandWorks("uplink")) {
    cachedUplinkBinary = "uplink";
    return cachedUplinkBinary;
  }
  throw new Error(
    "No working Storj uplink binary found. Run 'node scripts/install-storj-uplink.js --if-missing' to install."
  );
}

async function runUplink(args, { allowFailure = false, input = null, configDir } = {}) {
  const bin = await resolveUplinkBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, uplinkArgs(args, configDir), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: path.dirname(bin) === "." ? process.cwd() : path.dirname(bin),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
    child.on("error", (err) => {
      const installHint =
        process.platform === "win32"
          ? "Install it with: winget install -e --id Storj.Uplink, then reopen PowerShell."
          : process.platform === "darwin"
            ? "Install it with: brew install storj-uplink."
            : "Install Storj Uplink CLI and make sure uplink is on PATH.";
      reject(
        new Error(
          `Failed to run ${bin}. ${installHint} Original error: ${err.message}`
        )
      );
    });
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${bin} ${args[0]} failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function ensureAccessConfigured(credentials, configDir) {
  await fsp.mkdir(configDir, { recursive: true });
  if (credentials.type === "access-grant") {
    await runUplink(["access", "import", UPLINK_ACCESS_NAME, credentials.access, "--force", "--use"], { configDir });
    return;
  }

  await runUplink(
    [
      "access",
      "create",
      "--satellite-address",
      credentials.satellite,
      "--api-key",
      credentials.apiKey,
      "--passphrase-stdin",
      "--import-as",
      UPLINK_ACCESS_NAME,
      "--force",
      "--use",
    ],
    {
      input: `${credentials.passphrase}\n`,
      configDir,
    }
  );
}

function uplinkListContainsObject(stdout, name) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      const normalized = line.replace(/\\/g, "/");
      return normalized === name || normalized.endsWith(`/${name}`) || normalized.endsWith(` ${name}`);
    });
}

async function remoteExists(url, name, configDir) {
  const result = await runUplink(["ls", url], { allowFailure: true, configDir });
  if (result.code !== 0) return false;
  return uplinkListContainsObject(result.stdout, name);
}

async function listCompletedArchives(archiveDir) {
  const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    const filePath = path.join(archiveDir, entry.name);
    const stat = await fsp.stat(filePath);
    if (stat.size <= 0) continue;
    archives.push({ name: entry.name, filePath, size: stat.size });
  }
  archives.sort((a, b) => a.name.localeCompare(b.name));
  return archives;
}

async function loadArchivePlan(configPath, { rangeIndex = null } = {}) {
  if (!configPath) return null;
  const rawConfig = await loadJson(configPath);
  const configDir = path.dirname(configPath);
  const directDownloaderConfig = isDownloaderConfig(rawConfig);
  const hasArchivePlanInputs =
    directDownloaderConfig ||
    rawConfig.sourceConfigPath ||
    Array.isArray(rawConfig.ranges) ||
    Array.isArray(rawConfig.layers) ||
    rawConfig.fileNameTemplate;
  if (!hasArchivePlanInputs) {
    return {
      sourceConfigPath: null,
      jobName: rawConfig.jobName || path.basename(configPath, ".json"),
      expectedNames: null,
    };
  }
  const sourceConfigPath = directDownloaderConfig
    ? configPath
    : path.resolve(configDir, rawConfig.sourceConfigPath || DEFAULT_SOURCE_CONFIG);
  const sourceConfig = directDownloaderConfig ? rawConfig : await loadJson(sourceConfigPath);
  const rangeConfig =
    !directDownloaderConfig && Array.isArray(rawConfig.ranges) && rawConfig.ranges.length > 0
      ? rawConfig
      : sourceConfig;
  let ranges = normalizeRanges(rangeConfig);
  if (ranges.length === 0) {
    throw new Error("No ranges found. Add ranges to the config.");
  }
  if (rangeIndex !== null) {
    if (rangeIndex >= ranges.length) {
      throw new Error(`--range-index ${rangeIndex} is outside config range count ${ranges.length}`);
    }
    ranges = [ranges[rangeIndex]];
  }

  const layers =
    !directDownloaderConfig && Array.isArray(rawConfig.layers) && rawConfig.layers.length > 0
      ? rawConfig.layers
      : sourceConfig.layer
        ? [sourceConfig.layer]
        : [sourceConfig.provider === "mapbox" ? "vector" : "esri-satellite"];
  const fileNameTemplate = rawConfig.fileNameTemplate || DEFAULT_FILE_NAME_TEMPLATE;
  const xPadWidth = Number(rawConfig.xPadWidth || 6);
  const expectedNames = new Set();

  for (const layer of layers) {
    for (const range of ranges) {
      for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
        expectedNames.add(
          archiveFileName(fileNameTemplate, {
            layer,
            z,
            xStart: range.xStart,
            xEnd: range.xEnd,
            yStart: range.yStart,
            yEnd: range.yEnd,
            xPadWidth,
          })
        );
      }
    }
  }

  return {
    sourceConfigPath,
    jobName: sourceConfig.jobName || rawConfig.jobName || path.basename(configPath, ".json"),
    expectedNames: [...expectedNames],
  };
}

function filterArchivesByPlan(archives, plan) {
  if (!plan?.expectedNames) return { archives, missing: [] };
  const byName = new Map(archives.map((archive) => [archive.name, archive]));
  const filtered = [];
  const missing = [];
  for (const name of plan.expectedNames) {
    const archive = byName.get(name);
    if (archive) filtered.push(archive);
    else missing.push(name);
  }
  return { archives: filtered, missing };
}

async function uploadArchive({ archive, bucket, prefix, dryRun, keepLocal }, configDir) {
  const url = remoteUrl(bucket, prefix, archive.name);
  const cleanPrefix = normalizePrefix(prefix);
  const remotePath = cleanPrefix ? `${cleanPrefix}/${archive.name}` : archive.name;
  const resultBase = {
    ok: true,
    bucket,
    remotePath,
    remoteUrl: url,
    localPath: archive.filePath,
    bytes: archive.size,
  };
  if (dryRun) {
    console.log(`DRY RUN upload: ${archive.filePath} -> ${url}`);
    return { ...resultBase, status: "dry-run" };
  }

  if (await remoteExists(url, archive.name, configDir)) {
    console.log(`SKIP remote exists: ${archive.name}`);
    console.log(`  kept local: ${archive.filePath}`);
    return { ...resultBase, status: "skipped" };
  }

  console.log(`UPLOAD: ${archive.name} size=${archive.size} -> ${url}`);
  await runUplink(["cp", archive.filePath, url], { configDir });
  if (!(await remoteExists(url, archive.name, configDir))) {
    throw new Error(`Remote verification failed after upload: ${url}`);
  }
  if (!keepLocal) {
    await fsp.rm(archive.filePath, { force: true });
    console.log(`  deleted local: ${archive.filePath}`);
  }
  return { ...resultBase, status: "uploaded" };
}

function shareTargetUrl(bucket, prefix) {
  const cleanPrefix = normalizePrefix(prefix);
  return cleanPrefix ? `sj://${bucket}/${cleanPrefix}/` : `sj://${bucket}/`;
}

async function removeLegacyManifest({ bucket, prefix, dryRun }, configDir) {
  const url = remoteUrl(bucket, prefix, LEGACY_MANIFEST_NAME);
  if (dryRun) return;
  if (!(await remoteExists(url, LEGACY_MANIFEST_NAME, configDir))) return;
  const result = await runUplink(["rm", url], { allowFailure: true, configDir });
  if (result.code === 0) console.log(`REMOVED legacy manifest: ${url}`);
  else console.warn(`Legacy manifest cleanup failed for ${url}: ${result.stderr || result.stdout}`);
}

function extractShareUrl(output) {
  const match = String(output || "").match(/https:\/\/link\.storjshare\.io\/\S+/);
  return match ? match[0].trim() : null;
}

async function printShareLink({ bucket, prefix, dryRun }, configDir) {
  const target = shareTargetUrl(bucket, prefix);
  if (dryRun) {
    console.log(`Share link: dry-run skipped for ${target}`);
    return { ok: true, status: "dry-run-share-skipped", bucket, target };
  }

  const result = await runUplink(["share", "--url", "--readonly", "--not-after=none", target], {
    configDir,
    allowFailure: true,
  });
  if (result.code !== 0) {
    console.warn(`Share link: failed to create for ${target}: ${result.stderr || result.stdout}`);
    return { ok: false, status: "share-failed", bucket, target, error: result.stderr || result.stdout };
  }

  const shareUrl = extractShareUrl(`${result.stdout}\n${result.stderr}`);
  if (!shareUrl) {
    console.warn(`Share link: uplink did not print a URL for ${target}`);
    return { ok: false, status: "share-missing-url", bucket, target };
  }

  const rawLinkPrefix = shareUrl.replace("/s/", "/raw/");
  console.log(`Share link: ${shareUrl}`);
  console.log(`Raw link prefix: ${rawLinkPrefix}`);
  return { ok: true, status: "shared", bucket, target, shareUrl, rawLinkPrefix };
}

async function main() {
  loadDotEnvIfPresent();
  assertDashboardManagedRun({ scriptName: "storj-uploader.js", argv: process.argv.slice(2) });
  const opts = parseArgs(process.argv);
  if (!opts.bucket) {
    throw new Error("STORJ_BUCKET is required, or pass --bucket=name");
  }
  const plan = await loadArchivePlan(opts.configPath, { rangeIndex: opts.rangeIndex });
  opts.prefix = opts.prefix || plan?.jobName || process.env.STORJ_PREFIX || DEFAULT_STORJ_PREFIX;
  const allArchives = await listCompletedArchives(opts.archiveDir);
  const { archives, missing } = filterArchivesByPlan(allArchives, plan);
  console.log(`Archive directory: ${opts.archiveDir}`);
  if (opts.configPath) console.log(`Config: ${opts.configPath}`);
  console.log(`Storj target: sj://${opts.bucket}/${normalizePrefix(opts.prefix)}`);
  console.log(`Completed ZIPs: ${allArchives.length}`);
  if (plan) {
    if (plan.expectedNames) {
      console.log(`Config ZIPs planned: ${plan.expectedNames.length}`);
      console.log(`Config ZIPs available: ${archives.length}`);
      console.log(`Config ZIPs missing: ${missing.length}`);
    }
    for (const name of missing) console.log(`MISSING local archive: ${name}`);
  }

  if (!opts.dryRun && (archives.length > 0 || opts.configPath)) {
    const credentials = parseStorjCredentials({
      access: opts.access,
      passphrase: opts.passphrase,
    });
    await ensureAccessConfigured(credentials, opts.uplinkConfigDir);
    await removeLegacyManifest(
      { bucket: opts.bucket, prefix: opts.prefix, dryRun: opts.dryRun },
      opts.uplinkConfigDir
    );
  }

  let uploaded = 0;
  let skipped = 0;
  for (const archive of archives) {
    const result = await uploadArchive({ archive, ...opts }, opts.uplinkConfigDir);
    console.log(`[storj-result] ${JSON.stringify(result)}`);
    if (result.status === "uploaded") uploaded++;
    else if (result.status === "skipped") skipped++;
  }

  const remainingLocal = opts.keepLocal ? archives.length : skipped;
  console.log(`Done. uploaded=${uploaded} skipped=${skipped} remainingLocal=${remainingLocal}`);
  if (missing.length > 0) {
    console.log("Share link: skipped because config upload is incomplete");
    process.exitCode = 1;
  } else {
    const shareResult = await printShareLink(
      { bucket: opts.bucket, prefix: opts.prefix, dryRun: opts.dryRun },
      opts.uplinkConfigDir
    );
    if (shareResult) console.log(`[storj-result] ${JSON.stringify(shareResult)}`);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
