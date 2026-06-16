import dns from "node:dns";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGINAL_FETCH = Symbol.for("tile-downloader.original-fetch");
const WRAPPED_FETCH = Symbol.for("tile-downloader.wrapped-fetch");
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROXY_FILE = path.resolve(MODULE_DIR, "..", "..", "proxy.txt");

const DEFAULT_PROXY_FAILURE_BLOCK_MS = 5 * 60 * 1000;
const PROXY_LIST_ENV_KEYS = {
  ALL: ["TILE_DOWNLOADER_PROXY_LIST", "PROXY_LIST"],
  HTTP: ["TILE_DOWNLOADER_HTTP_PROXY_LIST", "HTTP_PROXY_LIST"],
  HTTPS: ["TILE_DOWNLOADER_HTTPS_PROXY_LIST", "HTTPS_PROXY_LIST"],
};
const PROXY_LIST_FILE_ENV_KEYS = {
  ALL: ["TILE_DOWNLOADER_PROXY_LIST_FILE", "PROXY_LIST_FILE"],
  HTTP: ["TILE_DOWNLOADER_HTTP_PROXY_LIST_FILE", "HTTP_PROXY_LIST_FILE"],
  HTTPS: ["TILE_DOWNLOADER_HTTPS_PROXY_LIST_FILE", "HTTPS_PROXY_LIST_FILE"],
};
const PROXY_AUTH_ENV_KEYS = {
  USERNAME: ["TILE_DOWNLOADER_PROXY_USERNAME", "PROXY_USERNAME", "PROXYSCRAPE_PROXY_USERNAME"],
  PASSWORD: ["TILE_DOWNLOADER_PROXY_PASSWORD", "PROXY_PASSWORD", "PROXYSCRAPE_PROXY_PASSWORD"],
};

export const PROXY_INFO_SYMBOL = Symbol.for("tile-downloader.proxy-info");

export class NoHealthyProxyError extends Error {
  constructor(message = "No paid proxy is available for the request") {
    super(message);
    this.name = "NoHealthyProxyError";
    this.code = "NO_HEALTHY_PROXY";
  }
}

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

function resolveAnyEnv(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function proxyAuthFromEnv(env = process.env) {
  return {
    username: resolveAnyEnv(env, PROXY_AUTH_ENV_KEYS.USERNAME),
    password: resolveAnyEnv(env, PROXY_AUTH_ENV_KEYS.PASSWORD),
  };
}

function readProxyListFile(env, keys) {
  const filePath = resolveAnyEnv(env, keys);
  if (!filePath) return "";
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    const wrapped = new Error(`Unable to read proxy list file: ${filePath}`);
    wrapped.code = "PROXY_CONFIG_ERROR";
    wrapped.cause = error;
    throw wrapped;
  }
}

function readDefaultProxyFile(filePath) {
  if (!filePath) return "";
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    const wrapped = new Error(`Unable to read default proxy file: ${filePath}`);
    wrapped.code = "PROXY_CONFIG_ERROR";
    wrapped.cause = error;
    throw wrapped;
  }
}

function parseProxyList(value, auth = {}) {
  if (typeof value !== "string") return [];
  const parsed = value
    .split(/[,\n]+/)
    .map((entry) => normalizeProxyEntry(entry, auth))
    .filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const proxy of parsed) {
    const key = proxy.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(proxy);
  }
  return deduped;
}

function normalizeProxyEntry(candidate, auth = {}) {
  const raw = String(candidate || "").trim();
  if (!raw) return "";
  const withProtocol = raw.includes("://") ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.hostname || !parsed.port) return "";
    const username = parsed.username || auth.username || "";
    const password = parsed.password || (username ? auth.password : "");
    const authPart = username
      ? `${username}${password ? `:${password}` : ""}@`
      : "";
    return `${parsed.protocol}//${authPart}${parsed.host}`;
  } catch {
    return "";
  }
}

function parseProxyFailureBlockMs(env = process.env) {
  return (
    parsePositiveInt(
      resolveAnyEnv(env, ["TILE_DOWNLOADER_PROXY_FAILURE_BLOCK_MS", "PROXY_FAILURE_BLOCK_MS"])
    ) || DEFAULT_PROXY_FAILURE_BLOCK_MS
  );
}

