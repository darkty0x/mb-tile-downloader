import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { MapboxTokenPool, loadMapboxTokensFromEnv } from "../auth/mapbox-token-pool.js";
import { createProvider } from "../providers/index.js";

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

function tileRetryFloor() {
  return parsePositiveInt(process.env.TILE_DOWNLOADER_MIN_TILE_RETRIES) ?? 10;
}

function rowRecoveryPasses() {
  return parseNonNegativeInt(process.env.TILE_DOWNLOADER_ROW_RECOVERY_PASSES) ?? 4;
}

function retryDelayMs(baseMs, attempt) {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 30_000);
  const jitter = Math.floor(Math.random() * Math.min(baseMs, 1_000));
  return exponential + jitter;
}

function createProgressReporter(enabled) {
  if (!enabled) {
    return {
      rangeStart() {},
      rowDone() {},
      rowRetry() {},
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

  function seconds(ms) {
    return Math.max(ms / 1000, 0.001);
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
      lastRowsDone = rowsDone;
      lastTilesDone = tilesDone;
      lastRateAt = now;
      line(
        `  ↳ range ${rangeIndex}/${rangeCount} row ${rowsDone}/${rowsTotal} z=${current.z} x=${current.x} ` +
          `tiles ${tilesDone}/${tilesTotal} d=${totals.tilesDownloaded} s=${totals.tileFilesSkipped} ` +
          `m=${totals.tilesMissing} f=${totals.tilesFailed} skippedRows=${totals.rowsSkipped} ` +
          `rate=${rowRate.toFixed(1)} rows/s ${tileRate.toFixed(1)} tiles/s`
      );
    },
    rowRetry({ rangeIndex, rangeCount, z, x, failed, pass, maxPasses }) {
      line(
        `  ↻ range ${rangeIndex}/${rangeCount} z=${z} x=${x} retrying ${failed} failed tiles pass=${pass}/${maxPasses}`,
        true
      );
    },
    verifyStart({ rangeIndex, rangeCount, rows, tiles }) {
      line(`  🔍 verifying range ${rangeIndex}/${rangeCount} rows=${rows} tiles=${tiles}`, true);
    },
    verifyProgress({ rangeIndex, rangeCount, rowsDone, rowsTotal, present, missing }) {
      line(
        `  🔍 range ${rangeIndex}/${rangeCount} verify rows=${rowsDone}/${rowsTotal} present=${present} missing=${missing}`
      );
    },
    rangeVerified({ rangeIndex, rangeCount, verified }) {
      const elapsed = seconds(Date.now() - currentRangeStartedAt);
      line(
        `  ✔ range ${rangeIndex}/${rangeCount} verified present=${verified.present}/${verified.expected} missing=${verified.missing} elapsed=${elapsed.toFixed(1)}s`,
        true
      );
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
  return path.join(config.output.dir, normalized);
}

async function existsNonZero(filePath) {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile() && st.size > 0;
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
  tokenPool,
  fetchImpl,
  z,
  x,
  y,
}) {
  const finalPath = tilePath(config, provider, z, x, y);
  if (await existsNonZero(finalPath)) return "skipped";

  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await removeStaleTempFiles(finalPath);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  const maxRetries = Math.max(
    tileRetryFloor(),
    Number(config.performance?.maxRetries || 3)
  );
  const backoffMs = Math.max(1, Number(config.performance?.retryBackoffMs || 150));
  const timeoutMs = Math.max(1000, Number(config.platformProfile?.requestTimeoutMs || 25_000));

  let networkAttempt = 0;
  let requestAttempt = 0;
  while (networkAttempt < maxRetries) {
    try {
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
        headers: provider.name === "esri" ? { "user-agent": "tile-downloader" } : undefined,
      });
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
        networkAttempt++;
        if (networkAttempt < maxRetries) await sleep(retryDelayMs(backoffMs, networkAttempt));
        continue;
      }
      if (classified.status === "fatal") return "failed";

      if (provider.isUnavailable) {
        const buffer = await readResponseBuffer(resp);
        if (provider.isUnavailable(buffer)) return "missing";
        await fsp.writeFile(tmpPath, buffer);
      } else {
        await writeResponse(resp, tmpPath);
      }

      const st = await fsp.stat(tmpPath);
      if (!st.isFile() || st.size === 0) throw new Error("empty tile");
      await fsp.rename(tmpPath, finalPath);
      return "downloaded";
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (/All Mapbox access tokens/.test(String(err?.message))) throw err;
      networkAttempt++;
      if (networkAttempt < maxRetries) await sleep(retryDelayMs(backoffMs, networkAttempt));
    }
  }

  return "failed";
}

