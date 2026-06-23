import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { writeFile, readdir, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDownloadJob } from "../src/engine/downloader-engine.js";
import { PROXY_INFO_SYMBOL } from "../src/runtime/platform-profile.js";
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

test("download writes row tiles to deterministic output roots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const rootA = path.join(dir, "drive-a");
  const rootB = path.join(dir, "drive-b");
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const result = await runDownloadJob({
    config: {
      jobName: "multi-root",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: {
        dir: rootA,
        dirs: [rootA, rootB],
        pathTemplate: "{layer}/{z}/{x}/{y}.{extension}",
      },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 0, xEnd: 1, yStart: 0, yEnd: 0, label: "r" }],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
    },
    stateDb: db,
    progress: false,
    fetchImpl: async () => new Response("tile"),
  });

  assert.equal(result.tilesDownloaded, 2);
  assert.equal(await readFile(path.join(rootB, "satellite", "1", "0", "0.jpg"), "utf8"), "tile");
  assert.equal(await readFile(path.join(rootA, "satellite", "1", "1", "0.jpg"), "utf8"), "tile");
  db.close();
});

test("download skips existing tiles from alternate output roots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const rootA = path.join(dir, "drive-a");
  const rootB = path.join(dir, "drive-b");
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  await mkdir(path.join(rootB, "satellite", "1", "1"), { recursive: true });
  await writeFile(path.join(rootB, "satellite", "1", "1", "1.jpg"), "tile");

  let fetches = 0;
  const result = await runDownloadJob({
    config: {
      jobName: "skip-alt-root",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: {
        dir: rootA,
        dirs: [rootA],
        searchDirs: [rootA, rootB],
        pathTemplate: "{layer}/{z}/{x}/{y}.{extension}",
      },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "r" }],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1 },
      verifyAfterDownload: true,
    },
    stateDb: db,
    progress: false,
    fetchImpl: async () => {
      fetches++;
      throw new Error("should not fetch existing alternate-root tile");
    },
  });

  assert.equal(fetches, 0);
  assert.equal(result.tilesDownloaded, 0);
  assert.equal(result.tileFilesSkipped, 1);
  assert.equal(result.tilesFailed, 0);
  db.close();
});

test("progress output reports source counters and ETA", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const lines = [];
  const originalLog = console.log;
  console.log = (message) => {
    lines.push(String(message));
  };

  try {
    await runDownloadJob({
      config: {
        jobName: "progress-eta",
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
        verifyAfterDownload: false,
      },
      stateDb: db,
      progress: true,
      skipVerifyAfterDownload: true,
      fetchImpl: async () => new Response("tile"),
    });
  } finally {
    console.log = originalLog;
    db.close();
  }

  const rowLine = lines.find((line) => line.includes(" 행 1/1 "));
  assert.match(rowLine, /내리적재=1 보관됨=0/);
  assert.doesNotMatch(rowLine, /\bc=/);
  assert.match(rowLine, /완료예상=\d+s/);
});

test("progress output reports tile counters at config scope across ranges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const lines = [];
  const originalLog = console.log;
  console.log = (message) => {
    lines.push(String(message));
  };

  try {
    await runDownloadJob({
      config: {
        jobName: "progress-config-scope",
        provider: "esri",
        layer: "satellite",
        format: "jpg",
        configHash: "hash",
        output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
        tile: { extension: "jpg", yScheme: "xyz" },
        url: { template: "https://example.test/{z}/{y}/{x}" },
        ranges: [
          { zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1, label: "r1" },
          { zoomStart: 1, zoomEnd: 1, xStart: 2, xEnd: 2, yStart: 1, yEnd: 1, label: "r2" },
        ],
        platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
        performance: { maxRetries: 1, retryBackoffMs: 1 },
        verifyAfterDownload: false,
      },
      stateDb: db,
      progress: true,
      skipVerifyAfterDownload: true,
      fetchImpl: async () => new Response("tile"),
    });
  } finally {
    console.log = originalLog;
    db.close();
  }

  const firstRangeLine = lines.find((line) => line.includes("범위 1/2 행 1/1"));
  const secondRangeLine = lines.find((line) => line.includes("범위 2/2 행 1/1"));
  assert.match(firstRangeLine, /타일 1\/2/);
  assert.match(secondRangeLine, /타일 2\/2/);
});

