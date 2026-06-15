#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

import { loadConfig } from "./src/config/config-loader.js";
import { TileStateDb } from "./src/state/state-db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG_PATH = path.join(__dirname, "configs", "archive.config.json");
const DEFAULT_SOURCE_CONFIG = path.join(__dirname, "configs", "esri-satellite.config.json");
const DEFAULT_STATE_FILE = path.join(__dirname, "archive-resume.json");
const ZIP_STORE = 0;
const ZIP_VERSION = 20;
const ZIP64_VERSION = 45;
const ZIP_FLAG_UTF8 = 0x0800;
const DEFAULT_ZIP_WRITE_BUFFER_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_SIZE_BYTES = 20 * 1024 * 1024 * 1024;
const ZIP_ARCHIVE_FOOTER_BYTES = 1024 * 128;

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
  const cmd = path.basename(process.argv[1] || "zip-maker.js");
  console.log(
    [
      "",
      "Create one fast ZIP archive for each complete tile range.",
      "",
      `Usage: node ${cmd} [downloadConfigPath] [--dry-run] [--delete-after-archive] [--keep] [--layer=satellite|esri-satellite|vector] [--archive-dir=path] [--tiles-dir=path] [--max-archive-size=<bytes|KB|MB|GB>]`,
      "",
      "Default layout:",
      "  source tiles: <outputDir>/<layer>/<z>/<x>/<y>.<ext>",
      "  archives:     <archiveDir>/tiles_<layer>_<z>_<xStart>-<xEnd>.zip",
      "",
      "The script is resumable at range level. It skips finished archives,",
      "restarts partial .tmp archives, and keeps source tiles by default.",
      "Use --delete-after-archive only when source deletion is intended.",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function writeU16(buf, value, offset) {
  buf.writeUInt16LE(value & 0xffff, offset);
}

function writeU32(buf, value, offset) {
  buf.writeUInt32LE(value >>> 0, offset);
}

function writeU64(buf, value, offset) {
  const big = BigInt(value);
  buf.writeBigUInt64LE(big, offset);
}

function normalizeSlashes(value) {
  return value.split(path.sep).join("/");
}

function padX(value, width) {
  return String(value).padStart(width, "0");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArchiveSizeBytes(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return fallback;
    return value;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (!Number.isInteger(asNumber) || !Number.isFinite(asNumber) || asNumber <= 0) return fallback;
    return asNumber;
  }

  const raw = String(value).trim();
  if (!raw) return fallback;
  const parsed = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kib|kb|k|mib|mb|m|gib|gb|g|tib|tb|t)?$/i);
  if (!parsed) return fallback;

  const number = Number(parsed[1]);
  if (!Number.isFinite(number) || number <= 0) return fallback;

  const unit = String(parsed[2] || "b").toLowerCase();
  const unitMap = {
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };

  const factor = unitMap[unit];
  const bytes = number * factor;
  if (!Number.isFinite(bytes)) return fallback;
  return Math.floor(bytes);
}

function formatArchiveSize(bytes) {
  const gib = 1024 ** 3;
  const exact = bytes / gib;
  const rounded = Number.isInteger(exact) ? String(exact) : exact.toFixed(1);
  return `${rounded} GiB`;
}

function estimateZipEntryBytes(fileSize, zipName) {
  const nameBytes = Buffer.byteLength(zipName, "utf8");
  // Local header + ZIP64 extra + file data + central entry + ZIP64 extra + file name bytes repeated in both headers.
  return Number(fileSize) + 124 + nameBytes * 2;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    configPath: null,
    dryRun: false,
    keep: false,
    deleteAfterArchive: false,
    layer: null,
    archiveDir: null,
    tilesDir: null,
    onlyComplete: true,
    maxArchiveSize: null,
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") printUsage(0);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--delete-after-archive") opts.deleteAfterArchive = true;
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--include-incomplete") opts.onlyComplete = false;
    else if (arg.startsWith("--layer=")) opts.layer = arg.slice("--layer=".length);
    else if (arg.startsWith("--archive-dir=")) opts.archiveDir = arg.slice("--archive-dir=".length);
    else if (arg.startsWith("--tiles-dir=")) opts.tilesDir = arg.slice("--tiles-dir=".length);
    else if (arg.startsWith("--max-archive-size="))
      opts.maxArchiveSize = arg.slice("--max-archive-size=".length);
    else if (!arg.startsWith("-") && !opts.configPath) opts.configPath = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  opts.configPath = path.resolve(opts.configPath || DEFAULT_CONFIG_PATH);
  return opts;
}

function isDownloaderConfig(config) {
  return Boolean(
    config &&
      typeof config === "object" &&
      config.provider &&
      config.output &&
      Array.isArray(config.ranges)
  );
}

async function loadJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function resolvePath(value, baseDir, fallback) {
  const rawValue = typeof value === "string" ? value.trim() : value;
  const raw = typeof (rawValue || fallback) === "string"
    ? (rawValue || fallback).normalize("NFC")
    : rawValue || fallback;
  if (typeof raw === "string" && /^smb:\/\//i.test(raw)) {
    return resolveSmbPath(raw);
  }
  if (typeof raw === "string" && /^smb:[/\\]/i.test(raw)) {
    throw new Error(
      `Invalid SMB path "${raw}". Use smb://host/share/folder or a Windows UNC path like \\\\host\\share\\folder.`
    );
  }
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(baseDir, raw);
}

function selectPlatformPath(config, baseKey) {
  if (process.platform === "win32" && config[`${baseKey}Windows`]) {
    return config[`${baseKey}Windows`];
  }
  if (process.platform === "darwin" && config[`${baseKey}Mac`]) {
    return config[`${baseKey}Mac`];
  }
  return config[baseKey];
}

