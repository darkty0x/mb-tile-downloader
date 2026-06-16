import path from "node:path";

import { collectDiskInfo } from "../agent/disk.js";

const DEFAULT_DYNAMIC_FOLDER = "mb-tile-downloader/tiles";
const DEFAULT_MIN_FREE_GB = 1;
const DEFAULT_MAX_USED_PERCENT = 95;

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value) {
  return String(value || "")
    .split(/[,\r\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRoot(root, platform = process.platform) {
  if (platform === "win32") return path.win32.resolve(root);
  return path.resolve(root);
}

function platformJoinRoot(platform, mount, folder) {
  const cleanFolder = String(folder || DEFAULT_DYNAMIC_FOLDER).replace(/^[/\\]+/, "");
  if (platform === "win32") {
    const drive = String(mount || "").replace(/[\\/]+$/, "");
    return path.win32.resolve(`${drive}\\`, cleanFolder.replace(/\//g, "\\"));
  }
  return path.resolve(String(mount || "/"), cleanFolder);
}

function dynamicEnabled(env = {}) {
  const explicit = parseBoolean(env.TILE_DOWNLOADER_DYNAMIC_OUTPUT);
  if (explicit !== null) return explicit;
  const mode = String(env.TILE_DOWNLOADER_OUTPUT_MODE || "").trim().toLowerCase();
  return ["dynamic", "auto", "multi", "multi-disk"].includes(mode);
}

function isAbsoluteForPlatform(root, platform = process.platform) {
  return platform === "win32" ? path.win32.isAbsolute(root) : path.isAbsolute(root);
}

function configuredRoots(env = {}, configDir = process.cwd(), platform = process.platform) {
  const roots = splitList(env.TILE_DOWNLOADER_OUTPUT_ROOTS || env.TILE_DOWNLOADER_OUTPUT_DIRS);
  return roots.map((root) => (isAbsoluteForPlatform(root, platform) ? root : path.resolve(configDir, root)));
}

async function discoverDynamicRoots({
  env = process.env,
  platform = process.platform,
  projectDir = process.cwd(),
  collectDiskInfoImpl = collectDiskInfo,
} = {}) {
  const minFreeBytes = parsePositiveNumber(env.TILE_DOWNLOADER_OUTPUT_MIN_FREE_GB, DEFAULT_MIN_FREE_GB) * 1024 ** 3;
  const maxUsedPercent = parsePositiveNumber(env.TILE_DOWNLOADER_OUTPUT_MAX_USED_PERCENT, DEFAULT_MAX_USED_PERCENT);
  const includeProjectDrive = parseBoolean(env.TILE_DOWNLOADER_OUTPUT_INCLUDE_PROJECT_DRIVE) ?? false;
  const folder = env.TILE_DOWNLOADER_OUTPUT_FOLDER || DEFAULT_DYNAMIC_FOLDER;
  const disks = await collectDiskInfoImpl({ platform, projectDir });
  const eligible = disks
    .filter((disk) => Number(disk.freeBytes) >= minFreeBytes)
    .filter((disk) => Number(disk.percentUsed) <= maxUsedPercent)
    .sort((a, b) => {
      if (Boolean(a.containsProject) !== Boolean(b.containsProject)) {
        return Number(Boolean(a.containsProject)) - Number(Boolean(b.containsProject));
      }
      return Number(b.freeBytes || 0) - Number(a.freeBytes || 0);
    });
  const nonProject = eligible.filter((disk) => !disk.containsProject);
  const selected = !includeProjectDrive && nonProject.length ? nonProject : eligible;
  return selected.map((disk) => platformJoinRoot(platform, disk.mount || disk.name, folder));
}

export async function resolveOutputStorage({
  dir,
  configDir = process.cwd(),
  env = process.env,
  platform = process.platform,
  projectDir = process.cwd(),
  collectDiskInfoImpl = collectDiskInfo,
} = {}) {
  const explicitRoots = configuredRoots(env, configDir, platform);
  let dirs = explicitRoots;
  let mode = explicitRoots.length > 0 ? "explicit" : "single";
  if (dirs.length === 0 && dynamicEnabled(env)) {
    dirs = await discoverDynamicRoots({ env, platform, projectDir, collectDiskInfoImpl });
    mode = dirs.length > 0 ? "dynamic" : "single";
  }

  if (dirs.length === 0) {
    const selected = dir || "tiles";
    dirs = [path.isAbsolute(selected) ? selected : path.resolve(configDir, selected)];
  }

  const normalizedDirs = [...new Set(dirs.map((root) => normalizeRoot(root, platform)))];
  return {
    dir: normalizedDirs[0],
    dirs: normalizedDirs,
    storageMode: normalizedDirs.length > 1 ? mode : "single",
    pathTemplate: "{layer}/{z}/{x}/{y}.{extension}",
  };
}

export function selectOutputRoot(output, { z = 0, x = 0 } = {}) {
  const roots = Array.isArray(output?.dirs) && output.dirs.length ? output.dirs : [output?.dir];
  if (roots.length <= 1) return roots[0];
  const rowKey = Math.abs((Number(z) || 0) * 131 + (Number(x) || 0));
  return roots[rowKey % roots.length];
}