test("progress ETA ignores skip-only rows when estimating remaining download work", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const lines = [];
  const rowDir = path.join(dir, "tiles", "satellite", "1", "1");
  await mkdir(rowDir, { recursive: true });
  await writeFile(path.join(rowDir, "1.jpg"), "existing");
  const originalLog = console.log;
  const originalNow = Date.now;
  let fakeNow = 0;
  console.log = (message) => {
    lines.push(String(message));
  };
  Date.now = () => fakeNow;

  try {
    await runDownloadJob({
      config: {
        jobName: "progress-eta-skips",
        provider: "esri",
        layer: "satellite",
        format: "jpg",
        configHash: "hash",
        output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
        tile: { extension: "jpg", yScheme: "xyz" },
        url: { template: "https://example.test/{z}/{y}/{x}" },
        ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 3, yStart: 1, yEnd: 1, label: "r" }],
        platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
        performance: { maxRetries: 1, retryBackoffMs: 1 },
        verifyAfterDownload: false,
      },
      stateDb: db,
      progress: true,
      skipVerifyAfterDownload: true,
      fetchImpl: async () => {
        fakeNow += 10_000;
        return new Response("tile");
      },
    });
  } finally {
    console.log = originalLog;
    Date.now = originalNow;
    db.close();
  }

  const rowLine = lines.find((line) => line.includes(" 행 2/3 "));
  assert.match(rowLine, /보관됨=1/);
  assert.match(rowLine, /완료예상=10s/);
});

test("engine skips rows marked complete for the same config hash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const rowDir = path.join(dir, "tiles", "satellite", "1", "1");
  await mkdir(rowDir, { recursive: true });
  await writeFile(path.join(rowDir, "1.jpg"), "tile");

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

test("Mapbox missing source tiles complete rows and skip on resume", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const config = {
    jobName: "mapbox-source-missing",
    provider: "mapbox",
    layer: "vector",
    format: "pbf",
    configHash: "hash",
    output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
    tile: { extension: "vector.pbf", yScheme: "xyz" },
    url: { template: "https://example.test/{z}/{x}/{y}.{extension}?access_token={token}" },
    ranges: [{ zoomStart: 5, zoomEnd: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 20, label: "r" }],
    platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 2, requestTimeoutMs: 1000 },
    performance: { maxRetries: 0, retryBackoffMs: 1 },
    verifyAfterDownload: false,
  };

  const first = await runDownloadJob({
    config,
    stateDb: db,
    progress: false,
    skipVerifyAfterDownload: true,
    env: { MAPBOX_ACCESS_TOKENS: "pk.test" },
    fetchImpl: async (url) => {
      if (String(url).includes("/20.vector.pbf")) return new Response("not found", { status: 404 });
      return new Response("tile");
    },
  });

  assert.equal(first.tilesDownloaded, 1);
  assert.equal(first.tilesMissing, 1);
  assert.equal(first.tilesFailed, 0);
  assert.equal(
    db.shouldSkipRow({
      jobName: config.jobName,
      configHash: config.configHash,
      layer: config.layer,
      z: 5,
      x: 27,
      yStart: 19,
      yEnd: 20,
    }),
    true
  );

  let fetches = 0;
  const second = await runDownloadJob({
    config,
    stateDb: db,
    progress: false,
    skipVerifyAfterDownload: true,
    env: { MAPBOX_ACCESS_TOKENS: "pk.test" },
    fetchImpl: async () => {
      fetches++;
      throw new Error("complete missing rows should not refetch");
    },
  });

  assert.equal(second.rowsSkipped, 1);
  assert.equal(second.tileFilesSkipped, 1);
  assert.equal(second.tilesMissing, 1);
  assert.equal(second.tilesFailed, 0);
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

test("verification repairs missing files from stale complete rows", async () => {
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

  let fetches = 0;
  const result = await runDownloadJob({
    config,
    stateDb: db,
    progress: false,
    fetchImpl: async () => {
      fetches++;
      return new Response("tile");
    },
  });

  assert.equal(result.rowsSkipped, 1);
  assert.equal(result.tilesDownloaded, 1);
  assert.equal(result.tilesCreated, 0);
  assert.equal(result.tilesFailed, 0);
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
  const lines = [];
  const originalLog = console.log;
  console.log = (message) => {
    lines.push(String(message));
  };

  try {
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
          progress: true,
          env: { MAPBOX_ACCESS_TOKENS: "bad-token" },
          fetchImpl: async () => new Response("forbidden", { status: 403 }),
        }),
      /All Mapbox access tokens are unusable/
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(db.loadMapboxTokenState(["bad-token"]), [
    { token: "bad-token", status: "exhausted", reason: "HTTP 403" },
  ]);
  const tokenEvent = lines.map((line) => /^\[event\]\s+(.+)$/.exec(line)?.[1]).filter(Boolean).map(JSON.parse).find((event) => event.type === "mapbox.token_unusable");
  assert.equal(tokenEvent?.data.status, "exhausted");
  assert.equal(tokenEvent?.data.providerStatus, 403);
  assert.equal(tokenEvent?.data.tokenHash, crypto.createHash("sha256").update("bad-token").digest("hex"));
  db.close();
});