function parseProxyAttemptsPerRequest(env = process.env, candidateCount = 0) {
  const configured = parsePositiveInt(
    resolveAnyEnv(env, ["TILE_DOWNLOADER_PROXY_ATTEMPTS_PER_REQUEST", "PROXY_ATTEMPTS_PER_REQUEST"])
  );
  const fallback = Math.min(Math.max(candidateCount, 1), 8);
  return Math.min(Math.max(configured || fallback, 1), Math.max(candidateCount, 1));
}

function proxyMode(env = process.env) {
  const configured = resolveAnyEnv(env, ["TILE_DOWNLOADER_PROXY_MODE", "PROXY_MODE"]).toLowerCase();
  if (["always", "force", "proxy"].includes(configured)) return "always";
  if (["fallback", "auto", "direct-first", "direct_first"].includes(configured)) return "fallback";
  return "always";
}

function shouldFallbackToProxy(response) {
  return response?.status === 403 || response?.status === 429;
}

function protocolKey(protocol) {
  return protocol === "https:" ? "https" : "http";
}

function protocolKeyFromCandidate(candidate) {
  if (candidate === "https:" || candidate === "https") return "https";
  if (candidate === "http:" || candidate === "http") return "http";
  try {
    return protocolKey(new URL(String(candidate)).protocol);
  } catch {
    return null;
  }
}

export function resolveProxyEnvironment(env = process.env, options = {}) {
  return resolveProxyEnvironmentWithOptions(env, options);
}

function hasExplicitProxySource(env = process.env) {
  const groups = [
    ...Object.values(PROXY_LIST_ENV_KEYS),
    ...Object.values(PROXY_LIST_FILE_ENV_KEYS),
  ];
  return groups.some((keys) => Boolean(resolveAnyEnv(env, keys)));
}

