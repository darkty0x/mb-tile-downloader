import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { writeFile, readdir, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDownloadJob } from "../src/engine/downloader-engine.js";
import { TileStateDb } from "../src/state/state-db.js";

async function withEnv(values, fn) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("dry run counts rows and does not create tile files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const result = await runDownloadJob({
    config: {
      jobName: "dry",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 2, yStart: 1, yEnd: 3, label: "r" }],
      platformProfile: { maxRowsInFlight: 2, perRowConcurrency: 2, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
    },
    stateDb: db,
    progress: false,
    dryRun: true,
  });

  assert.equal(result.rowsPlanned, 2);
  assert.equal(result.tilesPlanned, 6);
  await assert.rejects(() => stat(path.join(dir, "tiles")), /ENOENT/);
  db.close();
});

test("engine skips rows marked complete for the same config hash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  db.markRowComplete({
    jobName: "skip",
    configHash: "hash",
    layer: "satellite",
    z: 1,
    x: 1,
    yStart: 1,
    yEnd: 1,
    expected: 1,
    downloaded: 1,
    missing: 0,
    failed: 0,
  });

  let fetches = 0;
  const result = await runDownloadJob({
    config: {
      jobName: "skip",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "r" }],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
    },
    stateDb: db,
    progress: false,
    fetchImpl: async () => {
      fetches++;
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.rowsSkipped, 1);
  assert.equal(fetches, 0);
  db.close();
});

test("engine verifies each range immediately after processing it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const verified = [];
  const result = await runDownloadJob({
    config: {
      jobName: "verify-range",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [
        { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
        { zoomStart: 1, zoomEnd: 1, xStart: 2, xEnd: 2, yStart: 1, yEnd: 1, label: "b" },
      ],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
    },
    stateDb: db,
    progress: false,
    fetchImpl: async () => new Response("tile"),
    onRangeVerified: (summary) => verified.push(summary.label),
  });

  assert.equal(result.rangesVerified, 2);
  assert.deepEqual(verified, ["a", "b"]);
  db.close();
});

test("verification failures are persisted so resume retries error rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  db.markRowComplete({
    jobName: "verify-resume",
    configHash: "hash",
    layer: "satellite",
    z: 1,
    x: 1,
    yStart: 1,
    yEnd: 1,
    expected: 1,
    downloaded: 1,
    missing: 0,
    failed: 0,
  });

  const config = {
    jobName: "verify-resume",
    provider: "esri",
    layer: "satellite",
    format: "jpg",
    configHash: "hash",
    output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
    tile: { extension: "jpg", yScheme: "xyz" },
    url: { template: "https://example.test/{z}/{y}/{x}" },
    ranges: [
      { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
    ],
    platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
    performance: { maxRetries: 1, retryBackoffMs: 1 },
    verifyAfterDownload: true,
  };

  await runDownloadJob({
    config,
    stateDb: db,
    progress: false,
    fetchImpl: async () => {
      throw new Error("complete row should be skipped before verify");
    },
  });

  assert.equal(
    db.shouldSkipRow({
      jobName: "verify-resume",
      configHash: "hash",
      layer: "satellite",
      z: 1,
      x: 1,
      yStart: 1,
      yEnd: 1,
    }),
    false
  );

  let fetches = 0;
  await runDownloadJob({
    config,
    stateDb: db,
    progress: false,
    fetchImpl: async () => {
      fetches++;
      return new Response("tile");
    },
  });

  assert.equal(fetches, 1);
  assert.equal(
    db.shouldSkipRow({
      jobName: "verify-resume",
      configHash: "hash",
      layer: "satellite",
      z: 1,
      x: 1,
      yStart: 1,
      yEnd: 1,
    }),
    true
  );
  db.close();
});

test("token state is persisted when all Mapbox tokens become unusable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));

  await assert.rejects(
    () =>
      runDownloadJob({
        config: {
          jobName: "token-fatal",
          provider: "mapbox",
          layer: "vector",
          format: "pbf",
          configHash: "hash",
          output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
          tile: { extension: "vector.pbf", yScheme: "xyz" },
          url: { tileset: "mapbox.test", extension: "vector.pbf" },
          ranges: [
            { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
          ],
          platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
          performance: { maxRetries: 1, retryBackoffMs: 1 },
          verifyAfterDownload: true,
        },
        stateDb: db,
        progress: false,
        env: { MAPBOX_ACCESS_TOKENS: "bad-token" },
        fetchImpl: async () => new Response("forbidden", { status: 403 }),
      }),
    /All Mapbox access tokens are unusable/
  );

  assert.deepEqual(db.loadMapboxTokenState(["bad-token"]), [
    { token: "bad-token", status: "exhausted", reason: "HTTP 403" },
  ]);
  db.close();
});

