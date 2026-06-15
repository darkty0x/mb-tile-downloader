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
export const PROXY_INFO_SYMBOL = Symbol.for("tile-downloader.proxy-info");

const PROXY_SOURCE_ENV_KEYS = {
  URL: ["GEONODE_PROXY_LIST_URL", "TILE_DOWNLOADER_PROXY_LIST_URL", "PROXY_LIST_URL"],
  CACHE_PATH: [
    "GEONODE_PROXY_LIST_CACHE_PATH",
    "TILE_DOWNLOADER_PROXY_LIST_CACHE_PATH",
    "PROXY_LIST_CACHE_PATH",
  ],
  TTL_MS: ["GEONODE_PROXY_LIST_TTL_MS", "TILE_DOWNLOADER_PROXY_LIST_TTL_MS", "PROXY_LIST_TTL_MS"],
  RESPONSE_TIME_MS: [
    "GEONODE_PROXY_MAX_RESPONSE_TIME_MS",
    "TILE_DOWNLOADER_PROXY_MAX_RESPONSE_TIME_MS",
    "PROXY_MAX_RESPONSE_TIME_MS",
  ],
  BLACKLIST_PATH: [
    "GEONODE_PROXY_BLACKLIST_PATH",
    "TILE_DOWNLOADER_PROXY_BLACKLIST_PATH",
    "PROXY_BLACKLIST_PATH",
  ],
};

const DEFAULT_PROXY_LIST_CACHE_PATH = path.resolve(process.cwd(), ".tile-state", "proxy-list-cache.json");
const DEFAULT_PROXY_BLACKLIST_PATH = path.resolve(
  process.cwd(),
  ".tile-state",
  "proxy-blacklist.json"
);
const DEFAULT_PROXY_LIST_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PROXY_MAX_RESPONSE_TIME_MS = 100;
const DEFAULT_PROXY_LIST_MAX_PAGES = 5;
const DEFAULT_PROXY_FAILURE_BLOCK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROXY_FAILURE_THRESHOLD = 3;
const DEFAULT_PROXY_HEALTHCHECK_TIMEOUT_MS = 5_000;
const DEFAULT_PROXY_HEALTHCHECK_MAX_CANDIDATES = 80;
const DEFAULT_PROXY_LIST_URL =
  "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps";

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
  if (typeof value === "string") {
    value = value.trim();
    if (!value) return null;
  }
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

function hasAnyEnv(env, keys) {
  return keys.some((key) => {
    const value = env?.[key];
    return typeof value === "string" && Boolean(value.trim());
  });
}

function resolveProxyListSourceUrl(env = process.env) {
  return resolveAnyEnv(env, PROXY_SOURCE_ENV_KEYS.URL) || DEFAULT_PROXY_LIST_URL;
}

function resolveProxyBlacklistPath(env = process.env) {
  return (
    resolveAnyEnv(env, PROXY_SOURCE_ENV_KEYS.BLACKLIST_PATH) || DEFAULT_PROXY_BLACKLIST_PATH
  );
}

function protocolKeyFromCandidate(candidate) {
  if (candidate === "https:" || candidate === "https") return "https";
  if (candidate === "http:" || candidate === "http") return "http";
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? "https" : "http";
  } catch {
    return null;
  }
}

function buildPersistedProxyBlacklistPayload(failureState, now = Date.now()) {
  const proxies = [];
  for (const [protocol, entries] of Object.entries(failureState)) {
    for (const [proxy, entry] of entries) {
      if (!entry || !(entry.blockedUntil > now)) continue;
      const failures = Number.isFinite(entry.failures) ? Math.max(0, entry.failures | 0) : 0;
      const until = Number.isFinite(entry.until) ? entry.until : 0;
      proxies.push({
        proxy,
        protocol,
        blockedUntil: entry.blockedUntil,
        failures,
        until,
      });
    }
  }

  return {
    version: 1,
    updatedAt: now,
    proxies,
  };
}

