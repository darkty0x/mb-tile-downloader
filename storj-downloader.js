#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeRanges } from "./src/config/config-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_UPLINK_BIN = path.join(
  __dirname,
  "tools",
  "uplink",
  process.platform === "win32" ? "uplink.exe" : "uplink"
);
const UPLINK_CONFIG_DIR = path.join(__dirname, "tools", "uplink", "config");
const UPLINK_ACCESS_NAME = "mb-tile-downloader";
const DEFAULT_STORJ_PREFIX = "archives";
const DEFAULT_DOWNLOAD_DIR = path.join(__dirname, "download");
const DEFAULT_SOURCE_CONFIG = path.join(__dirname, "configs", "esri-satellite.config.json");
const DEFAULT_FILE_NAME_TEMPLATE = "tiles_{layer}_{z}_{xStart}-{xEnd}_y{yStart}-{yEnd}.zip";

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
  const cmd = path.basename(process.argv[1] || "storj-downloader.js");
  console.log(
    [
      "",
      "Download ZIP archives from Storj for the ranges in a downloader config.",
      "",
      `Usage: node ${cmd} <configPath> [--download-dir=path] [--bucket=name] [--prefix=path] [--access=grant] [--dry-run]`,
      "",
      "Default layout:",
      "  local files: <repo>/download/range-000001/<zip-file>",
      "",
      "Environment:",
      "  STORJ_BUCKET          required unless --bucket is provided",
      `  STORJ_PREFIX          remote folder/prefix, default ${DEFAULT_STORJ_PREFIX}`,
      "  STORJ_ACCESS          serialized Access Grant, or \"satellite api-key\" pair",
      "  STORJ_PASSPHRASE      required only when STORJ_ACCESS is a satellite/api-key pair",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    configPath: null,
    downloadDir: DEFAULT_DOWNLOAD_DIR,
    bucket: null,
    prefix: null,
    access: null,
    dryRun: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") printUsage(0);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--download-dir=")) opts.downloadDir = arg.slice("--download-dir=".length);
    else if (arg.startsWith("--bucket=")) opts.bucket = arg.slice("--bucket=".length);
    else if (arg.startsWith("--prefix=")) opts.prefix = arg.slice("--prefix=".length);
    else if (arg.startsWith("--access=")) opts.access = arg.slice("--access=".length);
    else if (!arg.startsWith("-") && !opts.configPath) opts.configPath = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.configPath) throw new Error("configPath is required");
  opts.configPath = path.resolve(opts.configPath);
  opts.downloadDir = path.resolve(opts.downloadDir);
  opts.bucket = opts.bucket || process.env.STORJ_BUCKET;
  opts.prefix = opts.prefix ?? (process.env.STORJ_PREFIX || DEFAULT_STORJ_PREFIX);
  opts.access = opts.access || process.env.STORJ_ACCESS || process.env.STORJ_ACCESS_GRANT;
  opts.passphrase = process.env.STORJ_PASSPHRASE || process.env.STORJ_ENCRYPTION_PASSPHRASE;
  return opts;
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

