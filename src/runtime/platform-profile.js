import dns from "node:dns";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

const ORIGINAL_FETCH = Symbol.for("tile-downloader.original-fetch");
const WRAPPED_FETCH = Symbol.for("tile-downloader.wrapped-fetch");

const PROXY_LIST_ENV_KEYS = {
  HTTP: ["GEONODE_HTTP_PROXY_LIST", "GEONODE_PROXY_LIST", "HTTP_PROXY_LIST", "HTTPS_PROXY_LIST"],
  HTTPS: ["GEONODE_HTTPS_PROXY_LIST", "GEONODE_PROXY_LIST", "HTTPS_PROXY_LIST", "HTTP_PROXY_LIST"],
};

const PROXY_SOURCE_ENV_KEYS = {
  URL: ["GEONODE_PROXY_LIST_URL", "TILE_DOWNLOADER_PROXY_LIST_URL", "PROXY_LIST_URL"],
  CACHE_PATH: [
    "GEONODE_PROXY_LIST_CACHE_PATH",
    "TILE_DOWNLOADER_PROXY_LIST_CACHE_PATH",
    "PROXY_LIST_CACHE_PATH",
  ],
  TTL_MS: ["GEONODE_PROXY_LIST_TTL_MS", "TILE_DOWNLOADER_PROXY_LIST_TTL_MS", "PROXY_LIST_TTL_MS"],
};

const DEFAULT_PROXY_LIST_CACHE_PATH = path.resolve(process.cwd(), ".tile-state", "proxy-list-cache.json");
const DEFAULT_PROXY_LIST_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PROXY_MAX_RESPONSE_TIME_MS = 100;
const DEFAULT_PROXY_LIST_URL =
  "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps&anonymityLevel=all&lastChecked=0&speed=all&responseTime=all&ports=80%2C443%2C8080%2C3128%2C1080&country=all&city=all&state=all&ssl=all&protocol=all";

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

function parseNonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function firstDefinedEnv(env, lowerKey, upperKey) {
  const lower = env?.[lowerKey];
  if (typeof lower === "string" && lower.trim()) return lower.trim();
  const upper = env?.[upperKey];
  if (typeof upper === "string" && upper.trim()) return upper.trim();
  return "";
}

