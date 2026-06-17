import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { MapboxTokenPool, loadMapboxTokensFromEnv } from "../auth/mapbox-token-pool.js";
import { createProvider } from "../providers/index.js";
import { selectOutputRoot } from "../runtime/output-storage.js";
import { PROXY_INFO_SYMBOL } from "../runtime/platform-profile.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function tileRetryFloor(providerName) {
  if (providerName === "esri") {
    return parsePositiveInt(process.env.TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES) ?? 3;
  }
  return parsePositiveInt(process.env.TILE_DOWNLOADER_MIN_TILE_RETRIES) ?? 10;
}

const ESRI_DEFAULT_ROW_RECOVERY_PASSES = 1;
const MAPBOX_DEFAULT_ROW_RECOVERY_PASSES = 4;

function resolveRowRecoveryPasses(provider = "esri", override, config = {}, esriFastMode = false) {
  if (override === null || override === undefined) {
    if (provider === "esri" && esriFastMode) return 0;
    const configuredFromConfig = parseNonNegativeInt(config.performance?.rowRecoveryPasses);
    if (configuredFromConfig !== null) return configuredFromConfig;
    const envKey =
      provider === "esri"
        ? "TILE_DOWNLOADER_ESRI_ROW_RECOVERY_PASSES"
        : "TILE_DOWNLOADER_ROW_RECOVERY_PASSES";
    const configured = parseNonNegativeInt(process.env[envKey]);
    if (configured !== null) return configured;
    return provider === "esri" ? ESRI_DEFAULT_ROW_RECOVERY_PASSES : MAPBOX_DEFAULT_ROW_RECOVERY_PASSES;
  }
  const parsed = parseNonNegativeInt(override);
  if (parsed !== null) return parsed;
  throw new Error("rowRecoveryPasses must be a non-negative integer");
}

function resolveRecoveryBackoffMs(provider = "esri", explicit, config = {}) {
  if (explicit !== null && explicit !== undefined) {
    const parsed = parsePositiveInt(explicit);
    if (parsed === null) throw new Error("recoveryBackoffMs must be a positive integer");
    return parsed;
  }

  const configured = parsePositiveInt(config.performance?.recoveryBackoffMs);
  if (configured !== null) return configured;
  if (provider === "esri") {
    const esriConfigured = parsePositiveInt(process.env.TILE_DOWNLOADER_ESRI_RECOVERY_BACKOFF_MS);
    if (esriConfigured !== null) return esriConfigured;
  }
  const genericConfigured = parsePositiveInt(process.env.TILE_DOWNLOADER_RECOVERY_BACKOFF_MS);
  if (genericConfigured !== null) return genericConfigured;
  return parsePositiveInt(config.performance?.retryBackoffMs) || 150;
}

function retryDelayMs(baseMs, attempt) {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 30_000);
  const jitter = Math.floor(Math.random() * Math.min(baseMs, 1_000));
  return exponential + jitter;
}

function esriBlockThreshold(env = process.env) {
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_BLOCK_THRESHOLD) ?? 3;
}

function esriProxyBlockThreshold(env = process.env) {
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_PROXY_BLOCK_THRESHOLD) ?? 1;
}

function esriCooldownMs(env = process.env) {
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_COOLDOWN_MS) ?? 10 * 60 * 1000;
}

function esriBlockWindowMs(env = process.env) {
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_BLOCK_WINDOW_MS) ?? 60 * 1000;
}

function esriProxyBlockMs(env = process.env) {
  return parsePositiveInt(env.TILE_DOWNLOADER_ESRI_PROXY_BLOCK_MS) ?? 24 * 60 * 60 * 1000;
}

function esriCooldownEnabled(env = process.env) {
  const explicit = parseBoolean(env.TILE_DOWNLOADER_ESRI_ENABLE_COOLDOWN);
  return explicit ?? true;
}

function proxyTransportRetryLimit(providerName, env = process.env) {
  if (providerName !== "esri") return 0;
  return (
    parsePositiveInt(env.TILE_DOWNLOADER_ESRI_PROXY_TRANSPORT_RETRIES) ??
    parsePositiveInt(env.TILE_DOWNLOADER_PROXY_TRANSPORT_RETRIES) ??
    64
  );
}

function proxyTransportRetryDelayMs(baseMs, attempt) {
  return Math.min(retryDelayMs(baseMs, attempt), 1_000);
}

function traceEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(
    String(env?.TILE_DOWNLOADER_PROXY_TRACE || env?.PROXY_TRACE || env?.PROXY_DEBUG || "").trim().toLowerCase()
  );
}

function traceEvent(env, event, fields = {}) {
  if (!traceEnabled(env)) return;
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
    .join(" ");
  console.log(`proxy-trace: ${event}${suffix ? ` ${suffix}` : ""}`);
}

function describeTraceUrl(urlLike) {
  try {
    const url = new URL(String(urlLike));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(urlLike || "").split("?")[0];
  }
}

function proxyValueHash(proxy) {
  return crypto.createHash("sha256").update(String(proxy || "").trim()).digest("hex");
}

function normalizeProxyProtocol(candidate) {
  if (typeof candidate !== "string") return "";
  const normalized = candidate.trim();
  if (!normalized) return "";
  if (normalized === "http" || normalized === "https") return `${normalized}:`;
  if (normalized.endsWith(":")) {
    const lowered = normalized.toLowerCase();
    return lowered === "http:" || lowered === "https:" ? lowered : "";
  }
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "https:" ? "https:" : parsed.protocol === "http:" ? "http:" : "";
  } catch {
    return "";
  }
}

function createProgressReporter(enabled) {
  if (!enabled) {
    return {
      rangeStart() {},
      rowDone() {},
      rowRetry() {},
      providerBlocked() {},
      verifyStart() {},
      verifyProgress() {},
      rangeVerified() {},
    };
  }

  const startedAt = Date.now();
  let lastLineAt = 0;
  let currentRangeStartedAt = startedAt;
  let lastRowsDone = 0;
  let lastTilesDone = 0;
  let lastRateAt = startedAt;
  let proxyBlockLogCount = 0;
  let directBlockLogCount = 0;

  function seconds(ms) {
    return Math.max(ms / 1000, 0.001);
  }

  function formatDuration(secondsValue) {
    if (!Number.isFinite(secondsValue) || secondsValue < 0) return "unknown";
    const totalSeconds = Math.max(0, Math.round(secondsValue));
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const secondsPart = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || parts.length) parts.push(`${hours}h`);
    if (minutes || parts.length) parts.push(`${minutes}m`);
    parts.push(`${secondsPart}s`);
    return parts.join(" ");
  }

  function line(message, force = false) {
    const now = Date.now();
    if (!force && now - lastLineAt < 1000) return;
    lastLineAt = now;
    console.log(message);
  }

  return {
    rangeStart({ rangeIndex, rangeCount, range, rows, tiles }) {
      currentRangeStartedAt = Date.now();
      lastRowsDone = 0;
      lastTilesDone = 0;
      lastRateAt = currentRangeStartedAt;
      line(
        `▶ Range ${rangeIndex}/${rangeCount}: ${range.label || "unnamed"} rows=${rows} tiles=${tiles}`,
        true
      );
    },
    rowDone({ rangeIndex, rangeCount, rowsDone, rowsTotal, tilesDone, tilesTotal, totals, current }) {
      const now = Date.now();
      const intervalSec = seconds(now - lastRateAt);
      const rowRate = (rowsDone - lastRowsDone) / intervalSec;
      const tileRate = (tilesDone - lastTilesDone) / intervalSec;
      const elapsedSec = seconds(now - currentRangeStartedAt);
      const averageTileRate = tilesDone / elapsedSec;
      const etaSec = averageTileRate > 0 ? (tilesTotal - tilesDone) / averageTileRate : Infinity;
      lastRowsDone = rowsDone;
      lastTilesDone = tilesDone;
      lastRateAt = now;
      line(
        `  ↳ range ${rangeIndex}/${rangeCount} row ${rowsDone}/${rowsTotal} z=${current.z} x=${current.x} ` +
          `tiles ${tilesDone}/${tilesTotal} d=${totals.tilesDownloaded} s=${totals.tileFilesSkipped} ` +
          `m=${totals.tilesMissing} f=${totals.tilesFailed} skippedRows=${totals.rowsSkipped} ` +
          `rate=${rowRate.toFixed(1)} rows/s ${tileRate.toFixed(1)} tiles/s eta=${formatDuration(etaSec)}`,
        rowsDone === rowsTotal
      );
    },
    rowRetry({ rangeIndex, rangeCount, z, x, failed, pass, maxPasses }) {
      line(
        `  ↻ range ${rangeIndex}/${rangeCount} z=${z} x=${x} retrying ${failed} failed tiles pass=${pass}/${maxPasses}`,
        true
      );
    },
    providerBlocked({ provider, status, count, threshold, cooldownMs, proxy, proxyHash, healthyProxies, totalProxies }) {
      if (proxy) {
        proxyBlockLogCount++;
        const remaining = Number.isInteger(healthyProxies) ? healthyProxies : null;
        const total = Number.isInteger(totalProxies) ? totalProxies : null;
        if (remaining !== 0 && proxyBlockLogCount > 5 && proxyBlockLogCount % 25 !== 0) return;
        if (proxyHash) {
          console.log(
            `[event] ${JSON.stringify({
              severity: "warn",
              type: "proxy.blocked",
              message: `${provider} proxy blocked by provider`,
              data: {
                provider,
                providerStatus: status,
                proxyHash,
                status: "error",
                cooldownMs,
              },
            })}`
          );
        }
        const pool = remaining !== null && total !== null ? ` remaining=${remaining}/${total}` : "";
        line(
          `  ⏸ ${provider} proxy blocked status=${status} hits=${count}/${threshold}${pool} cooldown=${Math.round(
            cooldownMs / 1000
          )}s`,
          true
        );
        return;
      }
      directBlockLogCount++;
      if (directBlockLogCount > 5 && count % 25 !== 0) return;
      line(
        `  ⏸ ${provider} temporary block detected status=${status} hits=${count}/${threshold} cooldown=${Math.round(
          cooldownMs / 1000
        )}s`,
        true
      );
    },
    verifyStart({ rangeIndex, rangeCount, rows, tiles }) {
      line(`  🔍 verifying range ${rangeIndex}/${rangeCount} rows=${rows} tiles=${tiles}`, true);
    },
    verifyProgress({ rangeIndex, rangeCount, rowsDone, rowsTotal, present, missing, failed = 0 }) {
      line(
        `  🔍 range ${rangeIndex}/${rangeCount} verify rows=${rowsDone}/${rowsTotal} present=${present} missing=${missing} failed=${failed}`
      );
    },
    rangeVerified({ rangeIndex, rangeCount, verified }) {
      const elapsed = seconds(Date.now() - currentRangeStartedAt);
      const status =
        verified.failed > 0 ? "red" : verified.missing > 0 ? "yellow" : "green";
      line(
        `  ✔ range ${rangeIndex}/${rangeCount} verified present=${verified.present}/${verified.expected} missing=${verified.missing} failed=${verified.failed} status=${status} elapsed=${elapsed.toFixed(1)}s`,
        true
      );
    },
  };
}