test("Mapbox token rotations do not consume tile retry budget", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const seenTokens = [];

  const result = await runDownloadJob({
    config: {
      jobName: "token-rotation",
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "vector.pbf", yScheme: "xyz" },
      url: { hosts: ["a"], tileset: "mapbox.test" },
      ranges: [
        { zoomStart: 6, zoomEnd: 6, xStart: 55, xEnd: 55, yStart: 39, yEnd: 39, label: "one" },
      ],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
      verifyAfterDownload: true,
    },
    stateDb: db,
    progress: false,
    env: { MAPBOX_ACCESS_TOKENS: "bad-token,good-token" },
    fetchImpl: async (url) => {
      const token = new URL(url).searchParams.get("access_token");
      seenTokens.push(token);
      if (token === "bad-token") return new Response("invalid", { status: 401 });
      return new Response("tile");
    },
  });

  assert.deepEqual(seenTokens, ["bad-token", "good-token"]);
  assert.equal(result.tilesDownloaded, 1);
  assert.equal(result.tilesFailed, 0);
  db.close();
});

test("script-level retry floor recovers transient tile failures without config changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let fetches = 0;

  await withEnv({ TILE_DOWNLOADER_MIN_TILE_RETRIES: "2" }, async () => {
    const result = await runDownloadJob({
      config: {
        jobName: "retry-floor",
        provider: "esri",
        layer: "satellite",
        format: "jpg",
        configHash: "hash",
        output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
        tile: { extension: "jpg", yScheme: "xyz" },
        url: { template: "https://example.test/{z}/{y}/{x}" },
        ranges: [
          { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
        ],
        platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
        performance: { maxRetries: 1, retryBackoffMs: 1 },
        verifyAfterDownload: true,
      },
      stateDb: db,
      progress: false,
      fetchImpl: async () => {
        fetches++;
        if (fetches === 1) return new Response("busy", { status: 500 });
        return new Response("tile");
      },
    });

    assert.equal(result.tilesDownloaded, 1);
    assert.equal(result.tilesFailed, 0);
    assert.equal(fetches, 2);
  });

  db.close();
});

test("row recovery retries failed tiles before range verification", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let fetches = 0;

  await withEnv(
    {
      TILE_DOWNLOADER_MIN_TILE_RETRIES: "1",
      TILE_DOWNLOADER_ROW_RECOVERY_PASSES: "2",
    },
    async () => {
      const result = await runDownloadJob({
        config: {
          jobName: "row-recovery",
          provider: "esri",
          layer: "satellite",
          format: "jpg",
          configHash: "hash",
          output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
          tile: { extension: "jpg", yScheme: "xyz" },
          url: { template: "https://example.test/{z}/{y}/{x}" },
          ranges: [
            { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
          ],
          platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
          performance: { maxRetries: 1, retryBackoffMs: 1 },
          verifyAfterDownload: true,
        },
        stateDb: db,
        progress: false,
        fetchImpl: async () => {
          fetches++;
          if (fetches === 1) throw new Error("socket reset");
          return new Response("tile");
        },
      });

      assert.equal(result.tilesDownloaded, 1);
      assert.equal(result.tilesFailed, 0);
      assert.equal(fetches, 2);
    }
  );

  db.close();
});

test("stale temp files for a tile are removed before retrying", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const rowDir = path.join(dir, "tiles", "satellite", "1", "1");
  await mkdir(rowDir, { recursive: true });
  await writeFile(path.join(rowDir, "1.jpg.tmp-old"), "partial");

  await runDownloadJob({
    config: {
      jobName: "tmp-clean",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [
        { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
      ],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
      verifyAfterDownload: true,
    },
    stateDb: db,
    progress: false,
    fetchImpl: async () => new Response("tile"),
  });

  const files = await readdir(rowDir);
  assert.deepEqual(files.sort(), ["1.jpg"]);
  db.close();
});

test("path templates cannot escape the configured output directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));

  await assert.rejects(
    () =>
      runDownloadJob({
        config: {
          jobName: "path-traversal",
          provider: "esri",
          layer: "satellite",
          format: "jpg",
          configHash: "hash",
          output: { dir: path.join(dir, "tiles"), pathTemplate: "../outside/{z}/{x}/{y}.{extension}" },
          tile: { extension: "jpg", yScheme: "xyz" },
          url: { template: "https://example.test/{z}/{y}/{x}" },
          ranges: [
            { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
          ],
          platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
          performance: { maxRetries: 1, retryBackoffMs: 1 },
          verifyAfterDownload: true,
        },
        stateDb: db,
        progress: false,
        fetchImpl: async () => new Response("tile"),
      }),
    /escapes output directory/
  );

  db.close();
});

test("verified ranges are skipped on resume without rechecking files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  db.markRangeVerified({
    jobName: "range-skip",
    configHash: "hash",
    layer: "satellite",
    rangeIndex: 1,
    label: "a",
    expected: 1,
    present: 1,
    missing: 0,
  });

  let verified = 0;
  const result = await runDownloadJob({
    config: {
      jobName: "range-skip",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [
        { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "a" },
        { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 0, yEnd: 0, label: "b" },
      ],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
      verifyAfterDownload: true,
    },
    stateDb: db,
    progress: false,
    fetchImpl: async () => new Response("tile"),
    onRangeVerified: () => verified++,
  });

  assert.equal(result.rangesSkippedVerified, 1);
  assert.equal(result.rangesVerified, 1);
  assert.equal(verified, 1);
  db.close();
});