function resolveAnyEnv(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function resolveProxyListSourceUrl(env = process.env) {
  return resolveAnyEnv(env, PROXY_SOURCE_ENV_KEYS.URL) || DEFAULT_PROXY_LIST_URL;
}

function parseProxyList(value) {
  if (typeof value !== "string") return [];
  const parsed = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const deduped = [];
  const seen = new Set();
  for (const item of parsed) {
    const lower = item.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    deduped.push(item);
  }
  return deduped;
}

function normalizeProxyEntry(candidate, fallbackProtocol = "http") {
  if (typeof candidate === "string") {
    const raw = candidate.trim();
    if (!raw) return "";
    const maybeUrl = raw.includes("://") ? raw : `${fallbackProtocol}://${raw}`;
    try {
      const parsed = new URL(maybeUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return "";
    }
  }

  if (!candidate || typeof candidate !== "object") return "";

  if (typeof candidate.proxy === "string") return normalizeProxyEntry(candidate.proxy);
  if (typeof candidate.url === "string") return normalizeProxyEntry(candidate.url);
  if (typeof candidate.endpoint === "string") return normalizeProxyEntry(candidate.endpoint);
  if (typeof candidate.server === "string") return normalizeProxyEntry(candidate.server);

  const ip = candidate.ip || candidate.host;
  const port = candidate.port || candidate.proxyPort;
  if (ip && port) {
    const protocolFromField = normalizeProtocolFromMetadata(candidate);
    return normalizeProxyEntry(`${protocolFromField}://${ip}:${port}`, protocolFromField);
  }

  return "";
}

function normalizeProtocolFromMetadata(candidate) {
  const protocol = typeof candidate.protocol === "string" ? candidate.protocol.toLowerCase() : "";
  if (protocol === "https" || protocol === "http") return protocol;

  if (typeof candidate.https === "boolean") return candidate.https ? "https" : "http";
  if (typeof candidate.http === "boolean") return candidate.http ? "http" : "https";

  if (Array.isArray(candidate.protocols)) {
    if (candidate.protocols.some((item) => String(item).toLowerCase() === "https")) return "https";
    if (candidate.protocols.some((item) => String(item).toLowerCase() === "http")) return "http";
  }

  return "http";
}

function parseResponseTimeMs(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const candidates = [
    "responseTime",
    "responseTimeMs",
    "responseTime_ms",
    "response_time",
    "response_time_ms",
    "responseTimeInMs",
    "latency",
    "latency_ms",
    "responseTimeMicros",
    "averageResponseTime",
    "average_response_time",
  ];
  for (const key of candidates) {
    const value = candidate[key];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number.parseFloat(String(value).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function shouldUseLatencyFilteredCandidate(candidate, maxResponseTimeMs = DEFAULT_PROXY_MAX_RESPONSE_TIME_MS) {
  const parsedMs = parseResponseTimeMs(candidate);
  if (parsedMs === null) return true;
  return parsedMs <= maxResponseTimeMs;
}

function gatherProxyCandidatesFromPayload(payload, out) {
  if (!out) out = [];
  if (!payload) return out;

  if (typeof payload === "string") {
    out.push(payload);
    return out;
  }

  if (!Array.isArray(payload) && typeof payload !== "object") {
    return out;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) gatherProxyCandidatesFromPayload(item, out);
    return out;
  }

  const arrayKeys = ["data", "results", "proxies", "proxyList", "proxy_list", "items"];
  for (const key of arrayKeys) {
    if (Array.isArray(payload[key])) {
      gatherProxyCandidatesFromPayload(payload[key], out);
    }
  }

  if (typeof payload.proxy === "string" || typeof payload.url === "string" || typeof payload.endpoint === "string") {
    out.push(payload);
  } else if ((payload.ip || payload.host) && (payload.port || payload.proxyPort)) {
    out.push(payload);
  }
  if (Array.isArray(payload.http)) {
    gatherProxyCandidatesFromPayload(payload.http, out);
  }
  if (Array.isArray(payload.https)) {
    gatherProxyCandidatesFromPayload(payload.https, out);
  }

  return out;
}

function splitNormalizedProxiesByProtocol(candidates) {
  const buckets = { http: [], https: [] };
  for (const candidate of candidates) {
    const parsed = normalizeProxyEntry(candidate);
    if (!parsed) continue;
    try {
      const protocol = new URL(parsed).protocol;
      if (protocol === "https:") buckets.https.push(parsed);
      else buckets.http.push(parsed);
    } catch {
      // ignored
    }
  }
  return buckets;
}

async function readCachedProxyList(env) {
  const cachePath =
    resolveAnyEnv(env, PROXY_SOURCE_ENV_KEYS.CACHE_PATH) || DEFAULT_PROXY_LIST_CACHE_PATH;
  const sourceUrl = resolveProxyListSourceUrl(env);
  if (!cachePath || !sourceUrl) return [];
  try {
    const raw = await fsp.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    if (parsed.sourceUrl && parsed.sourceUrl !== sourceUrl) return [];
    const expiresAt = Number(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return [];
    let rawCandidates = [];
    if (Array.isArray(parsed.proxies)) {
      rawCandidates = parsed.proxies;
    } else if (parsed.proxies && typeof parsed.proxies === "object") {
      const cachedBuckets = [];
      if (Array.isArray(parsed.proxies.http)) cachedBuckets.push(...parsed.proxies.http);
      if (Array.isArray(parsed.proxies.https)) cachedBuckets.push(...parsed.proxies.https);
      if (Array.isArray(parsed.proxies.proxies)) cachedBuckets.push(...parsed.proxies.proxies);
      if (Array.isArray(parsed.proxies.data)) cachedBuckets.push(...parsed.proxies.data);
      rawCandidates = cachedBuckets;
    }

    const candidates = gatherProxyCandidatesFromPayload(rawCandidates);
    const candidateList = candidates
      .map((candidate) => normalizeProxyEntry(candidate))
      .filter(Boolean);
    const split = splitNormalizedProxiesByProtocol(candidateList);
    return split;
  } catch {
    return [];
  }
}

async function writeCachedProxyList(env, splitProxies) {
  const cachePath = resolveAnyEnv(env, PROXY_SOURCE_ENV_KEYS.CACHE_PATH) || DEFAULT_PROXY_LIST_CACHE_PATH;
  if (!cachePath) return;
  const sourceUrl = resolveProxyListSourceUrl(env);
  if (!sourceUrl) return;
  const ttlMs =
    parseNonNegativeInt(resolveAnyEnv(env, PROXY_SOURCE_ENV_KEYS.TTL_MS)) ??
    DEFAULT_PROXY_LIST_TTL_MS;
  const expiresAt = Date.now() + ttlMs;
  try {
    const payload = {
      version: 1,
      sourceUrl,
      fetchedAt: Date.now(),
      expiresAt,
      proxies: {
        http: splitProxies.http,
        https: splitProxies.https,
      },
    };
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(payload), "utf8");
  } catch {
    // cache write failure should not block downloads
  }
}

async function loadProxyListFromApi(env, fetchImpl) {
  const sourceUrl = resolveProxyListSourceUrl(env);
  if (!sourceUrl || !fetchImpl) return null;
  try {
    const response = await fetchImpl(sourceUrl);
    if (!response || typeof response.ok !== "boolean" || !response.ok) return null;
    const body = await response.text();
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    let parsedBody = body;
    if (contentType.includes("json")) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        return null;
      }
    } else if (body.trim().startsWith("{") || body.trim().startsWith("[")) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }
    const candidates = gatherProxyCandidatesFromPayload(parsedBody)
      .filter((candidate) => shouldUseLatencyFilteredCandidate(candidate))
      .map((candidate) => normalizeProxyEntry(candidate))
      .filter(Boolean);
    const split = splitNormalizedProxiesByProtocol(candidates);
    if (split.http.length > 0 || split.https.length > 0) {
      await writeCachedProxyList(env, split);
      return split;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveProxyEnvironmentFromSource(proxyEnv, env = process.env, fetchImpl) {
  const sourceUrl = resolveProxyListSourceUrl(env);
  if (!sourceUrl) return proxyEnv;

  const apiSplit = await loadProxyListFromApi(env, fetchImpl);
  const split = apiSplit || (await readCachedProxyList(env));

  if (!split || (!split.http.length && !split.https.length)) return proxyEnv;

  return {
    ...proxyEnv,
    httpProxyList: split.http,
    httpsProxyList: split.https,
    httpProxy: split.http[0] || "",
    httpsProxy: split.https[0] || "",
  };
}

function resolveProxyListFromEnv(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim()) return parseProxyList(value);
  }
  return [];
}

function mergeProxyLists(primary, fallback) {
  const merged = [...primary, ...fallback];
  const seen = new Set();
  const deduped = [];
  for (const item of merged) {
    const key = String(item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function providerConcurrencyCap(provider, env = process.env) {
  if (provider !== "esri") return null;
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_MAX_CONCURRENCY) ?? 64;
}

export function resolveProxyEnvironment(env = process.env) {
  const httpProxy = firstDefinedEnv(env, "http_proxy", "HTTP_PROXY");
  const httpsProxy = firstDefinedEnv(env, "https_proxy", "HTTPS_PROXY");

  return {
    httpProxy,
    httpsProxy,
    httpProxyList: mergeProxyLists(
      resolveProxyListFromEnv(env, [
        ...PROXY_LIST_ENV_KEYS.HTTP,
        "http_proxy",
        "HTTP_PROXY",
      ]),
      parseProxyList(httpProxy)
    ),
    httpsProxyList: mergeProxyLists(
      resolveProxyListFromEnv(env, [
        ...PROXY_LIST_ENV_KEYS.HTTPS,
        "https_proxy",
        "HTTPS_PROXY",
      ]),
      parseProxyList(httpsProxy)
    ),
    noProxy: firstDefinedEnv(env, "no_proxy", "NO_PROXY"),
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
  if (protocol === "https:") {
    return new undici.EnvHttpProxyAgent({
      ...agentOptions,
      httpsProxy: proxyUrl,
      noProxy: proxyEnv.noProxy || undefined,
    });
  }
  return new undici.EnvHttpProxyAgent({
    ...agentOptions,
    httpProxy: proxyUrl,
    noProxy: proxyEnv.noProxy || undefined,
  });
}

function createProxyRotationState(proxyEnv) {
  const states = {
    http: 0,
    https: 0,
  };
  const failureState = {
    http: new Map(),
    https: new Map(),
  };
  const maxConsecutiveFailures = 3;
  const failureWindowMs = 5 * 60_000;

  function protocolKey(protocol) {
    return protocol === "https:" ? "https" : "http";
  }

  function candidatesByProtocol(protocol) {
    return protocolKey(protocol) === "https" ? proxyEnv.httpsProxyList : proxyEnv.httpProxyList;
  }

  function isFailureWindowActive(entry) {
    return entry && entry.until > Date.now();
  }

  function isHealthyCandidate(candidate, key) {
    const entry = failureState[key].get(candidate);
    if (!entry) return true;
    if (isFailureWindowActive(entry)) return false;
    return entry.failures < maxConsecutiveFailures;
  }

  function cleanupFailures(key) {
    for (const [candidate, entry] of failureState[key]) {
      if (!isFailureWindowActive(entry)) {
        failureState[key].delete(candidate);
      }
    }
  }

  function pickProxy(protocol, proxyEnv) {
    const key = protocolKey(protocol);
    const candidates = candidatesByProtocol(protocol);
    if (candidates.length === 0) return null;

    cleanupFailures(key);

    let index = states[key];
    for (let offset = 0; offset < candidates.length; offset++) {
      const candidate = candidates[index];
      index = (index + 1) % candidates.length;
      states[key] = index;
      if (isHealthyCandidate(candidate, key)) return candidate;
    }
    return null;
  }

  return {
    pickProxy(protocol, proxyEnv) {
      return pickProxy(protocol, proxyEnv);
    },
    hasHealthyCandidate(protocol, proxyEnv) {
      const key = protocolKey(protocol);
      cleanupFailures(key);
      const candidates = candidatesByProtocol(protocol);
      return candidates.some((candidate) => isHealthyCandidate(candidate, key));
    },
    markProxySuccess(protocol, proxy) {
      const key = protocolKey(protocol);
      if (!proxy) return;
      failureState[key].delete(proxy);
    },
    markProxyFailure(protocol, proxy) {
      const key = protocolKey(protocol);
      if (!proxy) return;
      const existing = failureState[key].get(proxy) || { failures: 0, until: 0 };
      const failures = existing.failures + 1;
      failureState[key].set(proxy, {
        failures,
        until: Date.now() + failureWindowMs,
      });
      if (failures >= maxConsecutiveFailures) {
        return true;
      }
      return false;
    },
    buildDispatcherFor(undici, protocol, agentOptions, proxyUrl, proxyEnv, directAgent) {
      if (!proxyUrl) return directAgent;
      const protocolSpecific = buildProxyDispatcher(
        undici,
        proxyUrl,
        agentOptions,
        proxyEnv,
        protocol
      );
      return protocolSpecific || directAgent;
    },
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

    const baseFetch =
      runtime.fetchImpl ||
      targetGlobal[ORIGINAL_FETCH] ||
      targetGlobal.fetch?.bind(targetGlobal);
    if (typeof baseFetch !== "function") return;

    const proxyEnv = await resolveProxyEnvironmentFromSource(
      resolveProxyEnvironment(env),
      env,
      (input, init = {}) => runtime.fetchImpl ? runtime.fetchImpl(input, init) : baseFetch(input, init)
    );

    if (!hasProxyEnvironment(proxyEnv) || typeof undici.EnvHttpProxyAgent !== "function") {
      if (targetGlobal[ORIGINAL_FETCH]) {
        targetGlobal.fetch = targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[WRAPPED_FETCH];
      }
      return;
    }

    const proxyRotation = createProxyRotationState(proxyEnv);
    targetGlobal[ORIGINAL_FETCH] = baseFetch;
    targetGlobal.fetch = async (input, init = {}) => {
      const isRequest =
        typeof Request !== "undefined" && input instanceof Request;
      const url = isRequest ? input.url : String(input);
      if (init.dispatcher) return undici.fetch(input, init);

      if (shouldBypassProxy(url, proxyEnv.noProxy)) {
        return undici.fetch(input, {
          ...init,
          dispatcher: directAgent,
        });
      }

      const protocol = new URL(url).protocol;
      const proxy = proxyRotation.pickProxy(protocol, proxyEnv);
      const dispatcher = proxyRotation.buildDispatcherFor(
        undici,
        protocol,
        agentOptions,
        proxy,
        proxyEnv,
        directAgent
      );
      const activeProxy = dispatcher === directAgent ? null : proxy;
      return undici.fetch(input, {
        ...init,
        dispatcher: init.dispatcher || dispatcher,
      }).then(
        (response) => {
          if (activeProxy) proxyRotation.markProxySuccess(protocol, activeProxy);
          return response;
        },
        async (error) => {
          if (activeProxy) {
            const wasBlacklisted = proxyRotation.markProxyFailure(protocol, activeProxy);
            if (wasBlacklisted && !proxyRotation.hasHealthyCandidate(protocol, proxyEnv)) {
              return undici.fetch(input, {
                ...init,
                dispatcher: directAgent,
              });
            }
          }
          throw error;
        }
      );
    };
    targetGlobal[WRAPPED_FETCH] = true;
  } catch {
    // Node fetch remains usable without undici installed as a dependency.
  }
}