function createProviderRuntime({
  providerName,
  env = process.env,
  sleepImpl = sleep,
  progress,
  proxyRotation,
}) {
  if (providerName !== "esri" || !esriCooldownEnabled(env)) {
    return {
      async waitIfBlocked() {},
      noteResponse() {
        return false;
      },
      noteSuccess() {},
    };
  }

  const threshold = esriBlockThreshold(env);
  const proxyThreshold = esriProxyBlockThreshold(env);
  const cooldownMs = esriCooldownMs(env);
  const windowMs = esriBlockWindowMs(env);
  const proxyBlockMs = esriProxyBlockMs(env);
  let blockedUntil = 0;
  const recentBlocks = [];
  const perProxyBlocks = new Map();

  function pruneProxyState(entry, now) {
    if (!entry) return;
    while (entry.attempts.length > 0 && now - entry.attempts[0] > windowMs) {
      entry.attempts.shift();
    }
    if (entry.blockedUntil && entry.blockedUntil <= now) {
      entry.blockedUntil = 0;
      entry.attempts = [];
    }
  }

  function hasHealthyCandidateFor(protocolOrProxy) {
    if (!proxyRotation?.hasHealthyCandidate) return true;
    const protocol = normalizeProxyProtocol(protocolOrProxy);
    if (!protocol) return true;
    return proxyRotation.hasHealthyCandidate(protocol);
  }

  function prune(now) {
    while (recentBlocks.length > 0 && now - recentBlocks[0].at > windowMs) {
      recentBlocks.shift();
    }
  }

  return {
    async waitIfBlocked() {
      const now = Date.now();
      if (blockedUntil <= now) return;
      await sleepImpl(blockedUntil - now);
    },
    noteResponse(status, proxy = null, protocol = null) {
      if (status !== 403 && status !== 429) return false;
      const now = Date.now();
      const wasBlocked = blockedUntil > now;
      if (!proxy) {
        prune(now);
        recentBlocks.push({ at: now, status });
        if (recentBlocks.length < threshold) return false;
        const nextBlockedUntil = now + cooldownMs;
        if (nextBlockedUntil > blockedUntil) {
          blockedUntil = nextBlockedUntil;
          progress.providerBlocked({
            provider: providerName,
            status,
            count: recentBlocks.length,
            threshold,
            cooldownMs,
          });
        }
        return true;
      }

      const key = String(proxy);
      const entry = perProxyBlocks.get(key) || { attempts: [], blockedUntil: 0 };
      pruneProxyState(entry, now);
      if (entry.blockedUntil > now) {
        const healthyCandidateProtocol = protocol || proxy;
        const globalBlock = !hasHealthyCandidateFor(healthyCandidateProtocol);
        if (globalBlock && !wasBlocked) blockedUntil = Math.max(blockedUntil, entry.blockedUntil);
        if (globalBlock && entry.blockedUntil > blockedUntil) blockedUntil = entry.blockedUntil;
        perProxyBlocks.set(key, entry);
        return globalBlock;
      }

      entry.attempts.push(now);
      const shouldBanProxy = entry.attempts.length >= proxyThreshold;
      if (!shouldBanProxy) {
        perProxyBlocks.set(key, entry);
        return false;
      }

      const failedAttempts = entry.attempts.length;
      entry.attempts = [];
      entry.blockedUntil = Math.max(entry.blockedUntil || 0, now + proxyBlockMs);
      if (proxyRotation?.markProxyBlocked) proxyRotation.markProxyBlocked(protocol || proxy, proxyBlockMs, proxy);
      const healthyCandidateProtocol = protocol || proxy;
      const globalBlock = !hasHealthyCandidateFor(healthyCandidateProtocol);
      if (globalBlock) {
        const nextBlockedUntil = entry.blockedUntil;
        if (nextBlockedUntil > blockedUntil) blockedUntil = nextBlockedUntil;
      }
      perProxyBlocks.set(key, entry);
      progress.providerBlocked({
        provider: providerName,
        status,
        count: failedAttempts,
        threshold: proxyThreshold,
        proxy,
        proxyHash: proxyValueHash(proxy),
        healthyProxies: proxyRotation?.healthyCandidateCount?.(protocol || proxy),
        totalProxies: proxyRotation?.candidateCount?.(protocol || proxy),
        cooldownMs: globalBlock ? cooldownMs : proxyBlockMs,
      });
      return globalBlock;
    },
    noteSuccess() {
      recentBlocks.length = 0;
    },
  };
}

