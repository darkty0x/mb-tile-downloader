#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

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
const DEFAULT_DOWNLOAD_DIR = path.join(__dirname, "download");
const DEFAULT_SOURCE_CONFIG = path.join(__dirname, "configs", "esri-satellite.config.json");
const DEFAULT_FILE_NAME_TEMPLATE = "tiles_{layer}_{z}_{xStart}-{xEnd}_y{yStart}-{yEnd}.zip";
const SHARE_FETCH_ATTEMPTS = 4;
const SHARE_FETCH_TIMEOUT_MS = 120_000;

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
      `Usage: node ${cmd} <shareUrl> [--download-dir=path] [--dry-run]`,
      `       node ${cmd} <configPath> [shareUrl] [--share-url=url] [--download-dir=path] [--bucket=name] [--prefix=path] [--access=grant] [--dry-run]`,
      "",
      "Default layout:",
      "  local files: <repo>/download/range-000001/<zip-file>",
      "",
      "Environment:",
      "  STORJ_BUCKET          required unless --bucket is provided",
      "  --prefix              optional remote folder override; default is config jobName",
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
    shareUrl: null,
    dryRun: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") printUsage(0);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--download-dir=")) opts.downloadDir = arg.slice("--download-dir=".length);
    else if (arg.startsWith("--bucket=")) opts.bucket = arg.slice("--bucket=".length);
    else if (arg.startsWith("--prefix=")) opts.prefix = arg.slice("--prefix=".length);
    else if (arg.startsWith("--access=")) opts.access = arg.slice("--access=".length);
    else if (arg.startsWith("--share-url=")) opts.shareUrl = arg.slice("--share-url=".length);
    else if (!arg.startsWith("-") && !opts.configPath && /^https:\/\/link\.storjshare\.io\//i.test(arg)) opts.shareUrl = arg;
    else if (!arg.startsWith("-") && !opts.configPath) opts.configPath = arg;
    else if (!arg.startsWith("-") && !opts.shareUrl) opts.shareUrl = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.configPath && !opts.shareUrl) throw new Error("shareUrl or configPath is required");
  if (opts.configPath) opts.configPath = path.resolve(opts.configPath);
  opts.downloadDir = path.resolve(opts.downloadDir);
  opts.bucket = opts.bucket || process.env.STORJ_BUCKET;
  opts.prefix = opts.prefix ?? null;
  opts.access = opts.access || process.env.STORJ_ACCESS || process.env.STORJ_ACCESS_GRANT;
  opts.passphrase = process.env.STORJ_PASSPHRASE || process.env.STORJ_ENCRYPTION_PASSPHRASE;
  return opts;
}

function parseShareUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid share URL: ${value}`);
  }
  if (url.hostname !== "link.storjshare.io") {
    throw new Error(`Share URL must use link.storjshare.io: ${value}`);
  }
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const mode = parts.shift();
  if (mode !== "s" && mode !== "raw") {
    throw new Error(`Share URL path must start with /s/ or /raw/: ${value}`);
  }
  const token = parts.shift();
  const bucket = parts.shift();
  if (!token || !bucket) throw new Error(`Share URL must include token and bucket: ${value}`);
  return {
    token,
    bucket,
    prefix: parts.join("/").replace(/^\/+|\/+$/g, ""),
  };
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

function shareRawUrl(share, relativeName) {
  const pathParts = [share.bucket, share.prefix, relativeName]
    .filter(Boolean)
    .join("/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://link.storjshare.io/raw/${share.token}/${pathParts}`;
}

