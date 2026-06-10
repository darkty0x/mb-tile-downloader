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