function renderPath(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) {
      throw new Error(`Missing path template value: ${key}`);
    }
    return String(values[key]);
  });
}

function tilePath(config, provider, z, x, y) {
  const rel = renderPath(config.output.pathTemplate, {
    provider: config.provider,
    layer: config.layer,
    format: config.format,
    extension: provider.extension,
    z,
    x,
    y,
  });
  const normalized = path.normalize(rel);
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`output path template escapes output directory: ${rel}`);
  }
  return path.join(selectOutputRoot(config.output, { z, x, y }), normalized);
}

async function existsNonZero(filePath, provider = null) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile() || st.size <= 0) return false;
    if (provider?.isUnavailable) {
      const buffer = await fsp.readFile(filePath);
      if (provider.isUnavailable(buffer)) {
        await fsp.rm(filePath, { force: true });
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function removeStaleTempFiles(finalPath) {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }

  await Promise.all(
    names
      .filter((name) => name.startsWith(`${base}.tmp-`))
      .map((name) => fsp.rm(path.join(dir, name), { force: true }))
  );
}

async function writeResponse(resp, tmpPath) {
  if (!resp.body) throw new Error("empty response body");
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(tmpPath));
}

async function readResponseBuffer(resp) {
  if (!resp.arrayBuffer) return Buffer.alloc(0);
  return Buffer.from(await resp.arrayBuffer());
}