function resolveSmbPath(smbUrl) {
  let url;
  try {
    url = new URL(smbUrl);
  } catch {
    throw new Error(`Invalid SMB URL: ${smbUrl}`);
  }

  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part).normalize("NFC"));
  const share = parts.shift()?.normalize("NFC");
  if (!url.hostname || !share) {
    throw new Error(`SMB URL must include host and share: ${smbUrl}`);
  }

  if (process.platform === "win32") {
    return `\\\\${url.hostname}\\${[share, ...parts].join("\\")}`;
  }

  if (process.platform === "darwin") {
    return path.join("/Volumes", share, ...parts);
  }

  return path.join("/mnt", url.hostname, share, ...parts);
}

function validateRange(range) {
  for (const key of ["zoomStart", "zoomEnd", "xStart", "xEnd", "yStart", "yEnd"]) {
    if (!Number.isInteger(range[key])) {
      throw new Error(`Range ${key} must be an integer: ${range[key]}`);
    }
  }
  if (range.zoomEnd < range.zoomStart) throw new Error(`Range zoomEnd < zoomStart`);
  if (range.xEnd < range.xStart) throw new Error(`Range xEnd < xStart`);
  if (range.yEnd < range.yStart) throw new Error(`Range yEnd < yStart`);
}

function normalizeRanges(config) {
  const { ranges, zoomStart, zoomEnd, xStart, xEnd, yStart, yEnd } = config || {};

  if (Array.isArray(ranges) && ranges.length > 0) {
    return ranges.map((r, idx) => {
      const zStart = r.zoom ?? r.z ?? r.zoomStart;
      const zEnd = r.zoom ?? r.z ?? r.zoomEnd ?? zStart;
      const range = {
        zoomStart: zStart,
        zoomEnd: zEnd,
        xStart: r.xStart,
        xEnd: r.xEnd,
        yStart: r.yStart,
        yEnd: r.yEnd,
        label:
          r.label ||
          `range#${idx + 1}: z=${zStart}${zEnd !== zStart ? `-${zEnd}` : ""} x=${r.xStart}-${r.xEnd} y=${r.yStart}-${r.yEnd}`,
      };
      validateRange(range);
      return range;
    });
  }

  if (zoomStart !== undefined && xStart !== undefined) {
    const range = {
      zoomStart,
      zoomEnd: zoomEnd ?? zoomStart,
      xStart,
      xEnd,
      yStart,
      yEnd,
      label: "legacy-range",
    };
    validateRange(range);
    return [range];
  }

  return [];
}

function layerDefaults(layer, config = {}) {
  if (layer === "vector") {
    return {
      extension: String(
        config.tile?.extension || config.url?.extension || config.vectorExtension || "vector.pbf"
      ).toLowerCase(),
      root: config.layer || "vector",
    };
  }

  if (layer === "satellite" || layer === "esri-satellite") {
    return {
      extension: String(
        config.tile?.extension || config.url?.extension || config.tileExtension || config.satelliteExtension || "jpg"
      ).toLowerCase(),
      root: config.layer || layer,
    };
  }

  throw new Error(`Unsupported layer: ${layer}`);
}

function archiveFileName(template, { layer, z, xStart, xEnd, yStart, yEnd, xPadWidth }) {
  const paddedStart = padX(xStart, xPadWidth);
  const paddedEnd = padX(xEnd, xPadWidth);
  const paddedYStart = padX(yStart, xPadWidth);
  const paddedYEnd = padX(yEnd, xPadWidth);
  return template
    .replaceAll("{layer}", layer)
    .replaceAll("{z}", String(z))
    .replaceAll("{xStart}", paddedStart)
    .replaceAll("{xEnd}", paddedEnd)
    .replaceAll("{xStartRaw}", String(xStart))
    .replaceAll("{xEndRaw}", String(xEnd))
    .replaceAll("{yStart}", paddedYStart)
    .replaceAll("{yEnd}", paddedYEnd)
    .replaceAll("{yStartRaw}", String(yStart))
    .replaceAll("{yEndRaw}", String(yEnd));
}

function taskSignature(task) {
  return [
    task.outputDir,
    task.layer,
    task.z,
    task.xStart,
    task.xEnd,
    task.yStart,
    task.yEnd,
    task.extension,
  ].join("|");
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getArchiveFileInfo(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return {
      exists: true,
      isFile: stat.isFile(),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { exists: false, isFile: false, size: 0, mtime: null };
    }
    throw err;
  }
}

function assertUsableArchive(info, archivePath) {
  if (!info.exists) {
    throw new Error(`Archive file does not exist after write: ${archivePath}`);
  }
  if (!info.isFile) {
    throw new Error(`Archive path exists but is not a file: ${archivePath}`);
  }
  if (info.size <= 0) {
    throw new Error(`Archive file is empty; refusing to delete source: ${archivePath}`);
  }
}

async function isRangeComplete(
  { outputDir, layer, z, xStart, xEnd, yStart, yEnd, extension },
  { progressLabel = null, progressEveryRows = 100, progressEveryMs = 3000 } = {}
) {
  let files = 0;
  let missing = 0;
  let firstMissing = null;
  const expectedPerRow = yEnd - yStart + 1;
  const suffix = `.${extension}`;
  const totalRows = xEnd - xStart + 1;
  let checkedRows = 0;
  let lastProgressAt = 0;

  const emitProgress = (force = false) => {
    if (!progressLabel) return;
    const now = Date.now();
    if (
      !force &&
      checkedRows !== totalRows &&
      checkedRows % progressEveryRows !== 0 &&
      now - lastProgressAt < progressEveryMs
    ) {
      return;
    }
    lastProgressAt = now;
    console.log(
      `  ${progressLabel}: checked ${checkedRows}/${totalRows} rows files=${files} missing=${missing}`
    );
  };

  for (let x = xStart; x <= xEnd; x++) {
    const rowDir = path.join(outputDir, layer, String(z), String(x));
    let names;
    try {
      names = await fsp.readdir(rowDir);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      missing += expectedPerRow;
      if (!firstMissing) firstMissing = path.join(rowDir, `${yStart}.${extension}`);
      checkedRows++;
      emitProgress();
      continue;
    }

    const present = new Set();
    for (const name of names) {
      if (!name.endsWith(suffix)) continue;
      const rawY = name.slice(0, -suffix.length);
      if (!/^\d+$/.test(rawY)) continue;
      const y = Number(rawY);
      if (y >= yStart && y <= yEnd) present.add(y);
    }

    files += present.size;
    if (present.size !== expectedPerRow) {
      for (let y = yStart; y <= yEnd; y++) {
        if (present.has(y)) continue;
        missing++;
        if (!firstMissing) firstMissing = path.join(rowDir, `${y}.${extension}`);
      }
    }
    checkedRows++;
    emitProgress();
  }

  return { complete: missing === 0, files, missing, firstMissing };
}

