import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { resolveOutputStorage } from "../runtime/output-storage.js";

const MAX_DIR_ENTRIES = 80;
const MAX_SCAN_ENTRIES = 2_000;
const MAX_CONSOLE_LINES = 80;
const SECRET_NAME_PATTERN = /(TOKEN|PASSWORD|SECRET|KEY|ACCESS|CREDENTIAL|PASS)/i;

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

function redactEnvValue(name, value) {
  if (SECRET_NAME_PATTERN.test(name)) return "********";
  const text = String(value ?? "");
  if (text.length <= 12) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function summarizeEnvFile(projectDir, filePath) {
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
        value: redactEnvValue(name, value),
        secret: SECRET_NAME_PATTERN.test(name),
      };
    });
  return {
    path: rel(projectDir, filePath),
    exists: true,
    variables,
    variableCount: variables.length,
    sizeBytes: fileStat.size,
    updatedAt: fileStat.mtime.toISOString(),
  };
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
  let scanned = 0;
  let truncated = false;
  const pendingDirs = [fullPath];

  while (pendingDirs.length) {
    const currentDir = pendingDirs.shift();
    for await (const entry of await opendir(currentDir)) {
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
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
    if (truncated) break;
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
    truncated,
    entries,
  };
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
  const envFiles = await Promise.all([
    summarizeEnvFile(resolvedProject, path.join(resolvedProject, ".env")),
    summarizeEnvFile(resolvedProject, path.join(resolvedState, "dashboard", "env.generated")),
    summarizeEnvFile(resolvedProject, path.join(resolvedState, "dashboard", "secrets.env.generated")),
  ]);

  const tileStorage = await Promise.all(
    (outputStorage.dirs || [outputStorage.dir]).map((root, index) =>
      shallowDirSummary(resolvedProject, root, {
        label: (outputStorage.dirs || []).length > 1 ? `Tile Content ${index + 1}` : "Tile Content",
        type: "tiles",
      })
    )
  );
  const storage = await Promise.all([
    shallowDirSummary(resolvedProject, "zips", { label: "Zip Archives", type: "zip" }),
    shallowDirSummary(resolvedProject, ".tile-state", { label: "State DB / Temp", type: "state" }),
    shallowDirSummary(resolvedProject, "configs", { label: "Config Files", type: "configs" }),
  ]);

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
      mapboxTokenCount: Number(synced.secretEnv?.MAPBOX_ACCESS_TOKENS?.split(",").filter(Boolean).length || 0),
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