async function downloadOneTile({
  config,
  provider,
  providerRuntime,
  tokenPool,
  fetchImpl,
  sleepImpl,
  env,
  z,
  x,
  y,
}) {
  const finalPath = tilePath(config, provider, z, x, y);
  if (await existsNonZero(finalPath, provider)) return "skipped";

  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await removeStaleTempFiles(finalPath);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  const maxRetries = Math.max(
    tileRetryFloor(provider.name),
    Number(config.performance?.maxRetries || 3)
  );
  const maxProxyTransportRetries = proxyTransportRetryLimit(provider.name, env);
  const backoffMs = Math.max(1, Number(config.performance?.retryBackoffMs || 150));
  const timeoutMs = Math.max(1000, Number(config.platformProfile?.requestTimeoutMs || 25_000));
  let lastUnavailableTile = null;
  let proxyTransportAttempts = 0;

  let networkAttempt = 0;
  let requestAttempt = 0;
  while (networkAttempt < maxRetries) {
    try {
      await providerRuntime.waitIfBlocked();
      await fsp.rm(tmpPath, { force: true });
      const tokenUsed = tokenPool ? tokenPool.current() : null;
      const attempt = requestAttempt;
      requestAttempt++;
      const url = provider.buildUrl({
        z,
        x,
        y,
        tokenPool: tokenPool || { current: () => tokenUsed },
        token: tokenUsed,
        attempt,
      });
      const resp = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers:
          provider.name === "esri"
            ? {
                "user-agent":
                  "Mozilla/5.0 (compatible; tile-downloader/1.0; +https://www.arcgis.com)",
                accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
              }
            : undefined,
      });
      const proxy = resp?.[PROXY_INFO_SYMBOL]?.proxy || null;
      const protocol = resp?.[PROXY_INFO_SYMBOL]?.protocol || null;
      const classified = provider.classifyResponse(resp);

      if (classified.status === "token-invalid" || classified.status === "token-exhausted") {
        tokenPool.markTokenUnusable(
          tokenUsed,
          classified.status === "token-invalid" ? "invalid" : "exhausted",
          `HTTP ${resp.status}`
        );
        tokenPool.current();
        continue;
      }
      if (classified.status === "missing") return "missing";
      if (classified.status === "retry") {
        const blocked = provider.name === "esri" && providerRuntime.noteResponse(resp.status, proxy, protocol);
        if (blocked) return "blocked";
        networkAttempt++;
        if (networkAttempt < maxRetries) await sleepImpl(retryDelayMs(backoffMs, networkAttempt));
        continue;
      }
      if (classified.status === "fatal") return "failed";

      if (provider.isUnavailable) {
        const buffer = await readResponseBuffer(resp);
        if (provider.isUnavailable(buffer)) {
          lastUnavailableTile = {
            url,
            proxy,
            bytes: buffer.length,
            sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
          };
          traceEvent(env, "tile-unavailable-placeholder", {
            provider: provider.name,
            proxy: proxy || "direct",
            bytes: lastUnavailableTile.bytes,
            sha256: lastUnavailableTile.sha256,
            url: describeTraceUrl(url),
          });
          return "missing";
        }
        await fsp.writeFile(tmpPath, buffer);
      } else {
        await writeResponse(resp, tmpPath);
      }

      const st = await fsp.stat(tmpPath);
      if (!st.isFile() || st.size === 0) throw new Error("empty tile");
      await fsp.rename(tmpPath, finalPath);
      providerRuntime.noteSuccess();
      return "downloaded";
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (/All Mapbox access tokens/.test(String(err?.message))) throw err;
      const proxyInfo = err?.[PROXY_INFO_SYMBOL] || null;
      if (
        provider.name === "esri" &&
        maxProxyTransportRetries > 0 &&
        (proxyInfo?.proxy || err?.code === "NO_HEALTHY_PROXY") &&
        proxyTransportAttempts < maxProxyTransportRetries
      ) {
        proxyTransportAttempts++;
        await sleepImpl(proxyTransportRetryDelayMs(backoffMs, proxyTransportAttempts));
        continue;
      }
      networkAttempt++;
      if (networkAttempt < maxRetries) await sleepImpl(retryDelayMs(backoffMs, networkAttempt));
    }
  }

  if (lastUnavailableTile) {
    traceEvent(env, "tile-unavailable-exhausted", {
      provider: provider.name,
      proxy: lastUnavailableTile.proxy || "direct",
      bytes: lastUnavailableTile.bytes,
      sha256: lastUnavailableTile.sha256,
      url: describeTraceUrl(lastUnavailableTile.url),
    });
    return "missing";
  }

  return "failed";
}