async function splitTaskByArchiveSize(
  task,
  maxArchiveSizeBytes,
  { progressLabel = null, progressEveryFiles = 10000, progressEveryMs = 3000 } = {}
) {
  if (!maxArchiveSizeBytes || maxArchiveSizeBytes <= 0) return [{ ...task }];

  const segments = [];
  let current = null;
  let currentBytes = ZIP_ARCHIVE_FOOTER_BYTES;
  let checked = 0;
  let existing = 0;
  let lastProgressAt = 0;
  const total = expectedFileCount(task);

  const emitProgress = (force = false) => {
    if (!progressLabel) return;
    const now = Date.now();
    if (
      !force &&
      checked !== total &&
      checked % progressEveryFiles !== 0 &&
      now - lastProgressAt < progressEveryMs
    ) {
      return;
    }
    lastProgressAt = now;
    console.log(
      `  ${progressLabel}: sized ${checked}/${total} files existing=${existing} parts=${
        segments.length + (current ? 1 : 0)
      }`
    );
  };

  const pushCurrent = () => {
    if (!current) return;
    segments.push(current);
    current = null;
    currentBytes = ZIP_ARCHIVE_FOOTER_BYTES;
  };

  const estimateEntry = async (x, y) => {
    const filePath = path.join(task.outputDir, task.layer, String(task.z), String(x), `${y}.${task.extension}`);
    let size;
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) {
        checked++;
        emitProgress();
        return null;
      }
      size = st.size;
    } catch (err) {
      if (err.code === "ENOENT") {
        checked++;
        emitProgress();
        return null;
      }
      throw err;
    }

    checked++;
    existing++;
    emitProgress();
    const zipName = `${task.layer}/${task.z}/${x}/${y}.${task.extension}`;
    return { x, y, bytes: estimateZipEntryBytes(size, zipName) };
  };

  const splitSingleRow = (entries) => {
    let rowSegment = null;
    let rowBytes = ZIP_ARCHIVE_FOOTER_BYTES;

    for (const entry of entries) {
      const projected = rowBytes + entry.bytes;
      if (rowSegment && (entry.y !== rowSegment.yEnd + 1 || projected > maxArchiveSizeBytes)) {
        segments.push(rowSegment);
        rowSegment = null;
        rowBytes = ZIP_ARCHIVE_FOOTER_BYTES;
      }

      if (!rowSegment) {
        rowSegment = {
          outputDir: task.outputDir,
          layer: task.layer,
          z: task.z,
          xStart: entry.x,
          xEnd: entry.x,
          yStart: entry.y,
          yEnd: entry.y,
          extension: task.extension,
        };
        rowBytes = ZIP_ARCHIVE_FOOTER_BYTES + entry.bytes;
        continue;
      }

      rowSegment.yEnd = entry.y;
      rowBytes = projected;
    }

    if (rowSegment) segments.push(rowSegment);
  };

  for (let x = task.xStart; x <= task.xEnd; x++) {
    const rowEntries = [];
    let rowBytes = 0;

    for (let y = task.yStart; y <= task.yEnd; y++) {
      const entry = await estimateEntry(x, y);
      if (!entry) continue;
      rowEntries.push(entry);
      rowBytes += entry.bytes;
    }

    if (rowEntries.length === 0) continue;

    const rowIsComplete =
      rowEntries.length === task.yEnd - task.yStart + 1 &&
      rowEntries[0].y === task.yStart &&
      rowEntries[rowEntries.length - 1].y === task.yEnd;

    if (!rowIsComplete || ZIP_ARCHIVE_FOOTER_BYTES + rowBytes > maxArchiveSizeBytes) {
      pushCurrent();
      splitSingleRow(rowEntries);
      continue;
    }

    const projected = currentBytes + rowBytes;
    if (current && projected > maxArchiveSizeBytes) pushCurrent();

    if (!current) {
      current = {
        outputDir: task.outputDir,
        layer: task.layer,
        z: task.z,
        xStart: x,
        xEnd: x,
        yStart: task.yStart,
        yEnd: task.yEnd,
        extension: task.extension,
      };
      currentBytes = ZIP_ARCHIVE_FOOTER_BYTES + rowBytes;
      continue;
    }

    current.xEnd = x;
    currentBytes += rowBytes;
  }

  pushCurrent();
  emitProgress(true);
  if (segments.length > 0) return segments;
  return [{ ...task }];
}

function makeArchiveName(baseName, partIndex, totalParts) {
  if (!totalParts || totalParts <= 1) return baseName;
  const extension = path.extname(baseName);
  if (extension) {
    return `${baseName.slice(0, -extension.length)}.part-${String(partIndex).padStart(
      3,
      "0"
    )}${extension}`;
  }
  return `${baseName}.part-${String(partIndex).padStart(3, "0")}`;
}

async function listRangeFiles({ outputDir, layer, z, xStart, xEnd, yStart, yEnd, extension }) {
  const files = [];
  for (let x = xStart; x <= xEnd; x++) {
    const rowDir = path.join(outputDir, layer, String(z), String(x));
    for (let y = yStart; y <= yEnd; y++) {
      const filePath = path.join(rowDir, `${y}.${extension}`);
      files.push({
        filePath,
        zipName: `${layer}/${z}/${x}/${y}.${extension}`,
      });
    }
  }
  return files;
}