test("persisted unusable Mapbox token state is loaded before downloading", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const seenTokens = [];
  db.saveMapboxTokenState({
    tokens: [
      { token: "bad-token", status: "exhausted", reason: "prior HTTP 403" },
      { token: "good-token", status: "active", reason: null },
    ],
  });

  const result = await runDownloadJob({
    config: {
      jobName: "token-resume",
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
      if (token === "bad-token") return new Response("forbidden", { status: 403 });
      return new Response("tile");
    },
  });

  assert.deepEqual(seenTokens, ["good-token"]);
  assert.equal(result.tilesDownloaded, 1);
  assert.equal(result.tilesCreated, 0);
  assert.equal(result.tilesFailed, 0);
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
  assert.equal(result.tilesCreated, 0);
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

test("Esri retries 404 responses before accepting a tile as failed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let fetches = 0;

  await withEnv(
    {
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "0",
    },
    async () => {
    const result = await runDownloadJob({
      config: {
        jobName: "esri-404-retry",
        provider: "esri",
        layer: "satellite",
        format: "jpg",
        configHash: "hash",
        output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
        tile: { extension: "jpg", yScheme: "xyz" },
        url: { template: "https://example.test/{z}/{y}/{x}" },
        ranges: [
          { zoomStart: 14, zoomEnd: 14, xStart: 9580, xEnd: 9580, yStart: 5265, yEnd: 5265, label: "a" },
        ],
        platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
        performance: { maxRetries: 1, retryBackoffMs: 1 },
        verifyAfterDownload: true,
      },
      stateDb: db,
      progress: false,
      fetchImpl: async () => {
        fetches++;
        if (fetches === 1) return new Response("not found", { status: 404 });
        return new Response("tile");
      },
    });

    assert.equal(result.tilesDownloaded, 1);
    assert.equal(result.tilesFailed, 0);
    assert.equal(fetches, 2);
  });

  db.close();
});

test("Esri 200 image responses are downloaded when unavailable hashes are not configured", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const placeholder = Buffer.from("esri unavailable placeholder");
  let fetches = 0;

  const result = await runDownloadJob({
    config: {
      jobName: "esri-200-image",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "jpg", yScheme: "xyz" },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [
        { zoomStart: 14, zoomEnd: 14, xStart: 9603, xEnd: 9603, yStart: 5824, yEnd: 5824, label: "a" },
      ],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1, rowRecoveryPasses: 0 },
      verifyAfterDownload: false,
    },
    stateDb: db,
    progress: false,
    skipVerifyAfterDownload: true,
    fetchImpl: async () => {
      fetches++;
      return new Response(placeholder, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    },
  });

  assert.equal(result.tilesDownloaded, 1);
  assert.equal(result.tilesCreated, 0);
  assert.equal(result.tilesMissing, 0);
  assert.equal(result.tilesFailed, 0);
  assert.equal(fetches, 1);
  const saved = await stat(path.join(dir, "tiles", "satellite", "14", "9603", "5824.jpg"));
  assert.equal(saved.size, placeholder.length);

  db.close();
});

