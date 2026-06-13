import dns from "node:dns";
import os from "node:os";

const ORIGINAL_FETCH = Symbol.for("tile-downloader.original-fetch");
const WRAPPED_FETCH = Symbol.for("tile-downloader.wrapped-fetch");

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

function firstDefinedEnv(env, lowerKey, upperKey) {
  const lower = env?.[lowerKey];
  if (typeof lower === "string" && lower.trim()) return lower.trim();
  const upper = env?.[upperKey];
  if (typeof upper === "string" && upper.trim()) return upper.trim();
  return "";
}

function providerConcurrencyCap(provider, env = process.env) {
  if (provider !== "esri") return null;
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_MAX_CONCURRENCY) ?? 64;
}

export function resolveProxyEnvironment(env = process.env) {
  return {
    httpProxy: firstDefinedEnv(env, "http_proxy", "HTTP_PROXY"),
    httpsProxy: firstDefinedEnv(env, "https_proxy", "HTTPS_PROXY"),
    noProxy: firstDefinedEnv(env, "no_proxy", "NO_PROXY"),
  };
}

function hasProxyEnvironment(proxyEnv) {
  return Boolean(proxyEnv.httpProxy || proxyEnv.httpsProxy);
}

function defaultPort(protocol) {
  return protocol === "http:" ? "80" : protocol === "https:" ? "443" : "";
}

export function shouldBypassProxy(urlLike, noProxy) {
  if (!noProxy || !String(noProxy).trim()) return false;
  const rules = String(noProxy)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (rules.includes("*")) return true;

  const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike));
  const hostname = url.hostname.toLowerCase();
  const port = url.port || defaultPort(url.protocol);

  return rules.some((rule) => {
    const normalized = rule.toLowerCase();
    const portIdx = normalized.lastIndexOf(":");
    const hasPort = portIdx > -1 && normalized.indexOf("]") === -1;
    const hostRule = hasPort ? normalized.slice(0, portIdx) : normalized;
    const portRule = hasPort ? normalized.slice(portIdx + 1) : "";
    if (portRule && portRule !== port) return false;

    const stripped = hostRule.replace(/^\*\./, "").replace(/^\./, "");
    if (!stripped) return false;
    return hostname === stripped || hostname.endsWith(`.${stripped}`);
  });
}

function buildAgentOptions(profile) {
  return {
    connections: profile.dispatcherConnections,
    pipelining: profile.dispatcherPipelining,
    connect: {
      timeout: 30_000,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
    },
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000,
  };
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
  let env = process.env;
  let runtime = {};
  if (arguments.length >= 2 && arguments[1]) env = arguments[1];
  if (arguments.length >= 3 && arguments[2]) runtime = arguments[2];

  dns.setDefaultResultOrder("ipv4first");

  try {
    const undici = runtime.undici || (await import("undici"));
    const targetGlobal = runtime.targetGlobal || globalThis;
    const agentOptions = buildAgentOptions(profile);
    const directAgent = new undici.Agent(agentOptions);
    undici.setGlobalDispatcher(directAgent);

    const proxyEnv = resolveProxyEnvironment(env);
    const baseFetch =
      runtime.fetchImpl ||
      targetGlobal[ORIGINAL_FETCH] ||
      targetGlobal.fetch?.bind(targetGlobal);
    if (typeof baseFetch !== "function") return;

    if (!hasProxyEnvironment(proxyEnv) || typeof undici.EnvHttpProxyAgent !== "function") {
      if (targetGlobal[ORIGINAL_FETCH]) {
        targetGlobal.fetch = targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[WRAPPED_FETCH];
      }
      return;
    }

    const proxyAgent = new undici.EnvHttpProxyAgent({
      ...agentOptions,
      httpProxy: proxyEnv.httpProxy || undefined,
      httpsProxy: proxyEnv.httpsProxy || undefined,
      noProxy: proxyEnv.noProxy || undefined,
    });
    targetGlobal[ORIGINAL_FETCH] = baseFetch;
    targetGlobal.fetch = async (input, init = {}) => {
      const isRequest =
        typeof Request !== "undefined" && input instanceof Request;
      const url = isRequest ? input.url : String(input);
      const dispatcher =
        shouldBypassProxy(url, proxyEnv.noProxy) ? directAgent : proxyAgent;
      return undici.fetch(input, {
        ...init,
        dispatcher: init.dispatcher || dispatcher,
      });
    };
    targetGlobal[WRAPPED_FETCH] = true;
  } catch {
    // Node fetch remains usable without undici installed as a dependency.
  }
}