async function* iterateRangeFiles({ outputDir, layer, z, xStart, xEnd, yStart, yEnd, extension }) {
  for (let x = xStart; x <= xEnd; x++) {
    const rowDir = path.join(outputDir, layer, String(z), String(x));
    for (let y = yStart; y <= yEnd; y++) {
      yield {
        filePath: path.join(rowDir, `${y}.${extension}`),
        zipName: `${layer}/${z}/${x}/${y}.${extension}`,
      };
    }
  }
}

function expectedFileCount({ xStart, xEnd, yStart, yEnd }) {
  return (xEnd - xStart + 1) * (yEnd - yStart + 1);
}

class ZipStoreWriter {
  constructor(zipPath, { readMode = "direct", writeBufferBytes = DEFAULT_ZIP_WRITE_BUFFER_BYTES } = {}) {
    this.zipPath = zipPath;
    this.centralPath = `${zipPath}.central`;
    this.readMode = readMode;
    this.writeBufferBytes = writeBufferBytes;
    this.handle = null;
    this.centralHandle = null;
    this.offset = 0;
    this.centralSize = 0;
    this.entryCount = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.centralPending = [];
    this.centralPendingBytes = 0;
  }

  async open() {
    this.handle = await fsp.open(this.zipPath, "w");
    this.centralHandle = await fsp.open(this.centralPath, "w");
  }

  async write(buf, { forceFlush = false } = {}) {
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    this.offset += buf.length;
    if (forceFlush || this.pendingBytes >= this.writeBufferBytes) {
      await this.flush();
    }
  }

  async flush() {
    if (this.pendingBytes === 0) return;
    const chunk = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    await this.handle.write(chunk);
  }

  async writeCentral(buf, { forceFlush = false } = {}) {
    this.centralPending.push(buf);
    this.centralPendingBytes += buf.length;
    this.centralSize += buf.length;
    if (forceFlush || this.centralPendingBytes >= this.writeBufferBytes) {
      await this.flushCentral();
    }
  }

  async flushCentral() {
    if (this.centralPendingBytes === 0) return;
    const chunk =
      this.centralPending.length === 1
        ? this.centralPending[0]
        : Buffer.concat(this.centralPending, this.centralPendingBytes);
    this.centralPending = [];
    this.centralPendingBytes = 0;
    await this.centralHandle.write(chunk);
  }

  async readFilePayload(filePath) {
    if (this.readMode === "stream") {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
      return { stat, buffer: null };
    }
    const buffer = await fsp.readFile(filePath);
    return {
      stat: {
        isFile: () => true,
        size: buffer.length,
        mtime: new Date(0),
      },
      buffer,
    };
  }

  async addFile(filePath, zipName) {
    const payload = await this.readFilePayload(filePath);
    const { stat, buffer } = payload;
    const directCrc = buffer ? crc32(buffer) >>> 0 : 0;

    const nameBuf = Buffer.from(normalizeSlashes(zipName), "utf8");
    const zip64SizeExtra = Buffer.alloc(4 + 16);
    writeU16(zip64SizeExtra, 0x0001, 0);
    writeU16(zip64SizeExtra, 16, 2);
    writeU64(zip64SizeExtra, stat.size, 4);
    writeU64(zip64SizeExtra, stat.size, 12);
    const { dosTime, dosDate } = dosDateTime(stat.mtime);
    const localOffset = this.offset;
    const local = Buffer.alloc(30 + nameBuf.length + zip64SizeExtra.length);
    writeU32(local, 0x04034b50, 0);
    writeU16(local, ZIP64_VERSION, 4);
    writeU16(local, ZIP_FLAG_UTF8, 6);
    writeU16(local, ZIP_STORE, 8);
    writeU16(local, dosTime, 10);
    writeU16(local, dosDate, 12);
    writeU32(local, directCrc, 14);
    writeU32(local, 0xffffffff, 18);
    writeU32(local, 0xffffffff, 22);
    writeU16(local, nameBuf.length, 26);
    writeU16(local, zip64SizeExtra.length, 28);
    nameBuf.copy(local, 30);
    zip64SizeExtra.copy(local, 30 + nameBuf.length);
    await this.write(local);

    let crc = directCrc;
    if (buffer) {
      await this.write(buffer);
    } else {
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      for await (const chunk of stream) {
        crc = crc32(chunk, crc) >>> 0;
        await this.write(chunk);
      }
    }

    const afterFileOffset = this.offset;
    if (!buffer) {
      await this.flush();
      const patch = Buffer.alloc(4);
      writeU32(patch, crc, 0);
      await this.handle.write(patch, 0, patch.length, localOffset + 14);
      this.offset = afterFileOffset;
    }

    const zip64CentralExtra = Buffer.alloc(4 + 24);
    writeU16(zip64CentralExtra, 0x0001, 0);
    writeU16(zip64CentralExtra, 24, 2);
    writeU64(zip64CentralExtra, stat.size, 4);
    writeU64(zip64CentralExtra, stat.size, 12);
    writeU64(zip64CentralExtra, localOffset, 20);
    const record = Buffer.alloc(46 + nameBuf.length + zip64CentralExtra.length);
    writeU32(record, 0x02014b50, 0);
    writeU16(record, ZIP64_VERSION, 4);
    writeU16(record, ZIP64_VERSION, 6);
    writeU16(record, ZIP_FLAG_UTF8, 8);
    writeU16(record, ZIP_STORE, 10);
    writeU16(record, dosTime, 12);
    writeU16(record, dosDate, 14);
    writeU32(record, crc, 16);
    writeU32(record, 0xffffffff, 20);
    writeU32(record, 0xffffffff, 24);
    writeU16(record, nameBuf.length, 28);
    writeU16(record, zip64CentralExtra.length, 30);
    writeU16(record, 0, 32);
    writeU16(record, 0, 34);
    writeU16(record, 0, 36);
    writeU32(record, 0, 38);
    writeU32(record, 0xffffffff, 42);
    nameBuf.copy(record, 46);
    zip64CentralExtra.copy(record, 46 + nameBuf.length);
    await this.writeCentral(record);
    this.entryCount++;
  }