function shareBrowseUrl(share) {
  const pathParts = [share.bucket, share.prefix]
    .filter(Boolean)
    .join("/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://link.storjshare.io/s/${share.token}/${pathParts}${pathParts ? "/" : ""}`;
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
    { input: `${credentials.passphrase}\n` }
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
      : [sourceConfig.provider === "mapbox" ? "vector" : "esri-satellite"];
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

  return { sourceConfigPath, jobName: sourceConfig.jobName || rawConfig.jobName || path.basename(configPath, ".json"), layers, ranges, archives };
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function zipNameFromHref(href) {
  const clean = decodeHtml(href).split(/[?#]/)[0];
  const parts = clean.split("/").filter(Boolean);
  const last = parts.at(-1);
  return last && last.toLowerCase().endsWith(".zip") ? decodeURIComponent(last) : null;
}

function parseSharedZipNames(html) {
  const names = new Set();
  const hrefPattern = /\bhref=["']([^"']+\.zip(?:[?#][^"']*)?)["']/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const name = zipNameFromHref(match[1]);
    if (name) names.add(name);
  }

  const textPattern = /([\w.-]+\.zip)/gi;
  for (const match of html.matchAll(textPattern)) {
    names.add(decodeHtml(match[1]));
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

function isRetryableShareFailure(err) {
  if (err?.name === "AbortError") return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|network/i.test(String(err?.message || err));
}

function isRetryableShareStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchShare(url, { attempts = SHARE_FETCH_ATTEMPTS, timeoutMs = SHARE_FETCH_TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!isRetryableShareStatus(response.status) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`Share request failed ${response.status} ${response.statusText}: ${url}`);
    } catch (err) {
      clearTimeout(timeout);
      if (!isRetryableShareFailure(err) || attempt === attempts) throw err;
      lastError = err;
    }
    await wait(Math.min(1000 * 2 ** (attempt - 1), 10_000));
  }
  throw lastError || new Error(`Share request failed: ${url}`);
}

async function listShareArchives(share) {
  const url = shareBrowseUrl(share);
  let html = process.env.STORJ_SHARE_LIST_HTML;
  if (!html) {
    const response = await fetchShare(url);
    if (!response.ok) {
      throw new Error(`Share listing failed ${response.status} ${response.statusText}: ${url}`);
    }
    html = await response.text();
  }
  const names = parseSharedZipNames(html);
  if (names.length === 0) {
    throw new Error(`No ZIP files found in share listing: ${url}`);
  }
  const folder = safeFolderName(share.prefix.split("/").filter(Boolean).at(-1) || share.bucket);
  return names.map((name) => ({
    name,
    rangeFolder: folder,
  }));
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

async function downloadArchiveFromShare({ archive, share, downloadDir, dryRun }) {
  const url = shareRawUrl(share, archive.name);
  const localDir = path.join(downloadDir, archive.rangeFolder);
  const localPath = path.join(localDir, archive.name);
  const tmpPath = `${localPath}.tmp`;

  if (await localZipComplete(localPath)) {
    console.log(`SKIP local exists: ${archive.rangeFolder}/${archive.name}`);
    return "skipped";
  }

  if (dryRun) {
    console.log(`DRY RUN download: ${url} -> ${localPath}`);
    return "dry-run";
  }

  await fsp.mkdir(localDir, { recursive: true });
  console.log(`DOWNLOAD: ${url} -> ${localPath}`);
  let lastMissing = false;
  for (let attempt = 1; attempt <= SHARE_FETCH_ATTEMPTS; attempt++) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    const response = await fetchShare(url);
    if (response.status === 404) {
      lastMissing = true;
      break;
    }
    if (!response.ok || !response.body) {
      const err = new Error(`Share download failed ${response.status} ${response.statusText}: ${url}`);
      if (!isRetryableShareStatus(response.status) || attempt === SHARE_FETCH_ATTEMPTS) throw err;
      await wait(Math.min(1000 * 2 ** (attempt - 1), 10_000));
      continue;
    }
    try {
      await pipeline(response.body, fs.createWriteStream(tmpPath));
      if (!(await localZipComplete(tmpPath))) {
        throw new Error(`Downloaded file is missing or empty: ${tmpPath}`);
      }
      await fsp.rename(tmpPath, localPath);
      return "downloaded";
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (!isRetryableShareFailure(err) || attempt === SHARE_FETCH_ATTEMPTS) throw err;
      await wait(Math.min(1000 * 2 ** (attempt - 1), 10_000));
    }
  }
  if (lastMissing) {
    console.log(`MISSING remote: ${url}`);
    return "missing";
  }
  throw new Error(`Share download failed after retries: ${url}`);
}

async function main() {
  loadDotEnvIfPresent();
  const opts = parseArgs(process.argv);
  const share = parseShareUrl(opts.shareUrl);
  let plan;
  if (opts.configPath) {
    plan = await loadArchivePlan(opts.configPath);
  } else if (share) {
    plan = {
      sourceConfigPath: null,
      jobName: share.prefix || share.bucket,
      layers: [],
      ranges: [],
      archives: await listShareArchives(share),
    };
  } else {
    throw new Error("shareUrl or configPath is required");
  }

  const prefix = opts.prefix || share?.prefix || plan.jobName;
  const bucket = opts.bucket || share?.bucket || process.env.STORJ_BUCKET;
  if (!bucket) throw new Error("STORJ_BUCKET is required, pass --bucket=name, or pass a share URL");
  if (opts.configPath) {
    console.log(`Config: ${opts.configPath}`);
    console.log(`Source config: ${plan.sourceConfigPath}`);
  }
  console.log(`Download directory: ${opts.downloadDir}`);
  if (share) {
    console.log(`Share source: https://link.storjshare.io/s/${share.token}/${share.bucket}/${normalizePrefix(share.prefix)}`);
  } else {
    console.log(`Storj source: sj://${bucket}/${normalizePrefix(prefix)}`);
  }
  if (opts.configPath) console.log(`Ranges: ${plan.ranges.length}`);
  console.log(`Archive files planned: ${plan.archives.length}`);

  if (!share && !opts.dryRun && plan.archives.length > 0) {
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
    const result = share
      ? await downloadArchiveFromShare({ archive, share, downloadDir: opts.downloadDir, dryRun: opts.dryRun })
      : await downloadArchive({ archive, ...opts, bucket, prefix });
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
