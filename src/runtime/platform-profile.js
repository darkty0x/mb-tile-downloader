import dns from "node:dns";
import os from "node:os";

const PLATFORM_LIMITS = {
  linux: {
    os: "linux",
    pathFlavor: "posix",
    defaultMultiplier: 12,
    defaultMin: 512,
    defaultMax: 1024,
    maxConcurrentRequests: 1024,
    maxRowsInFlight: 1,
    dispatcherPipelining: 1,
  },
  darwin: {
    os: "macos",
    pathFlavor: "posix",
    defaultMultiplier: 8,
    defaultMin: 512,
    defaultMax: 2048,
    maxConcurrentRequests: 4096,
    maxRowsInFlight: 1,
    dispatcherPipelining: 1,
  },
  win32: {
    os: "windows",
    pathFlavor: "windows",
    defaultMultiplier: 6,
    defaultMin: 512,
    defaultMax: 2048,
    maxConcurrentRequests: 4096,
    maxRowsInFlight: 1,
    dispatcherPipelining: 1,
  },
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function providerConcurrencyCap(provider, env = process.env) {
  if (provider !== "esri") return null;
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_MAX_CONCURRENCY) ?? 64;
}

export function getPlatformKey(platform = process.platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  return "linux";
}

export function buildPlatformProfile({
  platform = process.platform,
  cpuCount,
  requestedConcurrency,
  requestedRows,
  requestTimeoutMs,
  provider,
  env = process.env,
} = {}) {
  const limits = PLATFORM_LIMITS[getPlatformKey(platform)];
  const cpus =
    parsePositiveInt(cpuCount) ??
    (typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length);

  const defaultConcurrency = clamp(
    cpus * limits.defaultMultiplier,
    limits.defaultMin,
    limits.defaultMax
  );
  const requested = parsePositiveInt(requestedConcurrency) ?? defaultConcurrency;
  const platformCappedConcurrency = clamp(
    requested,
    1,
    limits.maxConcurrentRequests
  );
  const providerCap = providerConcurrencyCap(provider, env);
  const maxConcurrentRequests = providerCap
    ? Math.min(platformCappedConcurrency, providerCap)
    : platformCappedConcurrency;

  const defaultRows = clamp(Math.ceil(cpus / 2), 1, limits.maxRowsInFlight);
  const requestedRowCount = parsePositiveInt(requestedRows) ?? defaultRows;
  const maxRowsInFlight = clamp(requestedRowCount, 1, limits.maxRowsInFlight);

  const perRowConcurrency = clamp(
    Math.floor(maxConcurrentRequests / maxRowsInFlight) || 1,
    1,
    maxConcurrentRequests
  );

  return {
    os: limits.os,
    nodePlatform: platform,
    pathFlavor: limits.pathFlavor,
    cpuCount: cpus,
    requestedConcurrency: requested,
    requestedRows: requestedRowCount,
    maxConcurrentRequests,
    maxRowsInFlight,
    perRowConcurrency,
    dispatcherConnections: maxConcurrentRequests,
    dispatcherPipelining: limits.dispatcherPipelining,
    requestTimeoutMs: parsePositiveInt(requestTimeoutMs) ?? 25_000,
    wasConcurrencyCapped: requested !== maxConcurrentRequests,
    wereRowsCapped: requestedRowCount !== maxRowsInFlight,
  };
}

export async function configureNetworking(profile) {
  dns.setDefaultResultOrder("ipv4first");

  try {
    const undici = await import("undici");
    undici.setGlobalDispatcher(
      new undici.Agent({
        connections: profile.dispatcherConnections,
        pipelining: profile.dispatcherPipelining,
        connect: {
          timeout: 30_000,
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 250,
        },
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 120_000,
      })
    );
  } catch {
    // Node fetch remains usable without undici installed as a dependency.
  }
}