  async close() {
    const centralStart = this.offset;
    await this.flushCentral();
    await this.centralHandle.close();
    this.centralHandle = null;

    const centralStream = fs.createReadStream(this.centralPath, {
      highWaterMark: 1024 * 1024,
    });
    for await (const chunk of centralStream) {
      await this.write(chunk);
    }

    const zip64EndOffset = this.offset;
    const zip64End = Buffer.alloc(56);
    writeU32(zip64End, 0x06064b50, 0);
    writeU64(zip64End, 44, 4);
    writeU16(zip64End, ZIP64_VERSION, 12);
    writeU16(zip64End, ZIP64_VERSION, 14);
    writeU32(zip64End, 0, 16);
    writeU32(zip64End, 0, 20);
    writeU64(zip64End, this.entryCount, 24);
    writeU64(zip64End, this.entryCount, 32);
    writeU64(zip64End, this.centralSize, 40);
    writeU64(zip64End, centralStart, 48);
    await this.write(zip64End);

    const locator = Buffer.alloc(20);
    writeU32(locator, 0x07064b50, 0);
    writeU32(locator, 0, 4);
    writeU64(locator, zip64EndOffset, 8);
    writeU32(locator, 1, 16);
    await this.write(locator);

    const end = Buffer.alloc(22);
    writeU32(end, 0x06054b50, 0);
    writeU16(end, 0, 4);
    writeU16(end, 0, 6);
    writeU16(end, Math.min(this.entryCount, 0xffff), 8);
    writeU16(end, Math.min(this.entryCount, 0xffff), 10);
    writeU32(end, Math.min(this.centralSize, 0xffffffff), 12);
    writeU32(end, Math.min(centralStart, 0xffffffff), 16);
    writeU16(end, 0, 20);
    await this.write(end);
    await this.flush();
    await this.handle.close();
    this.handle = null;
    await fsp.rm(this.centralPath, { force: true });
  }

  async abort() {
    this.pending = [];
    this.pendingBytes = 0;
    this.centralPending = [];
    this.centralPendingBytes = 0;
    if (this.handle) {
      await this.handle.close().catch(() => {});
      this.handle = null;
    }
    if (this.centralHandle) {
      await this.centralHandle.close().catch(() => {});
      this.centralHandle = null;
    }
    await fsp.rm(this.centralPath, { force: true }).catch(() => {});
  }
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function removeEmptyDir(dir) {
  try {
    await fsp.rmdir(dir);
    return true;
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTEMPTY" || err.code === "EEXIST") return false;
    throw err;
  }
}

async function removeRangeFiles(
  { outputDir, layer, z, xStart, xEnd, yStart, yEnd, extension },
  deleteConcurrency = 16
) {
  const total = expectedFileCount({ xStart, xEnd, yStart, yEnd });
  let nextX = xStart;
  let nextY = yStart;

  const nextFile = () => {
    if (nextX > xEnd) return null;
    const file = path.join(outputDir, layer, String(z), String(nextX), `${nextY}.${extension}`);
    nextY++;
    if (nextY > yEnd) {
      nextY = yStart;
      nextX++;
    }
    return file;
  };

  let removed = 0;
  const workers = Array.from({ length: Math.min(deleteConcurrency, total) }, async () => {
    while (true) {
      const file = nextFile();
      if (!file) return;
      await fsp.rm(file, { force: true, maxRetries: 8, retryDelay: 150 });
      removed++;
      if (removed % 1000 === 0 || removed === total) {
        console.log(`  deleted source files ${removed}/${total}`);
      }
    }
  });
  await Promise.all(workers);

  let removedDirs = 0;
  for (let x = xStart; x <= xEnd; x++) {
    const xDir = path.join(outputDir, layer, String(z), String(x));
    if (await removeEmptyDir(xDir)) removedDirs++;
  }
  const zDir = path.join(outputDir, layer, String(z));
  await removeEmptyDir(zDir);
  await removeEmptyDir(path.join(outputDir, layer));
  if (removedDirs > 0) {
    console.log(`  removed empty source dirs ${removedDirs}/${xEnd - xStart + 1}`);
  }
}

async function writeState(stateFile, state) {
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, stateFile);
}

let stateWriteQueue = Promise.resolve();

async function queueWriteState(stateFile, state) {
  const snapshot = JSON.parse(JSON.stringify(state));
  stateWriteQueue = stateWriteQueue.then(() => writeState(stateFile, snapshot));
  return stateWriteQueue;
}