function parseStorjCredentials({ access, passphrase }) {
  const rawAccess = String(access || "").trim();
  if (!rawAccess) {
    throw new Error("STORJ_ACCESS is required, or pass --access=grant");
  }

  const parts = rawAccess.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && /@[^:\s]+:\d+$/.test(parts[0])) {
    const setupPassphrase = String(passphrase || "").trim();
    if (!setupPassphrase) {
      throw new Error(
        "STORJ_ACCESS contains satellite address + API key. Set STORJ_PASSPHRASE to configure uplink from those two values, or replace STORJ_ACCESS with a serialized Access Grant."
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

function uplinkArgs(args) {
  return ["--config-dir", UPLINK_CONFIG_DIR, ...args];
}

function runUplink(args, { allowFailure = false, input = null } = {}) {
  const bin = fs.existsSync(LOCAL_UPLINK_BIN) ? LOCAL_UPLINK_BIN : "uplink";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, uplinkArgs(args), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
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
      reject(new Error(`Failed to run ${bin}. Original error: ${err.message}`));
    });
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${bin} ${args[0]} failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function ensureAccessConfigured(credentials) {
  await fsp.mkdir(UPLINK_CONFIG_DIR, { recursive: true });
  if (credentials.type === "access-grant") {
    await runUplink(["access", "import", UPLINK_ACCESS_NAME, credentials.access, "--force", "--use"]);
    return;
  }

  const input = [
    UPLINK_ACCESS_NAME,
    credentials.apiKey,
    credentials.satellite,
    credentials.passphrase,
    credentials.passphrase,
    "N",
    "N",
    "",
  ].join("\n");
  await runUplink(["setup", "--force", "--use"], { input });
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

async function remoteExists(url, name) {
  const result = await runUplink(["ls", url], { allowFailure: true });
  if (result.code !== 0) return false;
  return uplinkListContainsObject(result.stdout, name);
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

function safeFolderName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function rangeFolderName(rawRange, idx) {
  const configuredId =
    rawRange?.id ?? rawRange?.rangeId ?? rawRange?.name ?? rawRange?.label;
  return safeFolderName(configuredId) || `range-${pad(idx + 1, 6)}`;
}

function isDownloaderConfig(config) {
  return Boolean(config?.provider && Array.isArray(config?.ranges));
}

async function loadJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function loadArchivePlan(configPath) {
  const rawConfig = await loadJson(configPath);
  const configDir = path.dirname(configPath);
  const directDownloaderConfig = isDownloaderConfig(rawConfig);
  const sourceConfigPath = directDownloaderConfig
    ? configPath
    : path.resolve(configDir, rawConfig.sourceConfigPath || DEFAULT_SOURCE_CONFIG);
  const sourceConfig = directDownloaderConfig ? rawConfig : await loadJson(sourceConfigPath);
  const rangeConfig =
    !directDownloaderConfig && Array.isArray(rawConfig.ranges) && rawConfig.ranges.length > 0
      ? rawConfig
      : sourceConfig;
  const ranges = normalizeRanges(rangeConfig);
  if (ranges.length === 0) {
    throw new Error("No ranges found. Add ranges to the config.");
  }

  const layers = !directDownloaderConfig && Array.isArray(rawConfig.layers) && rawConfig.layers.length > 0
    ? rawConfig.layers
    : sourceConfig.layer
      ? [sourceConfig.layer]
      : [sourceConfig.provider === "mapbox" ? "vector" : "satellite"];
  const fileNameTemplate = rawConfig.fileNameTemplate || DEFAULT_FILE_NAME_TEMPLATE;
  const xPadWidth = Number(rawConfig.xPadWidth || 6);
  const archives = [];

  for (let rangeIdx = 0; rangeIdx < ranges.length; rangeIdx++) {
    const range = ranges[rangeIdx];
    const rawRange = Array.isArray(rangeConfig.ranges) ? rangeConfig.ranges[rangeIdx] : rangeConfig;
    const rangeFolder = rangeFolderName(rawRange, rangeIdx);
    for (const layer of layers) {
      for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
        archives.push({
          rangeIndex: rangeIdx + 1,
          rangeFolder,
          rangeLabel: range.label,
          name: archiveFileName(fileNameTemplate, {
            layer,
            z,
            xStart: range.xStart,
            xEnd: range.xEnd,
            yStart: range.yStart,
            yEnd: range.yEnd,
            xPadWidth,
          }),
        });
      }
    }
  }

  return { sourceConfigPath, layers, ranges, archives };
}

async function localZipComplete(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function downloadArchive({ archive, bucket, prefix, downloadDir, dryRun }) {
  const remote = remoteUrl(bucket, prefix, archive.name);
  const localDir = path.join(downloadDir, archive.rangeFolder);
  const localPath = path.join(localDir, archive.name);
  const tmpPath = `${localPath}.tmp`;

  if (await localZipComplete(localPath)) {
    console.log(`SKIP local exists: ${archive.rangeFolder}/${archive.name}`);
    return "skipped";
  }

  if (dryRun) {
    console.log(`DRY RUN download: ${remote} -> ${localPath}`);
    return "dry-run";
  }

  if (!(await remoteExists(remote, archive.name))) {
    console.log(`MISSING remote: ${remote}`);
    return "missing";
  }

  await fsp.mkdir(localDir, { recursive: true });
  await fsp.rm(tmpPath, { force: true }).catch(() => {});
  console.log(`DOWNLOAD: ${remote} -> ${localPath}`);
  await runUplink(["cp", remote, tmpPath]);
  if (!(await localZipComplete(tmpPath))) {
    throw new Error(`Downloaded file is missing or empty: ${tmpPath}`);
  }
  await fsp.rename(tmpPath, localPath);
  return "downloaded";
}

async function main() {
  loadDotEnvIfPresent();
  const opts = parseArgs(process.argv);
  if (!opts.bucket) throw new Error("STORJ_BUCKET is required, or pass --bucket=name");

  const plan = await loadArchivePlan(opts.configPath);
  console.log(`Config: ${opts.configPath}`);
  console.log(`Source config: ${plan.sourceConfigPath}`);
  console.log(`Download directory: ${opts.downloadDir}`);
  console.log(`Storj source: sj://${opts.bucket}/${normalizePrefix(opts.prefix)}`);
  console.log(`Ranges: ${plan.ranges.length}`);
  console.log(`Archive files planned: ${plan.archives.length}`);

  if (!opts.dryRun && plan.archives.length > 0) {
    const credentials = parseStorjCredentials({
      access: opts.access,
      passphrase: opts.passphrase,
    });
    await ensureAccessConfigured(credentials);
  }

  let downloaded = 0;
  let skipped = 0;
  let missing = 0;
  for (const archive of plan.archives) {
    const result = await downloadArchive({ archive, ...opts });
    if (result === "downloaded") downloaded++;
    else if (result === "skipped") skipped++;
    else if (result === "missing") missing++;
  }

  console.log(`Done. downloaded=${downloaded} skipped=${skipped} missing=${missing}`);
  if (missing > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
