import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, normalizeRanges } from "../src/config/config-loader.js";

test("normalizes compact ranges and produces a stable config hash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-config-"));
  const configPath = path.join(dir, "mapbox-pbf.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "pbf-test",
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      url: { tileset: "mapbox.test", extension: "vector.pbf" },
      output: { dir: "./tiles" },
      ranges: [{ zoom: 12, xStart: 1, xEnd: 2, yStart: 3, yEnd: 4 }],
    })
  );

  const loaded = await loadConfig(configPath, {
    env: { MAPBOX_ACCESS_TOKENS: "token-a" },
    platform: "linux",
  });

  assert.equal(loaded.provider, "mapbox");
  assert.equal(loaded.ranges[0].zoomStart, 12);
  assert.equal(loaded.ranges[0].zoomEnd, 12);
  assert.match(loaded.configHash, /^[a-f0-9]{64}$/);
  assert.equal(loaded.output.dir, path.join(dir, "tiles"));
  assert.equal(loaded.verifyAfterDownload, true);
});

test("dynamic output mode discovers non-project drive roots without editing config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-config-"));
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "esri-dynamic",
      provider: "esri",
      output: { dir: "./tiles" },
      ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    })
  );

  const config = await loadConfig(configPath, {
    env: {
      TILE_DOWNLOADER_OUTPUT_MODE: "dynamic",
      TILE_DOWNLOADER_OUTPUT_FOLDER: "mb-tile-downloader/tiles",
      TILE_DOWNLOADER_OUTPUT_MIN_FREE_GB: "1",
    },
    platform: "win32",
    projectDir: "C:\\mb-tile-downloader",
    collectDiskInfoImpl: async () => [
      { name: "C:", mount: "C:", freeBytes: 100 * 1024 ** 3, percentUsed: 80, containsProject: true },
      { name: "D:", mount: "D:", freeBytes: 800 * 1024 ** 3, percentUsed: 10 },
      { name: "E:", mount: "E:", freeBytes: 500 * 1024 ** 3, percentUsed: 20 },
    ],
  });

  assert.equal(config.output.storageMode, "dynamic");
  assert.equal(config.output.dirs.length, 2);
  assert.match(config.output.dirs[0], /D:[\\/]+mb-tile-downloader[\\/]+tiles$/);
  assert.match(config.output.dirs[1], /E:[\\/]+mb-tile-downloader[\\/]+tiles$/);
});

test("rejects Mapbox configs without token environment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-config-"));
  const configPath = path.join(dir, "mapbox-pbf.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "pbf-test",
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      url: { tileset: "mapbox.test", extension: "vector.pbf" },
      output: { dir: "./tiles" },
      ranges: [{ zoom: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1 }],
    })
  );

  await assert.rejects(
    () => loadConfig(configPath, { env: {}, platform: "linux" }),
    /MAPBOX_ACCESS_TOKENS/
  );
});

test("normalizeRanges supports legacy top-level range fields", () => {
  const ranges = normalizeRanges({
    zoomStart: 5,
    zoomEnd: 6,
    xStart: 10,
    xEnd: 11,
    yStart: 12,
    yEnd: 13,
  });

  assert.deepEqual(ranges[0], {
    zoomStart: 5,
    zoomEnd: 6,
    xStart: 10,
    xEnd: 11,
    yStart: 12,
    yEnd: 13,
    label: "legacy-range",
  });
});

test("rejects coordinates outside the slippy-map bounds for a zoom", () => {
  assert.throws(
    () =>
      normalizeRanges({
        ranges: [{ zoom: 2, xStart: 0, xEnd: 4, yStart: 0, yEnd: 0 }],
      }),
    /outside valid tile bounds/
  );
});

test("Esri World Imagery configs use separate layer folder and xyz rows", async () => {
  for (const configPath of [
    "configs/esri-satellite.config.json",
    "configs/13-esri-satellite.config.json",
  ]) {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(raw.provider, "esri");
    assert.equal(raw.layer, "esri-satellite");
    assert.equal(raw.tile?.yScheme, "xyz");
  }
});

test("Ukraine z19 split configs auto-correct TMS y ranges to XYZ without editing config files", async () => {
  const raw = JSON.parse(await readFile("configs/ukraine-z19-part-003-esri-satellite.config.json", "utf8"));
  assert.equal(raw.ranges[0].yStart, 339498);
  assert.equal(raw.ranges[0].yEnd, 351754);

  const config = await loadConfig("configs/ukraine-z19-part-003-esri-satellite.config.json", {
    env: {},
    platform: "win32",
    defaultProxyFilePath: null,
  });

  assert.equal(config.ranges[0].yStart, 172533);
  assert.equal(config.ranges[0].yEnd, 184789);
  assert.match(config.ranges[0].label, /y=tms->xyz/);
  assert.equal(config.ranges[0].autoCorrectedY, "tms-to-xyz");
  assert.equal(config.tile.unavailableFallback.autoEnabled, true);
  assert.equal(config.tile.unavailableFallback.source, "current");
});

test("loaded direct Esri configs keep requested config concurrency", async () => {
  const config = await loadConfig("configs/13-esri-satellite.config.json", {
    env: {},
    platform: "win32",
    defaultProxyFilePath: null,
  });

  assert.equal(config.performance.maxConcurrentRequests, 4096);
  assert.equal(config.platformProfile.maxConcurrentRequests, 4096);
  assert.equal(config.platformProfile.perRowConcurrency, 4096);
});

test("loaded Esri configs keep requested concurrency when proxy source is configured", async () => {
  const config = await loadConfig("configs/13-esri-satellite.config.json", {
    env: { TILE_DOWNLOADER_PROXY_LIST: "http://proxy-a.example:8080" },
    platform: "win32",
  });

  assert.equal(config.performance.maxConcurrentRequests, 4096);
  assert.equal(config.platformProfile.maxConcurrentRequests, 4096);
  assert.equal(config.platformProfile.perRowConcurrency, 4096);
});
