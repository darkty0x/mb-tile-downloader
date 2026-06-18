import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { collectDiskInfo } from "./disk.js";
import { resolveOutputStorage } from "../runtime/output-storage.js";

const MAX_DIR_ENTRIES = 80;
const MAX_CONSOLE_LINES = 80;
const TILE_ESTIMATE_MIN_DRIVE_USED_BYTES = 1024 * 1024 * 1024;
const TILE_ESTIMATE_MAX_EXACT_BYTES = 128 * 1024 * 1024;
const TILE_ESTIMATE_MIN_TREE_ITEMS = 100;
const SECRET_NAME_PATTERN = /(TOKEN|PASSWORD|SECRET|KEY|ACCESS|CREDENTIAL|PASS)/i;
const API_ENV_NAMES = new Set(["MAPBOX_ACCESS_TOKENS"]);

function slashPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function rel(projectDir, value) {
  if (!value) return null;
  const relative = path.relative(projectDir, path.resolve(projectDir, value));
  return relative && !relative.startsWith("..") ? slashPath(relative) : slashPath(value);
}

function classifyConfigName(name) {
  const lower = name.toLowerCase();
  if (lower.includes("esri") && lower.includes("satellite")) return "esri-satellite";
  if (lower.includes("mapbox") && lower.includes("satellite")) return "mapbox-satellite";
  if (lower.includes("pbf")) return "mapbox-pbf";
  if (lower.includes("dem")) return "mapbox-dem";
  if (lower.includes("topo")) return "topo";
  return "config";
}