async function processRow({
  config,
  provider,
  tokenPool,
  stateDb,
  fetchImpl,
  forceVerify,
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
  if (!forceVerify && stateDb.shouldSkipRow(key)) {
    return { skipped: true, expected, downloaded: 0, skippedFiles: expected, missing: 0, failed: 0 };
  }

  let downloaded = 0;
  let skippedFiles = 0;
  let missing = 0;
  const pending = new Set();
  for (let y = yStart; y <= yEnd; y++) pending.add(y);

  const maxRecoveryPasses = rowRecoveryPasses();
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
      await sleep(retryDelayMs(Math.max(250, Number(config.performance?.retryBackoffMs || 150)), pass));
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
          tokenPool,
          fetchImpl,
          z,
          x,
          y,
        });
        if (result === "downloaded") downloaded++;
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
      downloaded: downloaded + skippedFiles,
      missing,
      failed,
    });
  } else {
    stateDb.markRowPartial({
      ...key,
      expected,
      downloaded: downloaded + skippedFiles,
      missing,
      failed,
    });
  }

  return { skipped: false, expected, downloaded, skippedFiles, missing, failed };
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

async function verifyRange({ config, provider, stateDb, range, progress, rangeIndex, rangeCount }) {
  let expected = 0;
  let present = 0;
  let missing = 0;
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
        if (await existsNonZero(tilePath(config, provider, z, x, y))) {
          present++;
          rowPresent++;
        } else {
          missing++;
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
      if (row && row.failed === 0 && rowMissing === 0) {
        stateDb.markRowComplete({
          ...key,
          downloaded: rowPresent,
          missing: rowMissing,
          failed: 0,
        });
      } else if (rowMissing > 0) {
        stateDb.markRowPartial({
          ...key,
          downloaded: rowPresent,
          missing: rowMissing,
          failed: rowMissing,
        });
      }
      rowsDone++;
      progress.verifyProgress({ rangeIndex, rangeCount, rowsDone, rowsTotal, present, missing });
    }
  }

  return {
    label: range.label,
    expected,
    present,
    missing,
  };
}

export async function runDownloadJob({
  config,
  stateDb,
  env = process.env,
  fetchImpl = globalThis.fetch,
  dryRun = false,
  forceVerify = false,
  onRangeVerified,
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
  const tokenPool =
    config.provider === "mapbox"
      ? new MapboxTokenPool(tokens)
      : null;

  let rowsPlanned = 0;
  let tilesPlanned = 0;
  let rowsSkipped = 0;
  let rowsCompleted = 0;
  let tilesDownloaded = 0;
  let tilesMissing = 0;
  let tilesFailed = 0;
  let tileFilesSkipped = 0;
  let rangesVerified = 0;
  let rangesSkippedVerified = 0;
  const reporter = createProgressReporter(progress && !dryRun);
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
      const rangeIndex = rangeIdx + 1;
      const rangeCount = config.ranges.length;
      const rangeRows = [...iterRows([range])];
      const rangeTiles = rangeRows.reduce((sum, row) => sum + row.yEnd - row.yStart + 1, 0);
      const rangeKey = {
        jobName: config.jobName,
        configHash: config.configHash,
        layer: config.layer,
        rangeIndex,
      };
      if (!forceVerify && stateDb.shouldSkipRange(rangeKey)) {
        rangesSkippedVerified++;
        rowsSkipped += rangeRows.length;
        tileFilesSkipped += rangeTiles;
        reporter.rangeStart({
          rangeIndex,
          rangeCount,
          range,
          rows: rangeRows.length,
          tiles: rangeTiles,
        });
        console.log(`  ↳ range ${rangeIndex}/${rangeCount} already verified; skipping`);
        continue;
      }
      let rangeRowsDone = 0;
      let rangeTilesDone = 0;
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
              tokenPool,
              stateDb,
              fetchImpl,
              forceVerify,
              progress: reporter,
              rangeIndex,
              rangeCount,
              ...row,
            });
            if (result.skipped) rowsSkipped++;
            else rowsCompleted++;
            tilesDownloaded += result.downloaded;
            tileFilesSkipped += result.skippedFiles;
            tilesMissing += result.missing;
            tilesFailed += result.failed;
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
      if (config.verifyAfterDownload !== false) {
        const verified = await verifyRange({ config, provider, stateDb, range, progress: reporter, rangeIndex, rangeCount });
        rangesVerified++;
        stateDb.markRangeVerified({
          jobName: config.jobName,
          configHash: config.configHash,
          layer: config.layer,
          rangeIndex,
          label: range.label,
          expected: verified.expected,
          present: verified.present,
          missing: verified.missing,
        });
        if (verified.missing > 0) tilesFailed += verified.missing;
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
    tilesMissing,
    tilesFailed,
    tileFilesSkipped,
    rangesVerified,
    rangesSkippedVerified,
  };
}