test("Configured Esri unavailable placeholder responses are missing, not proxy failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const placeholder = Buffer.from("esri unavailable placeholder");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  let fetches = 0;

  await withEnv(
    {
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "0",
    },
    async () => {
      const result = await runDownloadJob({
        config: {
          jobName: "esri-unavailable",
          provider: "esri",
          layer: "satellite",
          format: "jpg",
          configHash: "hash",
          output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
          tile: { extension: "jpg", yScheme: "xyz", unavailableTileSha256: placeholderHash },
          url: { template: "https://example.test/{z}/{y}/{x}" },
          ranges: [
            { zoomStart: 14, zoomEnd: 14, xStart: 9603, xEnd: 9603, yStart: 5824, yEnd: 5824, label: "a" },
          ],
          platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
          performance: { maxRetries: 1, retryBackoffMs: 1, rowRecoveryPasses: 0 },
          verifyAfterDownload: false,
        },
        stateDb: db,
        progress: false,
        skipVerifyAfterDownload: true,
        fetchImpl: async () => {
          fetches++;
          return new Response(placeholder, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        },
      });

    assert.equal(result.tilesMissing, 1);
    assert.equal(result.tilesFailed, 0);
    assert.equal(result.tilesDownloaded, 0);
    assert.equal(fetches, 1);
    await assert.rejects(
      () => stat(path.join(dir, "tiles", "satellite", "14", "9603", "5824.jpg")),
      /ENOENT/
    );
    }
  );

  db.close();
});

test("Esri unavailable placeholders are source missing tiles, not proxy failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const placeholder = Buffer.from("esri unavailable placeholder");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  const marked = [];
  let fetches = 0;

  await withEnv(
    {
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "0",
    },
    async () => {
      const result = await runDownloadJob({
        config: {
          jobName: "esri-placeholder-source-missing",
          provider: "esri",
          layer: "satellite",
          format: "jpg",
          configHash: "hash",
          output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
          tile: { extension: "jpg", yScheme: "xyz", unavailableTileSha256: placeholderHash },
          url: { template: "https://example.test/{z}/{y}/{x}" },
          ranges: [
            { zoomStart: 14, zoomEnd: 14, xStart: 9604, xEnd: 9604, yStart: 5824, yEnd: 5824, label: "a" },
          ],
          platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
          performance: { maxRetries: 1, retryBackoffMs: 1, rowRecoveryPasses: 0 },
          verifyAfterDownload: false,
        },
        stateDb: db,
        progress: false,
        skipVerifyAfterDownload: true,
        env: process.env,
        proxyRotation: {
          markProxyBlocked(protocolOrProxy, ms, proxy = null) {
            marked.push({ proxy: proxy || protocolOrProxy, ms });
          },
          hasHealthyCandidate() {
            return true;
          },
        },
        fetchImpl: async () => {
          fetches++;
          const response = new Response(placeholder, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
          response[PROXY_INFO_SYMBOL] = {
            proxy: "https://paid.proxy.example:8080",
            protocol: "https:",
            url: "https://example.test/14/5824/9604",
          };
          return response;
        },
      });

      assert.equal(result.tilesMissing, 1);
      assert.equal(result.tilesFailed, 0);
      assert.equal(result.tilesDownloaded, 0);
      assert.equal(fetches, 1);
      assert.deepEqual(marked, []);
    }
  );

  db.close();
});

test("Esri unavailable placeholders stay missing even when old fallback settings are present", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const placeholder = Buffer.from("esri unavailable placeholder");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  const requestedUrls = [];

  const result = await runDownloadJob({
    config: {
      jobName: "esri-no-parent-synthesis",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: {
        extension: "jpg",
        yScheme: "xyz",
        unavailableTileSha256: placeholderHash,
        unavailableFallback: { autoEnabled: true, maxParentZoomOffset: 4 },
      },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [
        { zoomStart: 19, zoomEnd: 19, xStart: 318592, xEnd: 318592, yStart: 172533, yEnd: 172533, label: "a" },
      ],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1, rowRecoveryPasses: 0 },
      verifyAfterDownload: false,
    },
    stateDb: db,
    env: { ...process.env, TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "1" },
    progress: false,
    skipVerifyAfterDownload: true,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return new Response(placeholder, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    },
  });

  assert.equal(result.tilesDownloaded, 0);
  assert.equal(result.tilesCreated, 0);
  assert.equal(result.tilesMissing, 1);
  assert.equal(result.tilesFailed, 0);
  assert.deepEqual(requestedUrls, ["https://example.test/19/172533/318592"]);
  await assert.rejects(
    () => stat(path.join(dir, "tiles", "satellite", "19", "318592", "172533.jpg")),
    /ENOENT/
  );

  db.close();
});