async function existsStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listJsonConfigs(configDir) {
  const dirStat = await existsStat(configDir);
  if (!dirStat?.isDirectory()) return [];
  const files = [];
  for await (const entry of await opendir(configDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(configDir, entry.name);
    const fileStat = await existsStat(filePath);
    const config = await readJsonFile(filePath);
    files.push({
      name: entry.name,
      path: slashPath(filePath),
      type: classifyConfigName(entry.name),
      provider: config?.provider || null,
      layer: config?.layer || config?.name || null,
      ranges: Array.isArray(config?.ranges) ? config.ranges.length : 0,
      sizeBytes: fileStat?.size || 0,
      updatedAt: fileStat?.mtime?.toISOString?.() || null,
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function splitList(value) {
  return String(value || "")
    .split(/[,\r\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function summarizeEnvFile(projectDir, filePath, { omitNames = new Set() } = {}) {
  const fileStat = await existsStat(filePath);
  if (!fileStat?.isFile()) {
    return {
      path: rel(projectDir, filePath),
      exists: false,
      variables: [],
      variableCount: 0,
      sizeBytes: 0,
      updatedAt: null,
    };
  }
  const content = await readFile(filePath, "utf8");
  const variables = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      const name = line.slice(0, index);
      const value = line.slice(index + 1);
      return {
        name,
        value,
        secret: SECRET_NAME_PATTERN.test(name),
      };
    })
    .filter((item) => !omitNames.has(item.name));
  return {
    path: rel(projectDir, filePath),
    exists: true,
    variables,
    variableCount: variables.length,
    sizeBytes: fileStat.size,
    updatedAt: fileStat.mtime.toISOString(),
  };
}

async function readEnvValue(filePath, name) {
  const fileStat = await existsStat(filePath);
  if (!fileStat?.isFile()) return "";
  const content = await readFile(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    if (trimmed.slice(0, index).trim() !== name) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

async function countNonEmptyLines(filePath) {
  const fileStat = await existsStat(filePath);
  if (!fileStat?.isFile()) return { exists: false, count: 0, sizeBytes: 0, updatedAt: null };
  let count = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim()) count += 1;
  }
  return {
    exists: true,
    count,
    sizeBytes: fileStat.size,
    updatedAt: fileStat.mtime.toISOString(),
  };
}

async function shallowDirSummary(projectDir, targetPath, { label, type }) {
  const fullPath = path.resolve(projectDir, targetPath);
  const dirStat = await existsStat(fullPath);
  if (!dirStat?.isDirectory()) {
    return {
      label,
      type,
      path: rel(projectDir, fullPath),
      absolutePath: slashPath(fullPath),
      exists: false,
      sizeBytes: 0,
      fileCount: 0,
      dirCount: 0,
      truncated: false,
      entries: [],
    };
  }

  const entries = [];
  let sizeBytes = 0;
  let fileCount = 0;
  let dirCount = 0;
  const pendingDirs = [fullPath];

  while (pendingDirs.length) {
    const currentDir = pendingDirs.shift();
    for await (const entry of await opendir(currentDir)) {
      const childPath = path.join(currentDir, entry.name);
      const childStat = await existsStat(childPath);
      if (!childStat) continue;
      if (childStat.isDirectory()) {
        dirCount += 1;
        pendingDirs.push(childPath);
      }
      if (childStat.isFile()) {
        fileCount += 1;
        sizeBytes += childStat.size;
      }
      if (entries.length < MAX_DIR_ENTRIES) {
        entries.push({
          name: path.relative(fullPath, childPath) || entry.name,
          kind: childStat.isDirectory() ? "folder" : "file",
          sizeBytes: childStat.isFile() ? childStat.size : 0,
          updatedAt: childStat.mtime.toISOString(),
        });
      }
    }
  }

  return {
    label,
    type,
    path: rel(projectDir, fullPath),
    absolutePath: slashPath(fullPath),
    exists: true,
    sizeBytes,
    fileCount,
    dirCount,
    truncated: false,
    entries,
  };
}

function normalizedStoragePath(value) {
  return slashPath(value).replace(/\/+$/, "").toLowerCase();
}

function storageBelongsToDisk(item, disk) {
  const itemPath = normalizedStoragePath(item.absolutePath || item.path);
  const mount = normalizedStoragePath(disk.mount || disk.name);
  if (!itemPath || !mount) return false;
  if (itemPath === mount) return true;
  if (mount === "/" && itemPath.startsWith("/")) return true;
  return itemPath.startsWith(`${mount}/`);
}

function shouldEstimateTileStorage(item, disk) {
  const exactBytes = Number(item.sizeBytes) || 0;
  const treeItems = (Number(item.fileCount) || 0) + (Number(item.dirCount) || 0);
  const driveUsedBytes = Number(disk.usedBytes) || 0;
  return Boolean(
    item.exists &&
    item.type === "tiles" &&
    storageBelongsToDisk(item, disk) &&
    driveUsedBytes >= TILE_ESTIMATE_MIN_DRIVE_USED_BYTES &&
    exactBytes < TILE_ESTIMATE_MAX_EXACT_BYTES &&
    treeItems >= TILE_ESTIMATE_MIN_TREE_ITEMS
  );
}

export function applyTileStorageEstimates({ tileStorage = [], otherStorage = [], disks = [] } = {}) {
  const next = tileStorage.map((item) => ({ ...item }));
  for (const disk of disks) {
    const candidates = next.filter((item) => shouldEstimateTileStorage(item, disk));
    if (!candidates.length) continue;
    const nonTileBytes = otherStorage
      .filter((item) => item.exists && storageBelongsToDisk(item, disk))
      .reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0);
    const estimatedTileBytes = Math.max(0, (Number(disk.usedBytes) || 0) - nonTileBytes);
    if (!estimatedTileBytes) continue;
    const totalWeight = candidates.reduce((sum, item) => {
      const weight = Math.max(1, (Number(item.fileCount) || 0) + (Number(item.dirCount) || 0));
      return sum + weight;
    }, 0);
    for (const item of candidates) {
      const weight = Math.max(1, (Number(item.fileCount) || 0) + (Number(item.dirCount) || 0));
      const share = candidates.length === 1 ? estimatedTileBytes : Math.round((estimatedTileBytes * weight) / totalWeight);
      if (share <= (Number(item.sizeBytes) || 0)) continue;
      item.exactSizeBytes = Number(item.sizeBytes) || 0;
      item.sizeBytes = share;
      item.sizeEstimated = true;
      item.estimateReason = "drive-used-minus-known-managed-storage";
    }
  }
  return next;
}

function selectPlatformPath(config = {}, baseKey, platform = process.platform) {
  if (platform === "win32" && config[`${baseKey}Windows`]) return config[`${baseKey}Windows`];
  if (platform === "darwin" && config[`${baseKey}Mac`]) return config[`${baseKey}Mac`];
  return config[baseKey];
}

function archiveDirForConfig(config, projectDir, platform = process.platform) {
  const archiveConfig = config?.archive || config?.zip || config || {};
  const rawArchiveDir = selectPlatformPath(archiveConfig, "archiveDir", platform);
  return rawArchiveDir ? path.resolve(projectDir, rawArchiveDir) : path.join(projectDir, "archives");
}

async function safeCollectDiskInfo({ platform, projectDir }) {
  try {
    return await collectDiskInfo({ platform, projectDir });
  } catch {
    return [];
  }
}

function uniquePaths(paths, platform = process.platform) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths.filter(Boolean)) {
    const normalized = platform === "win32"
      ? path.win32.resolve(candidate).toLowerCase()
      : path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(candidate);
  }
  return result;
}

function tileDirsForDisks({ disks = [], projectDir, platform = process.platform }) {
  const candidates = [];
  if (platform === "win32") {
    const parsed = path.win32.parse(projectDir);
    const relativeProject = path.win32.relative(parsed.root, projectDir);
    const projectName = path.win32.basename(projectDir);
    for (const disk of disks) {
      const mount = String(disk.mount || disk.name || "").replace(/[\\/]+$/, "");
      if (!mount) continue;
      const root = `${mount}\\`;
      candidates.push(path.win32.resolve(root, "tiles"));
      if (projectName) candidates.push(path.win32.resolve(root, projectName, "tiles"));
      if (relativeProject && !relativeProject.startsWith("..")) {
        candidates.push(path.win32.resolve(root, relativeProject, "tiles"));
      }
    }
    return candidates.filter(Boolean);
  }

  const projectDisk = disks.find((disk) => disk.containsProject);
  const relativeProject = projectDisk?.mount ? path.relative(projectDisk.mount, projectDir) : "";
  const projectName = path.basename(projectDir);
  for (const disk of disks) {
    if (!disk.mount) continue;
    candidates.push(path.resolve(disk.mount, "tiles"));
    if (projectName) candidates.push(path.resolve(disk.mount, projectName, "tiles"));
    if (relativeProject && !relativeProject.startsWith("..")) {
      candidates.push(path.resolve(disk.mount, relativeProject, "tiles"));
    }
  }
  return candidates.filter(Boolean);
}

async function readRecentLines(filePath, limit = MAX_CONSOLE_LINES) {
  const fileStat = await existsStat(filePath);
  if (!fileStat?.isFile()) return [];
  const lines = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    lines.push(line);
    if (lines.length > limit) lines.shift();
  }
  return lines;
}

export async function collectLocalSnapshot({
  projectDir = process.cwd(),
  stateDir = ".tile-state",
  synced = {},
  agentLogPath = path.join(stateDir, "dashboard-agent.log"),
  env = process.env,
  platform = process.platform,
} = {}) {
  const resolvedProject = path.resolve(projectDir);
  const resolvedState = path.resolve(resolvedProject, stateDir);
  const activeConfig = synced.configPath ? await readJsonFile(path.resolve(resolvedProject, synced.configPath)) : null;
  const outputStorage = await resolveOutputStorage({
    dir: activeConfig?.outputDir || activeConfig?.output?.dir || activeConfig?.output || "tiles",
    configDir: resolvedProject,
    env,
    platform,
    projectDir: resolvedProject,
  });
  const proxyInfo = await countNonEmptyLines(path.join(resolvedProject, "proxy.txt"));
  const rootMapboxTokens = splitList(await readEnvValue(path.join(resolvedProject, ".env"), "MAPBOX_ACCESS_TOKENS"));
  const syncedMapboxTokens = splitList(synced.secretEnv?.MAPBOX_ACCESS_TOKENS);
  const mapboxTokens = syncedMapboxTokens.length ? syncedMapboxTokens : rootMapboxTokens;
  const envFiles = [
    await summarizeEnvFile(resolvedProject, path.join(resolvedProject, ".env"), { omitNames: API_ENV_NAMES }),
  ];
  const disks = await safeCollectDiskInfo({ platform, projectDir: resolvedProject });

  const tileRoots = uniquePaths([
    ...(outputStorage.searchDirs?.length ? outputStorage.searchDirs : (outputStorage.dirs || [outputStorage.dir])),
    path.join(resolvedProject, "tiles"),
    ...tileDirsForDisks({ disks, projectDir: resolvedProject, platform }),
  ], platform);
  const exactTileStorage = await Promise.all(
    tileRoots.map((root, index) =>
      shallowDirSummary(resolvedProject, root, {
        label: tileRoots.length > 1 ? `Tile Content ${index + 1}` : "Tile Content",
        type: "tiles",
      })
    )
  );
  const storage = await Promise.all([
    shallowDirSummary(resolvedProject, archiveDirForConfig(activeConfig, resolvedProject, platform), { label: "Zip Archives", type: "zip" }),
  ]);
  const tileStorage = applyTileStorageEstimates({ tileStorage: exactTileStorage, otherStorage: storage, disks });

  return {
    projectDir: slashPath(resolvedProject),
    managed: {
      configPath: rel(resolvedProject, synced.configPath),
      envPath: rel(resolvedProject, synced.envPath),
      secretsEnvPath: rel(resolvedProject, synced.secretsEnvPath),
      proxyPath: rel(resolvedProject, synced.proxyPath || "proxy.txt"),
      activeConfigName: activeConfig?.name || activeConfig?.jobName || activeConfig?.id || null,
      activeProvider: activeConfig?.provider || null,
      activeRanges: Array.isArray(activeConfig?.ranges) ? activeConfig.ranges.length : 0,
    },
    configs: await listJsonConfigs(path.join(resolvedProject, "configs")),
    envFiles,
    secrets: {
      proxy: {
        path: rel(resolvedProject, "proxy.txt"),
        exists: proxyInfo.exists,
        availableCount: proxyInfo.count,
        sizeBytes: proxyInfo.sizeBytes,
        updatedAt: proxyInfo.updatedAt,
      },
      mapboxTokenCount: mapboxTokens.length,
      mapboxTokens,
      generatedEnvPath: rel(resolvedProject, synced.secretsEnvPath),
    },
    storage: [...tileStorage, ...storage],
    console: {
      agentLogPath: rel(resolvedProject, agentLogPath),
      recentLines: await readRecentLines(path.resolve(resolvedProject, agentLogPath)),
    },
    updatedAt: new Date().toISOString(),
  };
}