function isProxyDisabled(env = process.env) {
  const value = resolveAnyEnv(env, [
    "TILE_DOWNLOADER_NO_PROXY",
    "TILE_DOWNLOADER_DISABLE_PROXY",
    "NO_TILE_PROXY",
  ]).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function resolveProxyEnvironmentWithOptions(env = process.env, options = {}) {
  const auth = proxyAuthFromEnv(env);
  const defaultProxyFilePath =
    Object.prototype.hasOwnProperty.call(options, "defaultProxyFilePath") &&
    options.defaultProxyFilePath !== undefined
      ? options.defaultProxyFilePath
      : DEFAULT_PROXY_FILE;
  const defaultProxyList = hasExplicitProxySource(env)
    ? []
    : parseProxyList(readDefaultProxyFile(defaultProxyFilePath), auth);
  const all = [
    ...defaultProxyList,
    ...parseProxyList(resolveAnyEnv(env, PROXY_LIST_ENV_KEYS.ALL), auth),
    ...parseProxyList(readProxyListFile(env, PROXY_LIST_FILE_ENV_KEYS.ALL), auth),
  ];
  const http = [
    ...all,
    ...parseProxyList(resolveAnyEnv(env, PROXY_LIST_ENV_KEYS.HTTP), auth),
    ...parseProxyList(readProxyListFile(env, PROXY_LIST_FILE_ENV_KEYS.HTTP), auth),
  ];
  const https = [
    ...all,
    ...parseProxyList(resolveAnyEnv(env, PROXY_LIST_ENV_KEYS.HTTPS), auth),
    ...parseProxyList(readProxyListFile(env, PROXY_LIST_FILE_ENV_KEYS.HTTPS), auth),
  ];
  const dedupe = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const httpProxyList = dedupe(http);
  const httpsProxyList = dedupe(https);
  return {
    httpProxy: httpProxyList[0] || "",
    httpsProxy: httpsProxyList[0] || "",
    httpProxyList,
    httpsProxyList,
    noProxy: resolveAnyEnv(env, ["NO_PROXY", "no_proxy"]),
  };
}

function hasProxyEnvironment(proxyEnv) {
  return (
    Boolean(proxyEnv.httpProxy) ||
    Boolean(proxyEnv.httpsProxy) ||
    (proxyEnv.httpProxyList?.length ?? 0) > 0 ||
    (proxyEnv.httpsProxyList?.length ?? 0) > 0
  );
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

function buildProxyDispatcher(undici, proxyUrl, agentOptions, proxyEnv, protocol) {
  if (!proxyUrl) return null;
  const key = protocolKey(protocol);
  const proxyOption = key === "https" ? { httpsProxy: proxyUrl } : { httpProxy: proxyUrl };
  return new undici.EnvHttpProxyAgent({
    ...agentOptions,
    ...proxyOption,
    noProxy: proxyEnv.noProxy || undefined,
  });
}

function createProxyDispatcherCache(undici, agentOptions, proxyEnv) {
  const dispatchers = new Map();
  return function proxyDispatcher(proxyUrl, protocol) {
    const key = `${protocolKey(protocol) || "all"}\0${proxyUrl}`;
    let dispatcher = dispatchers.get(key);
    if (!dispatcher) {
      dispatcher = buildProxyDispatcher(undici, proxyUrl, agentOptions, proxyEnv, protocol);
      dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  };
}

function attachProxyInfo(target, info) {
  if (!target || typeof target !== "object") return;
  try {
    target[PROXY_INFO_SYMBOL] = info;
  } catch {
    // Metadata assignment is best-effort.
  }
}

function createProxyRotationState(proxyEnv, env = process.env) {
  const blockedUntil = { http: new Map(), https: new Map() };
  const nextIndex = { http: 0, https: 0 };
  const failureBlockMs = parseProxyFailureBlockMs(env);

  function candidatesByProtocol(protocol) {
    return protocolKey(protocol) === "https"
      ? proxyEnv.httpsProxyList || []
      : proxyEnv.httpProxyList || [];
  }

  function isBlocked(key, proxy) {
    const until = blockedUntil[key].get(proxy) || 0;
    if (until > Date.now()) return true;
    if (until) blockedUntil[key].delete(proxy);
    return false;
  }

  function pickProxy(protocol) {
    const key = protocolKey(protocol);
    const candidates = candidatesByProtocol(protocol);
    if (candidates.length === 0) return null;

    const start = nextIndex[key] % candidates.length;
    for (let offset = 0; offset < candidates.length; offset++) {
      const index = (start + offset) % candidates.length;
      const proxy = candidates[index];
      if (isBlocked(key, proxy)) continue;
      nextIndex[key] = (index + 1) % candidates.length;
      return proxy;
    }
    return null;
  }

  function markBlocked(protocolOrProxy, blockMs = failureBlockMs, proxyUrl = null) {
    const proxy = proxyUrl || protocolOrProxy;
    if (!proxy) return;
    const parsedKey = proxyUrl
      ? protocolKey(protocolOrProxy)
      : protocolKeyFromCandidate(protocolOrProxy);
    const keys = parsedKey ? [parsedKey] : ["http", "https"];
    const until = Date.now() + Math.max(1, Number(blockMs) || failureBlockMs);
    for (const key of keys) blockedUntil[key].set(proxy, until);
  }

  return {
    pickProxy,
    candidateCount(protocol) {
      return candidatesByProtocol(protocol).length;
    },
    hasHealthyCandidate(protocol) {
      const key = protocolKey(protocol);
      return candidatesByProtocol(protocol).some((proxy) => !isBlocked(key, proxy));
    },
    markProxySuccess() {},
    markProxyFailure(protocol, proxy) {
      if (proxy) markBlocked(protocol, failureBlockMs, proxy);
      return true;
    },
    markProxyBlocked: markBlocked,
  };
}

export function getPlatformKey(platform = process.platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  return "linux";
}

function providerConcurrencyCap(provider, env = process.env, options = {}) {
  const genericCap = parsePositiveInt(env.TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS);
  if (provider !== "esri") return genericCap;

  const esriCap = parsePositiveInt(env.TILE_DOWNLOADER_ESRI_MAX_CONCURRENCY);
  if (esriCap) return esriCap;
  return genericCap;
}

function providerRowsCap(provider, env = process.env) {
  const envRowsForEsri =
    parsePositiveInt(env.TILE_DOWNLOADER_ESRI_MAX_ROWS_IN_FLIGHT) ??
    parsePositiveInt(env.TILE_DOWNLOADER_MAX_ROWS_IN_FLIGHT);
  if (provider !== "esri") return parsePositiveInt(env.TILE_DOWNLOADER_MAX_ROWS_IN_FLIGHT);
  return envRowsForEsri;
}

export function buildPlatformProfile({
  platform = process.platform,
  cpuCount,
  requestedConcurrency,
  requestedRows,
  requestTimeoutMs,
  provider,
  env = process.env,
  defaultProxyFilePath,
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
  const platformCappedConcurrency = clamp(requested, 1, limits.maxConcurrentRequests);
  const providerCap = providerConcurrencyCap(provider, env, { defaultProxyFilePath });
  const maxConcurrentRequests = providerCap
    ? Math.min(platformCappedConcurrency, providerCap)
    : platformCappedConcurrency;

  const defaultRows = clamp(Math.ceil(cpus / 2), 1, limits.maxRowsInFlight);
  const requestedRowsOverride = parsePositiveInt(env.TILE_DOWNLOADER_MAX_ROWS_IN_FLIGHT);
  const requestedRowCount =
    requestedRowsOverride ?? parsePositiveInt(requestedRows) ?? defaultRows;
  const rowsCap = providerRowsCap(provider, env) ?? limits.maxRowsInFlight;
  const maxRowsInFlight = clamp(requestedRowCount, 1, rowsCap);
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

export async function configureNetworking(profile, env = process.env, runtime = {}) {
  dns.setDefaultResultOrder("ipv4first");

  try {
    const undici = runtime.undici || (await import("undici"));
    const targetGlobal = runtime.targetGlobal || globalThis;
    const agentOptions = buildAgentOptions(profile);
    const directAgent = new undici.Agent(agentOptions);
    undici.setGlobalDispatcher(directAgent);

    const baseFetch =
      runtime.fetchImpl ||
      targetGlobal[ORIGINAL_FETCH] ||
      targetGlobal.fetch?.bind(targetGlobal);
    if (typeof baseFetch !== "function") return null;

    const proxyEnv = resolveProxyEnvironment(env, {
      defaultProxyFilePath: runtime.defaultProxyFilePath,
    });
    if (!hasProxyEnvironment(proxyEnv) || typeof undici.EnvHttpProxyAgent !== "function") {
      if (targetGlobal[ORIGINAL_FETCH]) {
        targetGlobal.fetch = targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[WRAPPED_FETCH];
      }
      return null;
    }

    const proxyRotation = createProxyRotationState(proxyEnv, env);
    const proxyDispatcherFor = createProxyDispatcherCache(undici, agentOptions, proxyEnv);
    targetGlobal[ORIGINAL_FETCH] = baseFetch;
    targetGlobal.fetch = async (input, init = {}) => {
      const isRequest = typeof Request !== "undefined" && input instanceof Request;
      const url = isRequest ? input.url : String(input);
      if (init.dispatcher) return undici.fetch(input, init);

      if (shouldBypassProxy(url, proxyEnv.noProxy)) {
        return undici.fetch(input, {
          ...init,
          dispatcher: directAgent,
        });
      }

      const protocol = new URL(url).protocol;
      const fetchWithProxy = async () => {
        const maxProxyAttempts = parseProxyAttemptsPerRequest(
          env,
          proxyRotation.candidateCount?.(protocol) || 0
        );
        let lastError = null;
        for (let attempt = 0; attempt < maxProxyAttempts; attempt++) {
          const proxy = proxyRotation.pickProxy(protocol);
          if (!proxy) {
            if (lastError) throw lastError;
            throw new NoHealthyProxyError();
          }
          const dispatcher = proxyDispatcherFor(proxy, protocol);
          try {
            const response = await undici.fetch(input, {
              ...init,
              dispatcher,
            });
            attachProxyInfo(response, { proxy, protocol, url });
            return response;
          } catch (error) {
            proxyRotation.markProxyFailure(protocol, proxy, error);
            attachProxyInfo(error, { proxy, protocol, url, error: true });
            lastError = error;
          }
        }
        throw lastError || new NoHealthyProxyError();
      };

      if (proxyMode(env) === "always") return fetchWithProxy();

      let directResponse;
      try {
        directResponse = await undici.fetch(input, {
          ...init,
          dispatcher: directAgent,
        });
      } catch (error) {
        try {
          return await fetchWithProxy();
        } catch {
          throw error;
        }
      }
      if (!shouldFallbackToProxy(directResponse)) return directResponse;
      try {
        return await fetchWithProxy();
      } catch {
        return directResponse;
      }
    };
    targetGlobal[WRAPPED_FETCH] = true;
    return proxyRotation;
  } catch (error) {
    if (
      error instanceof NoHealthyProxyError ||
      error?.code === "NO_HEALTHY_PROXY" ||
      error?.code === "PROXY_CONFIG_ERROR"
    ) {
      throw error;
    }
    if (process.env.PROXY_DEBUG) {
      console.log(
        "proxy-debug: configureNetworking failure",
        error && error.message ? error.message : String(error)
      );
    }
    return null;
  }
}