test("Esri retryable current tile errors do not synthesize from parent or Wayback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const requestedUrls = [];

  await withEnv(
    {
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1",
      TILE_DOWNLOADER_ESRI_ENABLE_COOLDOWN: "0",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "1",
    },
    async () => {
      const result = await runDownloadJob({
        config: {
          jobName: "esri-no-retryable-synthesis",
          provider: "esri",
          layer: "satellite",
          format: "jpg",
          configHash: "hash",
          output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
          tile: { extension: "jpg", yScheme: "xyz", unavailableFallback: { maxParentZoomOffset: 4 } },
          url: { template: "https://example.test/{z}/{y}/{x}" },
          ranges: [
            { zoomStart: 14, zoomEnd: 14, xStart: 9863, xEnd: 9863, yStart: 5300, yEnd: 5300, label: "a" },
          ],
          platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
          performance: { maxRetries: 1, retryBackoffMs: 1, rowRecoveryPasses: 0 },
          verifyAfterDownload: false,
        },
        stateDb: db,
        progress: false,
        skipVerifyAfterDownload: true,
        fetchImpl: async (url) => {
          requestedUrls.push(String(url));
          return new Response("blocked", { status: 403 });
        },
      });

      assert.equal(result.tilesDownloaded, 0);
      assert.equal(result.tilesCreated, 0);
      assert.equal(result.tilesMissing, 0);
      assert.equal(result.tilesFailed, 1);
      assert.deepEqual(requestedUrls, ["https://example.test/14/5300/9863"]);
    }
  );

  db.close();
});

test("Esri existing unavailable placeholder files are redownloaded instead of skipped", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const placeholder = Buffer.from("esri unavailable placeholder");
  const replacement = Buffer.from("real imagery tile");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  const existingPath = path.join(dir, "tiles", "satellite", "14", "9603", "5824.jpg");
  let fetches = 0;

  await mkdir(path.dirname(existingPath), { recursive: true });
  await writeFile(existingPath, placeholder);

  const result = await runDownloadJob({
    config: {
      jobName: "esri-existing-unavailable",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      configHash: "hash",
      output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
      tile: { extension: "jpg", yScheme: "xyz", unavailableTileSha256: placeholderHash },
      url: { template: "https://example.test/{z}/{y}/{x}" },
      ranges: [
        { zoomStart: 14, zoomEnd: 14, xStart: 9603, xEnd: 9603, yStart: 5824, yEnd: 5824, label: "a" },
      ],
      platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
      performance: { maxRetries: 1, retryBackoffMs: 1, rowRecoveryPasses: 0 },
      verifyAfterDownload: false,
    },
    stateDb: db,
    progress: false,
    skipVerifyAfterDownload: true,
    fetchImpl: async () => {
      fetches++;
      return new Response(replacement, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    },
  });

  assert.equal(result.tilesDownloaded, 1);
  assert.equal(result.tileFilesSkipped, 0);
  assert.equal(result.tilesMissing, 0);
  assert.equal(result.tilesFailed, 0);
  assert.equal(fetches, 1);
  const saved = await stat(existingPath);
  assert.equal(saved.size, replacement.length);

  db.close();
});