async function writeProgress(progressPath, progress) {
  const tmp = `${progressPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(progress, null, 2));
  await fsp.rename(tmp, progressPath);
}

async function cleanupArchiveRuntimeFiles({ tmpPath, progressPath }) {
  const paths = [
    tmpPath,
    `${tmpPath}.central`,
    progressPath,
    `${progressPath}.tmp`,
  ].filter(Boolean);

  await Promise.all(paths.map((filePath) => fsp.rm(filePath, { force: true }).catch(() => {})));
}

function downloaderStateDbPath(config) {
  return path.resolve(
    path.join(config.configDir, "..", ".tile-state", `${config.jobName}.sqlite`)
  );
}

async function openDownloaderState(sourceConfigPath) {
  try {
    const config = await loadConfig(sourceConfigPath, { env: process.env });
    const dbPath = downloaderStateDbPath(config);
    return {
      config,
      dbPath,
      db: new TileStateDb(dbPath),
    };
  } catch (err) {
    console.warn(`Downloader state invalidation disabled: ${err.message}`);
    return null;
  }
}

function markArchivedSourceDeleted(downloaderState, item) {
  if (!downloaderState || !item.rangeState) return;
  downloaderState.db.markArchivedTiles({
    jobName: downloaderState.config.jobName,
    configHash: downloaderState.config.configHash,
    layer: downloaderState.config.layer,
    ...item.rangeState,
  });
  console.log(
    `  ${item.name}: downloader SQLite marked archived/deleted in ${downloaderState.dbPath}`
  );
}

async function cleanupCompletedRunFiles({ archiveDir, stateFile }) {
  await Promise.all([
    fsp.rm(path.join(archiveDir, "archive-run-manifest.jsonl"), { force: true }).catch(() => {}),
    fsp.rm(stateFile, { force: true }).catch(() => {}),
    fsp.rm(`${stateFile}.tmp`, { force: true }).catch(() => {}),
  ]);

  let names = [];
  try {
    names = await fsp.readdir(archiveDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => /^archive-write-probe-\d+\.json$/.test(name))
      .map((name) => fsp.rm(path.join(archiveDir, name), { force: true }).catch(() => {}))
  );
}

async function appendManifest(archiveDir, event) {
  const manifestPath = path.join(archiveDir, "archive-run-manifest.jsonl");
  await fsp.appendFile(
    manifestPath,
    `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`
  );
}

async function writeArchiveProbe(archiveDir, rawArchiveDir, resolvedArchiveDir) {
  const probePath = path.join(archiveDir, `archive-write-probe-${process.pid}.json`);
  const payload = {
    status: "probe-ok",
    pid: process.pid,
    platform: process.platform,
    cwd: process.cwd(),
    rawArchiveDir,
    resolvedArchiveDir,
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(probePath, JSON.stringify(payload, null, 2));
  const info = await getArchiveFileInfo(probePath);
  assertUsableArchive(info, probePath);
  return { probePath, info };
}

async function archiveRange({
  task,
  archivePath,
  tmpPath,
  progressPath,
  archiveName,
  dryRun,
  deleteAfterArchive,
  deleteConcurrency,
  progressEveryFiles,
  progressEveryMs,
  zipReadMode,
  zipWriteBufferBytes,
  state,
  stateFile,
  archiveDir,
}) {
  await fsp.rm(tmpPath, { force: true });
  await fsp.rm(`${tmpPath}.central`, { force: true });

  const total = expectedFileCount(task);

  if (dryRun) {
    console.log(`  DRY RUN: would zip ${total} files -> ${archivePath}`);
    return;
  }

  state.active ??= {};
  state.active[archiveName] = {
    layer: task.layer,
    z: task.z,
    xStart: task.xStart,
    xEnd: task.xEnd,
    archivePath,
    startedAt: new Date().toISOString(),
  };
  await queueWriteState(stateFile, state);

  const writer = new ZipStoreWriter(tmpPath, {
    readMode: zipReadMode,
    writeBufferBytes: zipWriteBufferBytes,
  });
  let done = 0;
  let lastProgressAt = 0;
  const started = Date.now();

  const emitProgress = async (status, currentFile = null) => {
    const elapsed = Math.max((Date.now() - started) / 1000, 0.001);
    const progress = {
      status,
      archivePath,
      tmpPath,
      layer: task.layer,
      z: task.z,
      xStart: task.xStart,
      xEnd: task.xEnd,
      yStart: task.yStart,
      yEnd: task.yEnd,
      filesDone: done,
      filesTotal: total,
      percent: Number(((done / total) * 100).toFixed(4)),
      bytesWritten: writer.offset,
      filesPerSecond: Math.round(done / elapsed),
      currentFile,
      startedAt: new Date(started).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeProgress(progressPath, progress);
  };

  try {
    await writer.open();
    await emitProgress("archiving");
    for await (const file of iterateRangeFiles(task)) {
      await writer.addFile(file.filePath, file.zipName);
      done++;
      const now = Date.now();
      if (
        done % progressEveryFiles === 0 ||
        now - lastProgressAt >= progressEveryMs ||
        done === total
      ) {
        const elapsed = Math.max((Date.now() - started) / 1000, 0.001);
        console.log(
          `  ${archiveName}: zipped ${done}/${total} (${Math.round(done / elapsed)} files/s, ${Math.round(writer.offset / 1024 / 1024)} MiB)`
        );
        lastProgressAt = now;
        await emitProgress("archiving", file.filePath);
      }
    }
    await writer.close();
  } catch (err) {
    await writer.abort();
    await writeProgress(progressPath, {
      status: "failed",
      archivePath,
      tmpPath,
      layer: task.layer,
      z: task.z,
      xStart: task.xStart,
      xEnd: task.xEnd,
      filesDone: done,
      filesTotal: total,
      bytesWritten: writer.offset,
      error: err.message,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
    throw err;
  }

  await fsp.rename(tmpPath, archivePath);
  const archiveInfo = await getArchiveFileInfo(archivePath);
  assertUsableArchive(archiveInfo, archivePath);
  await appendManifest(archiveDir, {
    event: "archive-created",
    archivePath,
    size: archiveInfo.size,
    files: total,
    layer: task.layer,
    z: task.z,
    xStart: task.xStart,
    xEnd: task.xEnd,
  });
  await emitProgress(deleteAfterArchive ? "deleting-source" : "complete");

  if (deleteAfterArchive) {
    await removeRangeFiles(task, deleteConcurrency);
    await emitProgress("complete");
  }

  state.completed ??= [];
  state.completed.push({
    layer: task.layer,
    z: task.z,
    xStart: task.xStart,
    xEnd: task.xEnd,
    archivePath,
    files: total,
    deletedSource: deleteAfterArchive,
    finishedAt: new Date().toISOString(),
  });
  if (state.active) delete state.active[archiveName];
  await queueWriteState(stateFile, state);
  await cleanupArchiveRuntimeFiles({ tmpPath, progressPath });
}

async function main() {
  loadDotEnvIfPresent();
  const opts = parseArgs(process.argv);
  const configDir = path.dirname(opts.configPath);
  const archiveConfig = (await loadJsonIfExists(opts.configPath, {})) || {};
  const directDownloaderConfig = isDownloaderConfig(archiveConfig);
  const sourceConfigPath = directDownloaderConfig
    ? opts.configPath
    : resolvePath(archiveConfig.sourceConfigPath, configDir, DEFAULT_SOURCE_CONFIG);
  const sourceConfig = (await loadJsonIfExists(sourceConfigPath, {})) || {};
  const rangeConfig =
    !directDownloaderConfig && Array.isArray(archiveConfig.ranges) && archiveConfig.ranges.length > 0
      ? archiveConfig
      : sourceConfig;
  const ranges = normalizeRanges(rangeConfig);

  if (ranges.length === 0) {
    throw new Error("No ranges found. Add ranges to archive-config.json or source config.");
  }

  const outputDir = opts.tilesDir
    ? resolvePath(opts.tilesDir, process.cwd(), path.join(__dirname, "tiles"))
    : archiveConfig.outputDir !== undefined && !directDownloaderConfig
      ? resolvePath(archiveConfig.outputDir, configDir, path.join(__dirname, "tiles"))
      : resolvePath(
          sourceConfig.output?.dir || sourceConfig.outputDir,
          path.dirname(sourceConfigPath),
          path.join(__dirname, "tiles")
        );
  const rawArchiveDir = opts.archiveDir || selectPlatformPath(archiveConfig, "archiveDir");
  const archiveDir = resolvePath(rawArchiveDir, configDir, path.join(__dirname, "archives"));
  const stateFile = resolvePath(archiveConfig.stateFile, configDir, DEFAULT_STATE_FILE);
  const xPadWidth = Number(archiveConfig.xPadWidth || 6);
  const fileNameTemplate =
    archiveConfig.fileNameTemplate || "tiles_{layer}_{z}_{xStart}-{xEnd}_y{yStart}-{yEnd}.zip";
  const deleteAfterArchive = opts.keep
    ? false
    : opts.deleteAfterArchive || archiveConfig.deleteAfterArchive === true;
  const deleteExistingArchivedSources =
    !opts.keep && archiveConfig.deleteExistingArchivedSources === true;
  const writeProbe = archiveConfig.writeArchiveProbe !== false;
  const archiveConcurrency = 1;
  const deleteConcurrency = clamp(parsePositiveInt(archiveConfig.deleteConcurrency, 32), 1, 128);
  const progressEveryFiles = parsePositiveInt(archiveConfig.progressEveryFiles, 1000);
  const progressEveryMs = parsePositiveInt(archiveConfig.progressEveryMs, 3000);
  const zipReadMode = archiveConfig.zipReadMode === "stream" ? "stream" : "direct";
  const zipWriteBufferBytes = clamp(
    parsePositiveInt(
      archiveConfig.zipWriteBufferMiB,
      DEFAULT_ZIP_WRITE_BUFFER_BYTES / 1024 / 1024
    ),
    1,
    512
  ) * 1024 * 1024;
  const maxArchiveSizeBytes = parseArchiveSizeBytes(
    opts.maxArchiveSize ?? archiveConfig.maxArchiveSizeBytes ?? archiveConfig.maxArchiveSize,
    DEFAULT_MAX_ARCHIVE_SIZE_BYTES
  );
  const layers = opts.layer
    ? [opts.layer]
    : !directDownloaderConfig && Array.isArray(archiveConfig.layers) && archiveConfig.layers.length > 0
      ? archiveConfig.layers
      : sourceConfig.layer
        ? [sourceConfig.layer]
        : ["satellite"];
  const state = (await loadJsonIfExists(stateFile, { completed: [] })) || { completed: [] };
  const downloaderState = opts.dryRun ? null : await openDownloaderState(sourceConfigPath);

  try {
    await fsp.mkdir(archiveDir, { recursive: true });
  } catch (err) {
    if (/^smb:\/\//i.test(String(rawArchiveDir || ""))) {
      throw new Error(
        `Cannot access SMB archive directory ${archiveDir}. On macOS, mount ${rawArchiveDir} first. On Windows, verify the UNC share is reachable. Original error: ${err.message}`
      );
    }
    throw err;
  }

  console.log(`Loaded archive config: ${opts.configPath}`);
  console.log(`Loaded source config: ${sourceConfigPath}`);
  console.log(`Tiles directory: ${outputDir}`);
  console.log(`Archive directory raw: ${rawArchiveDir || path.join(__dirname, "archives")}`);
  console.log(`Archive directory: ${archiveDir}`);
  console.log(`Delete after archive: ${deleteAfterArchive}`);
  console.log(`Delete existing archived sources: ${deleteExistingArchivedSources}`);
  console.log(`Archive concurrency: ${archiveConcurrency}`);
  console.log(`Delete concurrency: ${deleteConcurrency}`);
  console.log(`Progress interval: ${progressEveryFiles} files or ${progressEveryMs}ms`);
  console.log(`ZIP read mode: ${zipReadMode}`);
  console.log(`ZIP write buffer: ${Math.round(zipWriteBufferBytes / 1024 / 1024)} MiB`);
  console.log(`Max archive size: ${formatArchiveSize(maxArchiveSizeBytes)} (${maxArchiveSizeBytes} bytes)`);
  console.log(`Layers: ${layers.join(", ")}`);
  console.log(`Ranges: ${ranges.length}`);

  if (writeProbe && !opts.dryRun) {
    const { probePath, info } = await writeArchiveProbe(
      archiveDir,
      rawArchiveDir || path.join(__dirname, "archives"),
      archiveDir
    );
    console.log(`Archive write probe: ${probePath} size=${info.size}`);
    await appendManifest(archiveDir, {
      event: "archive-write-probe",
      probePath,
      size: info.size,
      rawArchiveDir: rawArchiveDir || path.join(__dirname, "archives"),
      archiveDir,
    });
    await fsp.rm(probePath, { force: true }).catch(() => {});
  }

  let archived = 0;
  let skipped = 0;
  let incomplete = 0;
  let duplicateSkipped = 0;
  const baseTaskItems = [];
  const taskByArchivePath = new Map();

  const makeTaskItem = ({ baseName, task, range, rangeIdx, partIndex = 1, totalParts = 1 }) => {
    const name = makeArchiveName(baseName, partIndex, totalParts);
    const archivePath = path.join(archiveDir, name);
    return {
      name,
      baseName,
      task,
      archivePath,
      tmpPath: `${archivePath}.tmp`,
      progressPath: `${archivePath}.progress.json`,
      signature: taskSignature(task),
      rangeState: {
        rangeIndex: rangeIdx + 1,
        label: range.label,
        z: task.z,
        xStart: task.xStart,
        xEnd: task.xEnd,
        yStart: task.yStart,
        yEnd: task.yEnd,
        expected: expectedFileCount(task),
      },
    };
  };

  const handleExistingArchive = async (item, existingArchive) => {
    const { name, task, archivePath, tmpPath, progressPath } = item;
    if (!existingArchive.isFile || existingArchive.size <= 0) {
      throw new Error(
        `Refusing to treat invalid archive path as complete: ${archivePath} isFile=${existingArchive.isFile} size=${existingArchive.size}`
      );
    }
    console.log(
      `SKIP existing: ${name} path=${archivePath} size=${existingArchive.size} mtime=${existingArchive.mtime}`
    );
    await appendManifest(archiveDir, {
      event: "skip-existing",
      archivePath,
      size: existingArchive.size,
      mtime: existingArchive.mtime,
    });
    await cleanupArchiveRuntimeFiles({ tmpPath, progressPath });
    if (deleteExistingArchivedSources) {
      console.log(`  ${name}: deleting source files for verified existing archive`);
      await removeRangeFiles(task, deleteConcurrency);
      markArchivedSourceDeleted(downloaderState, item);
      await appendManifest(archiveDir, {
        event: "delete-existing-source",
        archivePath,
        layer: task.layer,
        z: task.z,
        xStart: task.xStart,
        xEnd: task.xEnd,
      });
    } else if (deleteAfterArchive) {
      console.log(
        `  ${name}: source delete skipped for pre-existing archive; set deleteExistingArchivedSources=true to enable`
      );
    }
    skipped++;
  };

  const archiveTaskItem = async (item) => {
    const { name, task, archivePath, tmpPath, progressPath } = item;
    const existingArchive = await getArchiveFileInfo(archivePath);
    if (existingArchive.exists) {
      await handleExistingArchive(item, existingArchive);
      return;
    }

    const files = expectedFileCount(task);
    console.log(`ARCHIVE: ${name} files=${files} tmp=${tmpPath}`);
    await archiveRange({
      task,
      archivePath,
      tmpPath,
      progressPath,
      archiveName: name,
      dryRun: opts.dryRun,
      deleteAfterArchive,
      deleteConcurrency,
      progressEveryFiles,
      progressEveryMs,
      zipReadMode,
      zipWriteBufferBytes,
      state,
      stateFile,
      archiveDir,
    });
    if (deleteAfterArchive) markArchivedSourceDeleted(downloaderState, item);
    archived++;
  };

  for (const layer of layers) {
    const defaults = layerDefaults(layer, { ...sourceConfig, ...archiveConfig });
    for (let rangeIdx = 0; rangeIdx < ranges.length; rangeIdx++) {
      const range = ranges[rangeIdx];
      for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
        const task = {
          outputDir,
          layer: defaults.root,
          z,
          xStart: range.xStart,
          xEnd: range.xEnd,
          yStart: range.yStart,
          yEnd: range.yEnd,
          extension: defaults.extension,
        };
        const baseName = archiveFileName(fileNameTemplate, {
          layer,
          z,
          xStart: range.xStart,
          xEnd: range.xEnd,
          yStart: range.yStart,
          yEnd: range.yEnd,
          xPadWidth,
        });
        const item = makeTaskItem({ baseName, task, range, rangeIdx });
        const existingTask = taskByArchivePath.get(item.archivePath);
        if (existingTask) {
          if (existingTask.signature === item.signature) {
            duplicateSkipped++;
            continue;
          }
          throw new Error(
            `Archive filename collision: ${item.archivePath} is used by multiple different ranges. Include yStart/yEnd in fileNameTemplate.`
          );
        }
        taskByArchivePath.set(item.archivePath, item);
        baseTaskItems.push({ ...item, range, rangeIdx });
      }
    }
  }
  console.log(`Duplicate ranges skipped: ${duplicateSkipped}`);

  try {
    await runPool(baseTaskItems, archiveConcurrency, async (baseItem) => {
      const existingBaseArchive = await getArchiveFileInfo(baseItem.archivePath);
      if (existingBaseArchive.exists) {
        await handleExistingArchive(baseItem, existingBaseArchive);
        return;
      }

      const complete = await isRangeComplete(baseItem.task, {
        progressLabel: `CHECK ${baseItem.name}`,
        progressEveryMs,
      });
      if (!complete.complete && opts.onlyComplete) {
        console.log(
          `WAIT incomplete: ${baseItem.name} have=${complete.files} missing=${complete.missing} first=${complete.firstMissing || "n/a"}`
        );
        incomplete++;
        return;
      }

      const splitTasks = await splitTaskByArchiveSize(baseItem.task, maxArchiveSizeBytes, {
        progressLabel: `PLAN ${baseItem.name}`,
        progressEveryFiles,
        progressEveryMs,
      });
      const totalParts = splitTasks.length;
      for (let partIndex = 0; partIndex < splitTasks.length; partIndex++) {
        const splitItem = makeTaskItem({
          baseName: baseItem.baseName,
          task: splitTasks[partIndex],
          range: baseItem.range,
          rangeIdx: baseItem.rangeIdx,
          partIndex: partIndex + 1,
          totalParts,
        });
        await archiveTaskItem(splitItem);
      }
    });

    if (!opts.dryRun && incomplete === 0) {
      await cleanupCompletedRunFiles({ archiveDir, stateFile });
    }

    console.log(
      `Done. archived=${archived} skipped=${skipped} incomplete=${incomplete} state=${incomplete === 0 ? "cleaned" : stateFile}`
    );
    if (incomplete > 0) process.exitCode = 1;
  } finally {
    downloaderState?.db.close();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