async function loadPersistedProxyBlacklist(env = process.env, now = Date.now()) {
  const blacklistPath = resolveProxyBlacklistPath(env);
  try {
    const raw = await fsp.readFile(blacklistPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { http: [], https: [] };
    const result = { http: [], https: [] };
    if (!Array.isArray(parsed.proxies)) return result;

    for (const entry of parsed.proxies) {
      if (!entry || typeof entry !== "object") continue;
      const proxy = typeof entry.proxy === "string" ? entry.proxy.trim() : "";
      if (!proxy) continue;
      const blockedUntil = Number(entry.blockedUntil);
      if (!Number.isFinite(blockedUntil) || blockedUntil <= now) continue;
      const protocol = protocolKeyFromCandidate(entry.protocol || proxy);
      if (!protocol || !["http", "https"].includes(protocol)) continue;
      const failures = Number.isFinite(Number(entry.failures)) ? Number(entry.failures) : 0;
      const until = Number.isFinite(Number(entry.until)) ? Number(entry.until) : 0;
      result[protocol].push({ proxy, failures, until, blockedUntil });
    }
    return result;
  } catch {
    return { http: [], https: [] };
  }
}

async function writePersistedProxyBlacklist(env = process.env, failureState) {
  const blacklistPath = resolveProxyBlacklistPath(env);
  if (!blacklistPath) return;
  try {
    await fsp.mkdir(path.dirname(blacklistPath), { recursive: true });
    const payload = buildPersistedProxyBlacklistPayload(failureState);
    await fsp.writeFile(blacklistPath, JSON.stringify(payload), "utf8");
  } catch {
    // Shared blacklist writes should not prevent downloads.
  }
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

function toBlockedProxySet(persisted = { http: [], https: [] }) {
  const blocked = { http: new Set(), https: new Set() };
  for (const key of ["http", "https"]) {
    const entries = Array.isArray(persisted?.[key]) ? persisted[key] : [];
    for (const entry of entries) {
      const proxy = normalizeProxyEntry(typeof entry === "string" ? entry : entry?.proxy);
      if (!proxy) continue;
      blocked[key].add(proxy.toLowerCase());
    }
  }
  return blocked;
}

function filterBlockedProxies(splitProxies, blocked = { http: new Set(), https: new Set() }) {
  const blockedHttp = blocked.http instanceof Set ? blocked.http : new Set();
  const blockedHttps = blocked.https instanceof Set ? blocked.https : new Set();
  return {
    http: (splitProxies?.http || []).filter((proxy) => !blockedHttp.has(String(proxy).toLowerCase())),
    https: (splitProxies?.https || []).filter((proxy) => !blockedHttps.has(String(proxy).toLowerCase())),
  };
}

function mergeProxyLists(primary = [], fallback = []) {
  const merged = [...primary, ...fallback];
  const seen = new Set();
  const deduped = [];
  for (const item of merged) {
    const normalized = normalizeProxyEntry(item);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

function includeHttpTunnelProxiesForHttps(splitProxies) {
  const http = mergeProxyLists(splitProxies?.http || []);
  const https = mergeProxyLists(splitProxies?.https || [], http);
  return { http, https };
}

function hasProxyCandidates(splitProxies) {
  return (splitProxies?.http?.length || 0) > 0 || (splitProxies?.https?.length || 0) > 0;
}

async function validateProxySplit(splitProxies, options = {}) {
  if (typeof options.validateSplit !== "function") return splitProxies;
  return options.validateSplit(splitProxies);
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
    "latency",
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

function parseProxyFailureBlockMs(env = process.env) {
  return (
    parsePositiveInt(resolveAnyEnv(env, [
      "TILE_DOWNLOADER_PROXY_FAILURE_BLOCK_MS",
      "TILE_DOWNLOADER_ESRI_PROXY_BLOCK_MS",
      "PROXY_FAILURE_BLOCK_MS",
      "PROXY_BLOCK_MS",
    ])) || DEFAULT_PROXY_FAILURE_BLOCK_MS
  );
}

function parseProxyFailureThreshold(env = process.env) {
  return (
    parsePositiveInt(resolveAnyEnv(env, [
      "TILE_DOWNLOADER_PROXY_FAILURE_THRESHOLD",
      "PROXY_FAILURE_THRESHOLD",
    ])) || DEFAULT_PROXY_FAILURE_THRESHOLD
  );
}

function parseProxyMaxResponseTimeMs(env = process.env) {
  return (
    parsePositiveInt(resolveAnyEnv(env, PROXY_SOURCE_ENV_KEYS.RESPONSE_TIME_MS)) ||
    DEFAULT_PROXY_MAX_RESPONSE_TIME_MS
  );
}

function resolveMachineIdentifier(env = process.env) {
  const keys = [
    "MACHINE_NAME",
    "TILE_MACHINE_NAME",
    "CONFIG_NAME",
    "NAME",
    "HOSTNAME",
    "COMPUTERNAME",
  ];
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const first = trimmed.split(",")[0]?.trim();
    if (first) return first;
  }
  return "";
}

function isInvalidProxyFailure(error) {
  if (!error || typeof error !== "object") return false;
  const code = String(error.code || error.cause?.code || "").toUpperCase();
  const knownCodes = new Set([
    "ENOTFOUND",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_CONNECT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_NETWORK",
  ]);
  if (knownCodes.has(code)) return true;

  const message = String(error.message || "").toLowerCase();
  return [
    "enotfound",
    "econnrefused",
    "econnreset",
    "enetwork",
    "bad proxy",
    "socket hang up",
    "connect etimedout",
    "connection refused",
  ].some((needle) => message.includes(needle));
}

function shouldUseLatencyFilteredCandidate(
  candidate,
  maxResponseTimeMs = DEFAULT_PROXY_MAX_RESPONSE_TIME_MS
) {
  const parsedMs = parseResponseTimeMs(candidate);
  if (parsedMs === null) return true;
  return parsedMs < maxResponseTimeMs;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseFirstPositiveIntFromPayload(payload, names) {
  for (const name of names) {
    const value = parsePositiveInteger(payload?.[name]);
    if (value !== null) return value;
  }
  return null;
}

function buildProxyPageUrl(sourceUrl, page) {
  try {
    const url = new URL(sourceUrl);
    url.searchParams.set("page", String(page));
    return url.toString();
  } catch {
    const separator = sourceUrl.includes("?") ? "&" : "?";
    return `${sourceUrl}${separator}page=${page}`;
  }
}

function parseNextPageHint(payload, currentPage, defaultLimitHint) {
  if (!payload || typeof payload !== "object") return null;

  const boolHint = String(payload.hasMore).toLowerCase();
  if (boolHint === "true") return currentPage + 1;
  if (boolHint === "false") return null;
  const underscoreHint = String(payload.has_more).toLowerCase();
  if (underscoreHint === "true") return currentPage + 1;
  if (underscoreHint === "false") return null;

  const directNext = parseFirstPositiveIntFromPayload(payload, ["nextPage", "next_page"]);
  if (directNext !== null) return directNext;

  const pagination = payload.pagination;
  if (pagination && typeof pagination === "object") {
    const paginationPage = parseFirstPositiveIntFromPayload(pagination, [
      "page",
      "currentPage",
      "current_page",
      "current",
      "pageNo",
      "page_no",
    ]);
    const totalPages = parseFirstPositiveIntFromPayload(pagination, [
      "pageCount",
      "page_count",
      "pages",
      "totalPages",
      "total_pages",
    ]);
    if (paginationPage !== null && totalPages !== null && paginationPage < totalPages) return paginationPage + 1;
    if (pagination.hasMore === true || pagination.has_more === true) return currentPage + 1;
  }

  const page = parseFirstPositiveIntFromPayload(payload, [
    "page",
    "currentPage",
    "current_page",
    "current",
    "pageNo",
    "page_no",
  ]);
  const pageCount = parseFirstPositiveIntFromPayload(payload, [
    "pageCount",
    "page_count",
    "pages",
    "totalPages",
    "total_pages",
  ]);
  if (page !== null && pageCount !== null && page < pageCount) return page + 1;

  const total = parseFirstPositiveIntFromPayload(payload, [
    "total",
    "total_results",
    "totalResults",
    "results",
    "count",
    "total_count",
  ]);
  const limit = parseFirstPositiveIntFromPayload(payload, ["limit", "pageSize", "page_size"]) ?? defaultLimitHint;
  if (page !== null && limit !== null && total !== null && total > page * limit) return page + 1;

  if (pagination && typeof pagination?.next === "string") {
    try {
      return parsePositiveInteger(new URL(pagination.next).searchParams.get("page"));
    } catch {
      return null;
    }
  }

  return null;
}

function attachProxyInfo(target, info) {
  if (!target || typeof target !== "object") return;
  try {
    target[PROXY_INFO_SYMBOL] = info;
  } catch {
    // Metadata assignment is best-effort.
  }
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

async function loadProxyListFromApi(env, fetchImpl, options = {}) {
  const sourceUrl = resolveProxyListSourceUrl(env);
  if (!sourceUrl || !fetchImpl) return null;
  const maxResponseTimeMs = parsePositiveInt(options.maxResponseTimeMs) || DEFAULT_PROXY_MAX_RESPONSE_TIME_MS;
  const blockedProxySet =
    options.blockedProxySet ||
    toBlockedProxySet(options.persistedProxyBlacklist);
  const basePage = (() => {
    try {
      return parsePositiveInteger(new URL(sourceUrl).searchParams.get("page")) || 1;
    } catch {
      return 1;
    }
  })();
  const baseLimit = (() => {
    try {
      return parsePositiveInteger(new URL(sourceUrl).searchParams.get("limit"));
    } catch {
      return null;
    }
  })();
  const maxPages = parsePositiveInteger(
    resolveAnyEnv(env, [
      "GEONODE_PROXY_LIST_MAX_PAGES",
      "TILE_DOWNLOADER_PROXY_LIST_MAX_PAGES",
      "PROXY_LIST_MAX_PAGES",
    ])
  ) ?? DEFAULT_PROXY_LIST_MAX_PAGES;
  try {
    const visitedPages = new Set();
    let page = basePage;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (visitedPages.has(page)) break;
      visitedPages.add(page);

      const requestUrl = page === basePage ? sourceUrl : buildProxyPageUrl(sourceUrl, page);
      const response = await fetchImpl(requestUrl);
      if (!response || typeof response.ok !== "boolean" || !response.ok) return null;
      const body = await response.text();
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
      let parsedBody = null;
      const trimmedBody = body.trim();
      if (contentType.includes("json")) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          return null;
        }
      } else if (trimmedBody.startsWith("{") || trimmedBody.startsWith("[")) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          return null;
        }
      } else {
        return null;
      }

      const candidates = gatherProxyCandidatesFromPayload(parsedBody)
        .filter((candidate) => shouldUseLatencyFilteredCandidate(candidate, maxResponseTimeMs))
        .sort((a, b) => {
          const aMs = parseResponseTimeMs(a);
          const bMs = parseResponseTimeMs(b);
          const normalizedA = aMs === null ? Number.MAX_SAFE_INTEGER : aMs;
          const normalizedB = bMs === null ? Number.MAX_SAFE_INTEGER : bMs;
          return normalizedA - normalizedB;
        })
        .map((candidate) => normalizeProxyEntry(candidate))
        .filter(Boolean);
      const split = includeHttpTunnelProxiesForHttps(splitNormalizedProxiesByProtocol(candidates));
      const filteredSplit = filterBlockedProxies(split, blockedProxySet);
      const validatedSplit = await validateProxySplit(filteredSplit, options);
      if (hasProxyCandidates(validatedSplit)) {
        await writeCachedProxyList(env, validatedSplit);
        return validatedSplit;
      }

      const nextPage = parseNextPageHint(parsedBody, page, baseLimit);
      if (!nextPage) break;
      page = nextPage;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveProxyEnvironmentFromSource(proxyEnv, env = process.env, fetchImpl, options = {}) {
  const sourceUrl = resolveProxyListSourceUrl(env);
  if (!sourceUrl) return proxyEnv;

  const maxResponseTimeMs = parseProxyMaxResponseTimeMs(env);

  const persistedProxyBlacklist = await loadPersistedProxyBlacklist(env);
  const blockedProxySet = toBlockedProxySet(persistedProxyBlacklist);
  const explicitProxySplit = await validateProxySplit(filterBlockedProxies(
    includeHttpTunnelProxiesForHttps(
    {
      http: Array.isArray(proxyEnv?.httpProxyList) ? proxyEnv.httpProxyList : [],
      https: Array.isArray(proxyEnv?.httpsProxyList) ? proxyEnv.httpsProxyList : [],
    }),
    blockedProxySet
  ), options);
  if (hasProxyCandidates(explicitProxySplit)) {
    return {
      ...proxyEnv,
      httpProxyList: explicitProxySplit.http,
      httpsProxyList: explicitProxySplit.https,
      httpProxy: explicitProxySplit.http[0] || "",
      httpsProxy: explicitProxySplit.https[0] || "",
    };
  }

  const cached = await readCachedProxyList(env);
  const filteredCached = await validateProxySplit(filterBlockedProxies(
    includeHttpTunnelProxiesForHttps(
    {
      http: Array.isArray(cached?.http) ? cached.http : [],
      https: Array.isArray(cached?.https) ? cached.https : [],
    }),
    blockedProxySet
  ), options);
  if (hasProxyCandidates(filteredCached)) {
    return {
      ...proxyEnv,
      httpProxyList: filteredCached.http,
      httpsProxyList: filteredCached.https,
      httpProxy: filteredCached.http[0] || "",
      httpsProxy: filteredCached.https[0] || "",
    };
  }

  const apiSplit = await loadProxyListFromApi(env, fetchImpl, {
    maxResponseTimeMs,
    blockedProxySet,
    validateSplit: options.validateSplit,
  });
  const split = apiSplit || await validateProxySplit(filterBlockedProxies(
    includeHttpTunnelProxiesForHttps(await readCachedProxyList(env)),
    blockedProxySet
  ), options);
  const splitHttp = Array.isArray(split?.http) ? split.http : [];
  const splitHttps = Array.isArray(split?.https) ? split.https : [];

  if (splitHttp.length === 0 && splitHttps.length === 0) return proxyEnv;

  return {
    ...proxyEnv,
    httpProxyList: splitHttp,
    httpsProxyList: splitHttps,
    httpProxy: splitHttp[0] || "",
    httpsProxy: splitHttps[0] || "",
  };
}

function resolveProxyListFromEnv(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim()) return parseProxyList(value);
  }
  return [];
}

function providerConcurrencyCap(provider, env = process.env) {
  const genericCap = parsePositiveInt(env.TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS);
  if (provider !== "esri") return genericCap;

  const esriCap = parsePositiveInt(env.TILE_DOWNLOADER_ESRI_MAX_CONCURRENCY);
  return esriCap ?? genericCap ?? 64;
}

function providerRowsCap(provider, env = process.env) {
  const envRowsForEsri =
    parsePositiveInt(env.TILE_DOWNLOADER_ESRI_MAX_ROWS_IN_FLIGHT) ??
    parsePositiveInt(env.TILE_DOWNLOADER_MAX_ROWS_IN_FLIGHT);
  if (provider !== "esri") return parsePositiveInt(env.TILE_DOWNLOADER_MAX_ROWS_IN_FLIGHT);
  return envRowsForEsri;
}

export function resolveProxyEnvironment(env = process.env) {
  const explicitHttpProxyList = resolveProxyListFromEnv(env, PROXY_LIST_ENV_KEYS.HTTP);
  const explicitHttpsProxyList = resolveProxyListFromEnv(env, PROXY_LIST_ENV_KEYS.HTTPS);

  return {
    httpProxy: explicitHttpProxyList[0] || "",
    httpsProxy: explicitHttpsProxyList[0] || "",
    httpProxyList: explicitHttpProxyList,
    httpsProxyList: explicitHttpsProxyList,
    noProxy: "",
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

function resolveProxyHealthcheckUrl(env = process.env) {
  return resolveAnyEnv(env, [
    "TILE_DOWNLOADER_PROXY_HEALTHCHECK_URL",
    "GEONODE_PROXY_HEALTHCHECK_URL",
    "PROXY_HEALTHCHECK_URL",
  ]);
}

function proxyHealthcheckTimeoutMs(env = process.env) {
  return parsePositiveInt(resolveAnyEnv(env, [
    "TILE_DOWNLOADER_PROXY_HEALTHCHECK_TIMEOUT_MS",
    "GEONODE_PROXY_HEALTHCHECK_TIMEOUT_MS",
    "PROXY_HEALTHCHECK_TIMEOUT_MS",
  ])) ?? DEFAULT_PROXY_HEALTHCHECK_TIMEOUT_MS;
}

function proxyHealthcheckMaxCandidates(env = process.env) {
  return parsePositiveInt(resolveAnyEnv(env, [
    "TILE_DOWNLOADER_PROXY_HEALTHCHECK_MAX_CANDIDATES",
    "GEONODE_PROXY_HEALTHCHECK_MAX_CANDIDATES",
    "PROXY_HEALTHCHECK_MAX_CANDIDATES",
  ])) ?? DEFAULT_PROXY_HEALTHCHECK_MAX_CANDIDATES;
}

function isProxyHealthcheckResponseOk(response) {
  if (!response || !response.ok) return false;
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  return contentType.startsWith("image/") || contentType === "application/octet-stream";
}

async function filterProxyListByHealthcheck({
  undici,
  protocol,
  proxies,
  agentOptions,
  proxyEnv,
  healthcheckUrl,
  timeoutMs,
  maxCandidates,
}) {
  if (!healthcheckUrl || !Array.isArray(proxies) || proxies.length === 0) return proxies || [];

  const healthy = [];
  const candidates = proxies.slice(0, maxCandidates);
  for (const proxy of candidates) {
    const dispatcher = buildProxyDispatcher(undici, proxy, agentOptions, proxyEnv, protocol);
    if (!dispatcher) continue;
    try {
      const response = await undici.fetch(healthcheckUrl, {
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; tile-downloader/1.0; +https://www.arcgis.com)",
          accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
      if (isProxyHealthcheckResponseOk(response)) healthy.push(proxy);
      await response.body?.cancel?.().catch?.(() => {});
    } catch {
      // Candidate failed the real target check; skip it.
    }
  }
  return healthy;
}

async function filterProxyEnvironmentByHealthcheck({
  undici,
  proxyEnv,
  agentOptions,
  env,
}) {
  const healthcheckUrl = resolveProxyHealthcheckUrl(env);
  if (!healthcheckUrl) return proxyEnv;
  const timeoutMs = proxyHealthcheckTimeoutMs(env);
  const maxCandidates = proxyHealthcheckMaxCandidates(env);
  const healthcheckProtocol = (() => {
    try {
      return new URL(healthcheckUrl).protocol;
    } catch {
      return "https:";
    }
  })();

  const httpsProxyList = await filterProxyListByHealthcheck({
    undici,
    protocol: healthcheckProtocol === "http:" ? "http:" : "https:",
    proxies: proxyEnv.httpsProxyList,
    agentOptions,
    proxyEnv,
    healthcheckUrl,
    timeoutMs,
    maxCandidates,
  });
  const httpProxyList =
    healthcheckProtocol === "http:"
      ? httpsProxyList
      : (proxyEnv.httpProxyList || []).filter(
          (proxy) => !(proxyEnv.httpsProxyList || []).includes(proxy) || httpsProxyList.includes(proxy)
        );

  return {
    ...proxyEnv,
    httpProxyList,
    httpsProxyList,
    httpProxy: httpProxyList[0] || "",
    httpsProxy: httpsProxyList[0] || "",
  };
}

function createProxyRotationState(
  proxyEnv,
  persisted = { http: [], https: [] },
  persist = () => {},
  failureBlockMs = DEFAULT_PROXY_FAILURE_BLOCK_MS,
  env = process.env
) {
  const failureState = { http: new Map(), https: new Map() };
  const now = Date.now();
  for (const key of ["http", "https"]) {
    const list = Array.isArray(persisted?.[key]) ? persisted[key] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const proxy = typeof entry.proxy === "string" ? entry.proxy.trim() : "";
      const blockedUntil = Number(entry.blockedUntil);
      if (!proxy || !Number.isFinite(blockedUntil) || blockedUntil <= now) continue;
      failureState[key].set(proxy, {
        failures: Number.isFinite(Number(entry.failures)) ? Math.max(0, Math.floor(entry.failures)) : 0,
        until: Number.isFinite(Number(entry.until)) ? entry.until : 0,
        blockedUntil,
      });
    }
  }
  const maxConsecutiveFailures = parseProxyFailureThreshold(env);
  const failureWindowMs = 5 * 60_000;
  const normalizedFailureBlockMs = Math.max(1, parsePositiveInt(failureBlockMs) || DEFAULT_PROXY_FAILURE_BLOCK_MS);

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
    const now = Date.now();
    if (entry.blockedUntil && entry.blockedUntil > now) return false;
    if (entry.failures >= maxConsecutiveFailures && isFailureWindowActive(entry)) return false;
    return true;
  }

  function cleanupFailures(key) {
    const now = Date.now();
    for (const [candidate, entry] of failureState[key]) {
      if (
        (!entry.blockedUntil || entry.blockedUntil <= now) &&
        (!entry.until || entry.until <= now)
      ) {
        failureState[key].delete(candidate);
      }
    }
  }

  function pickProxy(protocol, proxyEnv) {
    const key = protocolKey(protocol);
    const candidates = candidatesByProtocol(protocol);
    if (candidates.length === 0) return null;

    cleanupFailures(key);

    const randomOffset = Math.floor(Math.random() * candidates.length);
    let index = randomOffset;
    if (Number.isNaN(index) || index < 0) index = 0;
    for (let offset = 0; offset < candidates.length; offset++) {
      const candidateIndex = (index + offset) % candidates.length;
      const candidate = candidates[candidateIndex];
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
    markProxyFailure(protocol, proxy, error = null) {
      const key = protocolKey(protocol);
      if (!proxy) return;
      const existing = failureState[key].get(proxy) || { failures: 0, until: 0, blockedUntil: 0 };
      const failures = existing.failures + 1;
      const shouldBlock = failures >= maxConsecutiveFailures || isInvalidProxyFailure(error);
      const blockedUntil =
        shouldBlock
          ? Math.max(existing.blockedUntil || 0, Date.now() + normalizedFailureBlockMs)
          : existing.blockedUntil;
      failureState[key].set(proxy, {
        failures,
        until: Date.now() + failureWindowMs,
        blockedUntil,
      });
      if (shouldBlock) {
        void persist(failureState);
        return true;
      }
      return false;
    },
    markProxyBlocked(protocolOrProxy, blockMs, proxyUrl = null) {
      const candidate = proxyUrl || protocolOrProxy;
      const parsedKey = proxyUrl
        ? protocolKey(protocolOrProxy)
        : protocolKeyFromCandidate(protocolOrProxy);
      const now = Date.now();
      const until = Number.isFinite(blockMs) ? now + blockMs : now;
      const keys = parsedKey ? [parsedKey] : ["http", "https"];
      for (const key of keys) {
        const keyState = failureState[key].get(candidate) || {
          failures: 0,
          until: 0,
          blockedUntil: 0,
        };
        keyState.blockedUntil = Math.max(keyState.blockedUntil || 0, until);
        keyState.failures = Math.max(keyState.failures, maxConsecutiveFailures);
        failureState[key].set(candidate, keyState);
      }
      void persist(failureState);
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

    const baseProxyEnv = resolveProxyEnvironment(env);
    const validateSplit = async (splitProxies) => {
      const checked = await filterProxyEnvironmentByHealthcheck({
        undici,
        proxyEnv: {
          httpProxy: splitProxies.http?.[0] || "",
          httpsProxy: splitProxies.https?.[0] || "",
          httpProxyList: splitProxies.http || [],
          httpsProxyList: splitProxies.https || [],
          noProxy: "",
        },
        agentOptions,
        env,
      });
      return {
        http: checked.httpProxyList || [],
        https: checked.httpsProxyList || [],
      };
    };
    const proxyEnv = await resolveProxyEnvironmentFromSource(
      baseProxyEnv,
      env,
      (input, init = {}) => runtime.fetchImpl ? runtime.fetchImpl(input, init) : baseFetch(input, init),
      { validateSplit }
    );

    if (process.env.PROXY_DEBUG) {
      console.log("proxy-debug: configureNetworking enter");
      console.log("proxy-debug: proxyEnv", proxyEnv);
      console.log("proxy-debug: hasProxy", hasProxyEnvironment(proxyEnv), "env", {
        hasHttpsProxy: Boolean(proxyEnv.httpsProxy),
        hasHttpsList: proxyEnv.httpsProxyList?.length,
        hasHttpList: proxyEnv.httpProxyList?.length,
      });
    }

    if (!hasProxyEnvironment(proxyEnv) || typeof undici.EnvHttpProxyAgent !== "function") {
      if (targetGlobal[ORIGINAL_FETCH]) {
        targetGlobal.fetch = targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[ORIGINAL_FETCH];
        delete targetGlobal[WRAPPED_FETCH];
      }
      return null;
    }

    const persistedProxyBlacklist = await loadPersistedProxyBlacklist(env);
    if (process.env.PROXY_DEBUG) console.log("proxy-debug: persisted", persistedProxyBlacklist);
    const proxyRotation = createProxyRotationState(
      proxyEnv,
      persistedProxyBlacklist,
      (failureState) => writePersistedProxyBlacklist(env, failureState),
      parseProxyFailureBlockMs(env),
      env
    );
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
          if (activeProxy) {
            proxyRotation.markProxySuccess(protocol, activeProxy);
            attachProxyInfo(response, {
              proxy: activeProxy,
              protocol,
              url,
            });
          }
          return response;
        },
        async (error) => {
          if (activeProxy) {
            proxyRotation.markProxyFailure(protocol, activeProxy, error);
          }
          attachProxyInfo(error, {
            proxy: activeProxy,
            protocol,
            url,
            error: true,
          });
          throw error;
        }
      );
    };
    targetGlobal[WRAPPED_FETCH] = true;
    return proxyRotation;
  } catch (error) {
    if (process.env.PROXY_DEBUG) {
      console.log(
        "proxy-debug: configureNetworking failure",
        error && error.message ? error.message : String(error)
      );
    }
    // Node fetch remains usable without undici installed as a dependency.
    return null;
  }
}