test("Esri unavailable placeholders ignore legacy retry and proxy-block env overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const placeholder = Buffer.from("esri unavailable placeholder");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  const marked = [];
  let fetches = 0;
  const proxyRotation = {
    markProxyBlocked(protocolOrProxy, ms, proxy = null) {
      marked.push({ proxy: proxy || protocolOrProxy, protocolOrProxy, ms });
    },
    hasHealthyCandidate() {
      return true;
    },
  };

  await withEnv(
    {
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "2",
      TILE_DOWNLOADER_ESRI_RETRY_UNAVAILABLE: "1",
      TILE_DOWNLOADER_ESRI_BLOCK_PROXY_ON_UNAVAILABLE: "1",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "1",
    },
    async () => {
      const result = await runDownloadJob({
        config: {
          jobName: "esri-placeholder-no-retry-or-proxy-block",
          provider: "esri",
          layer: "satellite",
          format: "jpg",
          configHash: "hash",
          output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
          tile: { extension: "jpg", yScheme: "xyz", unavailableTileSha256: placeholderHash },
          url: { template: "https://example.test/{z}/{y}/{x}" },
          ranges: [
            { zoomStart: 14, zoomEnd: 14, xStart: 9603, xEnd: 9603, yStart: 5824, yEnd: 5824, label: "a" },
          ],
          platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
          performance: { maxRetries: 2, retryBackoffMs: 1, rowRecoveryPasses: 0 },
          verifyAfterDownload: false,
        },
        stateDb: db,
        progress: false,
        skipVerifyAfterDownload: true,
        env: process.env,
        proxyRotation,
        fetchImpl: async () => {
          fetches++;
          const response = new Response(placeholder, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
          response[PROXY_INFO_SYMBOL] = {
            proxy: "https://placeholder.proxy.example:8080",
            protocol: "https:",
            url: "https://example.test/14/5824/9603",
          };
          return response;
        },
      });

      assert.equal(result.tilesDownloaded, 0);
      assert.equal(result.tilesMissing, 1);
      assert.equal(result.tilesFailed, 0);
    }
  );

  assert.equal(fetches, 1);
  assert.deepEqual(marked, []);
  await assert.rejects(
    () => stat(path.join(dir, "tiles", "satellite", "14", "9603", "5824.jpg")),
    /ENOENT/
  );

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

test("range verification reports final failed tiles once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let fetches = 0;

  await withEnv({ TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1" }, async () => {
    const result = await runDownloadJob({
      config: {
        jobName: "verify-failure-count",
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
      rowRecoveryPasses: 0,
      recoveryBackoffMs: 1,
      fetchImpl: async () => {
        fetches++;
        return new Response("busy", { status: 500 });
      },
    });

    assert.equal(result.tilesDownloaded, 0);
    assert.equal(result.tilesFailed, 1);
    assert.equal(fetches, 2);
    const rangeState = db.db
      .prepare(
        `SELECT missing, failed, status FROM ranges
         WHERE job_name=? AND config_hash=? AND layer=? AND range_index=?`
      )
      .get("verify-failure-count", "hash", "satellite", 1);
    assert.deepEqual(rangeState, { missing: 0, failed: 1, status: "partial" });
  });

  db.close();
});

test("Esri fast mode skips range verification unless forced", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let verified = 0;

  const skippedVerify = await runDownloadJob({
    config: {
      jobName: "esri-fast-skip-verify",
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
    esriFastMode: true,
    fetchImpl: async () => new Response("tile"),
    onRangeVerified: () => verified++,
  });

  assert.equal(skippedVerify.rangesVerified, 0);
  assert.equal(verified, 0);

  const forcedVerify = await runDownloadJob({
    config: {
      jobName: "esri-fast-force-verify",
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
    esriFastMode: true,
    forceVerify: true,
    fetchImpl: async () => new Response("tile"),
    onRangeVerified: () => verified++,
  });

  assert.equal(forcedVerify.rangesVerified, 1);
  assert.equal(verified, 1);
  db.close();
});

test("Esri fast mode disables row recovery by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));

  await withEnv({ TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1" }, async () => {
    let defaultFetches = 0;
    const withRecovery = await runDownloadJob({
      config: {
        jobName: "esri-fast-row-recovery-off",
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
      },
      stateDb: db,
      progress: false,
      esriFastMode: false,
      fetchImpl: async () => {
        defaultFetches++;
        if (defaultFetches === 1) throw new Error("socket reset");
        return new Response("tile");
      },
    });

    let fastFetches = 0;
    const fast = await runDownloadJob({
      config: {
        jobName: "esri-fast-row-recovery-on",
        provider: "esri",
        layer: "satellite",
        format: "jpg",
        configHash: "hash",
        output: { dir: path.join(dir, "tiles"), pathTemplate: "{layer}/{z}/{x}/{y}.{extension}" },
        tile: { extension: "jpg", yScheme: "xyz" },
        url: { template: "https://example.test/{z}/{y}/{x}" },
        ranges: [
          { zoomStart: 1, zoomEnd: 1, xStart: 2, xEnd: 2, yStart: 1, yEnd: 1, label: "a" },
        ],
        platformProfile: { maxRowsInFlight: 1, perRowConcurrency: 1, requestTimeoutMs: 1000 },
        performance: { maxRetries: 1, retryBackoffMs: 1 },
      },
      stateDb: db,
      progress: false,
      esriFastMode: true,
      fetchImpl: async () => {
        fastFetches++;
        if (fastFetches === 1) throw new Error("socket reset");
        return new Response("tile");
      },
    });

    assert.equal(withRecovery.tilesDownloaded, 1);
    assert.equal(withRecovery.tilesFailed, 0);
    assert.equal(defaultFetches, 2);
    assert.equal(fast.tilesDownloaded, 0);
    assert.equal(fast.tilesFailed, 1);
    assert.equal(fastFetches, 1);
  });
  db.close();
});

test("Esri enters cooldown after repeated temporary block responses", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let fetches = 0;
  const sleeps = [];

  await withEnv(
    {
      TILE_DOWNLOADER_ESRI_BLOCK_THRESHOLD: "2",
      TILE_DOWNLOADER_ESRI_COOLDOWN_MS: "50",
      TILE_DOWNLOADER_ESRI_BLOCK_WINDOW_MS: "1000",
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "2",
      TILE_DOWNLOADER_ROW_RECOVERY_PASSES: "1",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "0",
    },
    async () => {
      const result = await runDownloadJob({
        config: {
          jobName: "esri-cooldown",
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
        env: {
          TILE_DOWNLOADER_ESRI_BLOCK_THRESHOLD: "2",
          TILE_DOWNLOADER_ESRI_COOLDOWN_MS: "50",
          TILE_DOWNLOADER_ESRI_BLOCK_WINDOW_MS: "1000",
          TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "2",
          TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "0",
        },
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
        fetchImpl: async () => {
          fetches++;
          if (fetches <= 2) return new Response("blocked", { status: 403 });
          return new Response("tile");
        },
      });

      assert.equal(result.tilesDownloaded, 1);
      assert.equal(result.tilesFailed, 0);
      assert.equal(fetches, 3);
      assert.ok(sleeps.some((ms) => ms >= 50));
    }
  );

  db.close();
});

test("Esri retries a blocked proxy and continues within tile retry budget", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let fetches = 0;
  const proxyRotation = {
    markProxyBlocked(proxy, ms) {},
    hasHealthyCandidate() {
      return true;
    },
  };

  const result = await runDownloadJob({
    config: {
      jobName: "esri-proxy-retry",
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
      performance: { maxRetries: 3, retryBackoffMs: 1 },
    },
    stateDb: db,
    progress: false,
    rowRecoveryPasses: 0,
    recoveryBackoffMs: 1,
    env: {
      TILE_DOWNLOADER_ESRI_BLOCK_THRESHOLD: "1",
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "2",
      TILE_DOWNLOADER_ESRI_PROXY_BLOCK_MS: "1000",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "0",
    },
    proxyRotation,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) {
        const response = new Response("blocked", { status: 403 });
        response[PROXY_INFO_SYMBOL] = {
          proxy: "https://blocked.proxy.example:8080",
          protocol: "https:",
          url: "https://example.test/1/1/1",
        };
        return response;
      }

      const response = new Response("tile");
      response[PROXY_INFO_SYMBOL] = {
        proxy: "https://good.proxy.example:8080",
        protocol: "https:",
        url: "https://example.test/1/1/1",
      };
      return response;
    },
  });

  assert.equal(fetches, 2);
  assert.equal(result.tilesDownloaded, 1);
  assert.equal(result.tilesFailed, 0);
  db.close();
});