async function processRow({
  config,
  provider,
  providerRuntime,
  tokenPool,
  stateDb,
  fetchImpl,
  sleepImpl,
  env,
  forceVerify,
  rowRecoveryPasses,
  recoveryBackoffMs,
  esriFastMode = false,
  progress,
  rangeIndex,
  rangeCount,
  z,
  x,
  yStart,
  yEnd,
}) {
  const key = {
    jobName: config.jobName,
    configHash: config.configHash,
    layer: config.layer,
    z,
    x,
    yStart,
    yEnd,
  };
  const expected = yEnd - yStart + 1;
  const existingRow = stateDb.getRow(key);
  if (!forceVerify && stateDb.shouldSkipRow(key)) {
    return {
      skipped: true,
      expected,
      downloaded: 0,
      created: 0,
      skippedFiles: existingRow?.downloaded ?? Math.max(0, expected - (existingRow?.missing || 0)),
      missing: existingRow?.missing || 0,
      failed: 0,
    };
  }

  let downloaded = 0;
  let created = 0;
  let skippedFiles = 0;
  let missing = 0;
  const pending = new Set();
  for (let y = yStart; y <= yEnd; y++) pending.add(y);

  const maxRecoveryPasses = resolveRowRecoveryPasses(
    config.provider,
    rowRecoveryPasses,
    config,
    esriFastMode
  );
  const recoveryDelay = resolveRecoveryBackoffMs(config.provider, recoveryBackoffMs, config);
  for (let pass = 0; pass <= maxRecoveryPasses && pending.size > 0; pass++) {
    if (pass > 0) {
      progress.rowRetry({
        rangeIndex,
        rangeCount,
        z,
        x,
        failed: pending.size,
        pass,
        maxPasses: maxRecoveryPasses,
      });
      await sleepImpl(
        retryDelayMs(Math.max(250, recoveryDelay), pass)
      );
    }

    const ys = [...pending];
    pending.clear();
    let nextIndex = 0;
    const retryConcurrencyDivisor = pass > 0 ? 2 ** pass : 1;
    const workerCount = Math.min(
      Math.max(1, Math.floor(config.platformProfile.perRowConcurrency / retryConcurrencyDivisor)),
      ys.length
    );

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIndex;
        nextIndex++;
        if (idx >= ys.length) break;
        const y = ys[idx];
        const result = await downloadOneTile({
          config,
          provider,
          providerRuntime,
          tokenPool,
          fetchImpl,
          sleepImpl,
          env,
          z,
          x,
          y,
        });
        if (result === "downloaded") downloaded++;
        else if (result === "created") created++;
        else if (result === "skipped") skippedFiles++;
        else if (result === "missing") missing++;
        else pending.add(y);
      }
    });

    await Promise.all(workers);
  }

  const failed = pending.size;

  if (failed === 0) {
    stateDb.markRowComplete({
      ...key,
      expected,
      downloaded: downloaded + created + skippedFiles,
      missing,
      failed,
    });
  } else {
    stateDb.markRowPartial({
      ...key,
      expected,
      downloaded: downloaded + created + skippedFiles,
      missing,
      failed,
    });
  }

  return { skipped: false, expected, downloaded, created, skippedFiles, missing, failed };
}

function* iterRows(ranges) {
  for (const range of ranges) {
    for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
      for (let x = range.xStart; x <= range.xEnd; x++) {
        yield {
          z,
          x,
          yStart: range.yStart,
          yEnd: range.yEnd,
          label: range.label,
        };
      }
    }
  }
}