test("Esri proxy transport errors do not consume source retry budget", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  let fetches = 0;

  const result = await runDownloadJob({
    config: {
      jobName: "esri-proxy-transport-retry",
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
      performance: { maxRetries: 2, retryBackoffMs: 1 },
      verifyAfterDownload: false,
    },
    stateDb: db,
    progress: false,
    skipVerifyAfterDownload: true,
    rowRecoveryPasses: 0,
    recoveryBackoffMs: 1,
    env: {
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "2",
      TILE_DOWNLOADER_ESRI_PROXY_TRANSPORT_RETRIES: "5",
      TILE_DOWNLOADER_ESRI_UNAVAILABLE_FALLBACK: "0",
    },
    proxyRotation: {
      hasHealthyCandidate() {
        return true;
      },
    },
    fetchImpl: async () => {
      fetches += 1;
      if (fetches <= 4) {
        const error = new Error("proxy socket reset");
        error[PROXY_INFO_SYMBOL] = {
          proxy: `https://proxy-${fetches}.example:8080`,
          protocol: "https:",
          url: "https://example.test/1/1/1",
          error: true,
        };
        throw error;
      }
      return new Response("tile");
    },
  });

  assert.equal(fetches, 5);
  assert.equal(result.tilesDownloaded, 1);
  assert.equal(result.tilesFailed, 0);
  db.close();
});