async function verifyRange({
  config,
  provider,
  providerRuntime,
  tokenPool,
  stateDb,
  fetchImpl,
  sleepImpl,
  env,
  range,
  progress,
  rangeIndex,
  rangeCount,
  rowRecoveryPasses,
  recoveryBackoffMs,
  esriFastMode,
}) {
  let expected = 0;
  let present = 0;
  let repairedDownloaded = 0;
  let repairedCreated = 0;
  let providerMissing = 0;
  let failed = 0;
  let rowsDone = 0;
  const rowsTotal = [...iterRows([range])].length;
  const tilesTotal = rowsTotal * (range.yEnd - range.yStart + 1);
  progress.verifyStart({ rangeIndex, rangeCount, rows: rowsTotal, tiles: tilesTotal });

  for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
    for (let x = range.xStart; x <= range.xEnd; x++) {
      let rowPresent = 0;
      let rowMissing = 0;
      for (let y = range.yStart; y <= range.yEnd; y++) {
        expected++;
        if (await existsNonZero(tilePath(config, provider, z, x, y), provider)) {
          present++;
          rowPresent++;
        } else {
          rowMissing++;
        }
      }

      const rowExpected = range.yEnd - range.yStart + 1;
      const key = {
        jobName: config.jobName,
        configHash: config.configHash,
        layer: config.layer,
        z,
        x,
        yStart: range.yStart,
        yEnd: range.yEnd,
        expected: rowExpected,
      };
      const row = stateDb.getRow(key);
      const acceptedStoredMissing =
        row &&
        row.status === "complete" &&
        row.failed === 0 &&
        row.missing === rowMissing;
      let repairedResult = null;
      if (rowMissing > 0 && acceptedStoredMissing) {
        providerMissing += rowMissing;
      } else if (rowMissing > 0) {
        const repaired = await processRow({
          config,
          provider,
          providerRuntime,
          tokenPool,
          stateDb,
          fetchImpl,
          sleepImpl,
          env,
          forceVerify: true,
          rowRecoveryPasses,
          recoveryBackoffMs,
          esriFastMode,
          progress,
          rangeIndex,
          rangeCount,
          z,
          x,
          yStart: range.yStart,
          yEnd: range.yEnd,
        });
        repairedResult = repaired;
        repairedDownloaded += repaired.downloaded;
        repairedCreated += repaired.created;
        providerMissing += repaired.missing;
        failed += repaired.failed;
        present -= rowPresent;
        rowPresent = repaired.downloaded + repaired.created + repaired.skippedFiles;
        rowMissing = repaired.missing + repaired.failed;
        present += rowPresent;
      }

      if (!acceptedStoredMissing) {
        const nextMissing = repairedResult?.missing ?? rowMissing;
        const nextFailed = repairedResult?.failed ?? 0;
        if (nextFailed === 0) {
          stateDb.markRowComplete({
            ...key,
            downloaded: rowPresent,
            missing: nextMissing,
            failed: 0,
          });
        } else {
          stateDb.markRowPartial({
            ...key,
            downloaded: rowPresent,
            missing: nextMissing,
            failed: nextFailed,
          });
        }
      }
      rowsDone++;
      progress.verifyProgress({
        rangeIndex,
        rangeCount,
        rowsDone,
        rowsTotal,
        present,
        missing: providerMissing,
        failed,
      });
    }
  }

  return {
    label: range.label,
    expected,
    present,
    missing: providerMissing,
    providerMissing,
    failed,
    repairedDownloaded,
    repairedCreated,
  };
}