test("Esri blocks a proxy after the first 403 by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const marked = [];
  const lines = [];
  const proxyUrl = "https://blocked.proxy.example:8080";
  const proxyRotation = {
    markProxyBlocked(protocolOrProxy, ms, proxy = null) {
      marked.push({ proxy: proxy || protocolOrProxy, protocolOrProxy, ms });
    },
    healthyCandidateCount() {
      return 4;
    },
    candidateCount() {
      return 5;
    },
    hasHealthyCandidate() {
      return true;
    },
  };
  const originalLog = console.log;
  console.log = (message) => {
    lines.push(String(message));
  };

  try {
    await withEnv({ TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1" }, async () => {
      await runDownloadJob({
        config: {
          jobName: "esri-proxy-default-block",
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
          verifyAfterDownload: false,
        },
        stateDb: db,
        progress: true,
        rowRecoveryPasses: 0,
        proxyRotation,
        fetchImpl: async () => {
          const response = new Response("blocked", { status: 403 });
          response[PROXY_INFO_SYMBOL] = {
            proxy: proxyUrl,
            protocol: "https:",
            url: "https://example.test/1/1/1",
          };
          return response;
        },
      });
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(marked.length, 1);
  assert.equal(marked[0].proxy, proxyUrl);
  assert.ok(lines.some((line) => line.includes("proxy 차단 status=403") && line.includes("remaining=4/5")), lines.join("\n"));
  db.close();
});

test("Esri 403/429 responses mark the proxy as blocked for configured duration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-engine-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const marked = [];
  const blockMs = 24 * 60 * 60 * 1000;
  const proxyUrl = "https://blocked.proxy.example:8080";
  const proxyRotation = {
    markProxyBlocked(protocolOrProxy, ms, proxy = null) {
      marked.push({ proxy: proxy || protocolOrProxy, protocolOrProxy, ms });
    },
  };

  await withEnv(
    {
      TILE_DOWNLOADER_ESRI_BLOCK_THRESHOLD: "1",
      TILE_DOWNLOADER_ESRI_COOLDOWN_MS: "10",
      TILE_DOWNLOADER_ESRI_BLOCK_WINDOW_MS: "1000",
      TILE_DOWNLOADER_ESRI_MIN_TILE_RETRIES: "1",
      TILE_DOWNLOADER_ESRI_PROXY_BLOCK_MS: String(blockMs),
      TILE_DOWNLOADER_ROW_RECOVERY_PASSES: "0",
    },
    async () => {
      const result = await runDownloadJob({
        config: {
          jobName: "esri-proxy-block",
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
        },
        stateDb: db,
        progress: false,
        env: process.env,
        proxyRotation,
        fetchImpl: async () => {
          const response = new Response("blocked", { status: 403 });
          response[PROXY_INFO_SYMBOL] = {
            proxy: proxyUrl,
            protocol: "https:",
            url: "https://example.test/1/1/1",
          };
          return response;
        },
      });

      assert.equal(marked.length, 1);
      assert.equal(marked[0].proxy, proxyUrl);
      assert.equal(marked[0].ms, blockMs);
      assert.equal(result.tilesFailed, 1);
      assert.equal(result.tilesDownloaded, 0);
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

test("verified range state is rechecked against output files on resume", async () => {
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

  assert.equal(result.rangesSkippedVerified, 0);
  assert.equal(result.rangesVerified, 2);
  assert.equal(result.tilesDownloaded, 2);
  assert.equal(verified, 2);
  db.close();
});