export async function runDownloadJob({
  config,
  stateDb,
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  dryRun = false,
  forceVerify = false,
  skipVerifyAfterDownload = false,
  esriFastMode = false,
  rowRecoveryPasses = null,
  recoveryBackoffMs = null,
  onRangeVerified,
  proxyRotation,
  progress = true,
} = {}) {
  if (!config) throw new Error("config is required");
  if (!stateDb) throw new Error("stateDb is required");
  if (!fetchImpl && !dryRun) throw new Error("fetch is unavailable in this Node runtime");

  stateDb.upsertJob({
    jobName: config.jobName,
    provider: config.provider,
    configHash: config.configHash,
  });

  const provider = createProvider(config);
  const tokens = config.provider === "mapbox" ? loadMapboxTokensFromEnv(env) : [];
  const savedTokenState =
    config.provider === "mapbox" ? stateDb.loadMapboxTokenState(tokens) : [];
  const tokenPool =
    config.provider === "mapbox"
      ? new MapboxTokenPool(tokens, savedTokenState)
      : null;

  let rowsPlanned = 0;
  let tilesPlanned = 0;
  let rowsSkipped = 0;
  let rowsCompleted = 0;
  let tilesDownloaded = 0;
  let tilesCreated = 0;
  let tilesMissing = 0;
  let tilesFailed = 0;
  let tileFilesSkipped = 0;
  let rangesVerified = 0;
  let rangesSkippedVerified = 0;
  const reporter = createProgressReporter(progress && !dryRun);
  const providerRuntime = createProviderRuntime({
    providerName: config.provider,
    env,
    sleepImpl,
    progress: reporter,
    proxyRotation,
  });
  const rows = [...iterRows(config.ranges)];
  rowsPlanned = rows.length;
  tilesPlanned = rows.reduce((sum, row) => sum + row.yEnd - row.yStart + 1, 0);
  if (dryRun) {
    return {
      rowsPlanned,
      tilesPlanned,
      rowsSkipped,
      rowsCompleted,
      tilesDownloaded,
      tilesCreated,
      tilesMissing,
      tilesFailed,
      tileFilesSkipped,
      rangesVerified,
      rangesSkippedVerified,
    };
  }

  try {
    for (let rangeIdx = 0; rangeIdx < config.ranges.length; rangeIdx++) {
      const range = config.ranges[rangeIdx];
      const rangeIndex = range.sourceRangeIndex || rangeIdx + 1;
      const rangeCount = config.rangeCount || config.ranges.length;
      const rangeRows = [...iterRows([range])];
      const rangeTiles = rangeRows.reduce((sum, row) => sum + row.yEnd - row.yStart + 1, 0);
      let rangeRowsDone = 0;
      let rangeTilesDone = 0;
      let rangeTilesMissing = 0;
      let rangeTilesFailed = 0;
      reporter.rangeStart({
        rangeIndex,
        rangeCount,
        range,
        rows: rangeRows.length,
        tiles: rangeTiles,
      });
      let nextRow = 0;
      const rowWorkers = Array.from(
        { length: Math.min(config.platformProfile.maxRowsInFlight, rangeRows.length) },
        async () => {
          while (true) {
            const idx = nextRow;
            nextRow++;
            if (idx >= rangeRows.length) break;
            const row = rangeRows[idx];
            const result = await processRow({
              config,
              provider,
              providerRuntime,
              tokenPool,
              stateDb,
              fetchImpl,
              sleepImpl,
              env,
              forceVerify,
              esriFastMode,
              rowRecoveryPasses,
              recoveryBackoffMs,
              progress: reporter,
              rangeIndex,
              rangeCount,
              ...row,
            });
            if (result.skipped) rowsSkipped++;
            else rowsCompleted++;
            tilesDownloaded += result.downloaded;
            tilesCreated += result.created;
            tileFilesSkipped += result.skippedFiles;
            tilesMissing += result.missing;
            tilesFailed += result.failed;
            rangeTilesMissing += result.missing;
            rangeTilesFailed += result.failed;
            rangeRowsDone++;
            rangeTilesDone += result.expected;
            reporter.rowDone({
              rangeIndex,
              rangeCount,
              rowsDone: rangeRowsDone,
              rowsTotal: rangeRows.length,
              tilesDone: rangeTilesDone,
              tilesTotal: rangeTiles,
              totals: {
                rowsSkipped,
                rowsCompleted,
                tilesDownloaded,
                tilesCreated,
                tileFilesSkipped,
                tilesMissing,
                tilesFailed,
              },
              current: row,
            });
          }
        }
      );

      await Promise.all(rowWorkers);
      if (
        !skipVerifyAfterDownload &&
        config.verifyAfterDownload !== false &&
        !(esriFastMode && !forceVerify)
      ) {
        const verified = await verifyRange({
          config,
          provider,
          providerRuntime,
          tokenPool,
          stateDb,
          fetchImpl,
          sleepImpl,
          env,
          range,
          progress: reporter,
          rangeIndex,
          rangeCount,
          rowRecoveryPasses,
          recoveryBackoffMs,
          esriFastMode,
        });
        rangesVerified++;
        tilesDownloaded += verified.repairedDownloaded;
        tilesCreated += verified.repairedCreated;
        tilesMissing = Math.max(0, tilesMissing - rangeTilesMissing + verified.providerMissing);
        tilesFailed = Math.max(0, tilesFailed - rangeTilesFailed + verified.failed);
        stateDb.markRangeVerified({
          jobName: config.jobName,
          configHash: config.configHash,
          layer: config.layer,
          rangeIndex,
          label: range.label,
          expected: verified.expected,
          present: verified.present,
          missing: verified.missing,
          failed: verified.failed,
        });
        if (onRangeVerified) onRangeVerified(verified);
        reporter.rangeVerified({ rangeIndex, rangeCount, verified });
      }
    }
  } finally {
    if (tokenPool) stateDb.saveMapboxTokenState(tokenPool.snapshot());
  }

  return {
    rowsPlanned,
    tilesPlanned,
    rowsSkipped,
    rowsCompleted,
    tilesDownloaded,
    tilesCreated,
    tilesMissing,
    tilesFailed,
    tileFilesSkipped,
    rangesVerified,
    rangesSkippedVerified,
  };
}
