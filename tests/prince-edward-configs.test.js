import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { loadConfig } from "../src/config/config-loader.js";

function tileCount(ranges) {
  return ranges.reduce((sum, range) => sum + (range.xEnd - range.xStart + 1) * (range.yEnd - range.yStart + 1), 0);
}

test("numbered PBF, Mapbox satellite, and Esri satellite config sets share validated ranges", async () => {
  const files = await readdir("configs");
  const ids = files
    .map((file) => file.match(/^(\d+)-mapbox-pbf\.config\.json$/)?.[1])
    .filter(Boolean)
    .filter(
      (id) =>
        files.includes(`${id}-mapbox-satellite.config.json`) &&
        files.includes(`${id}-esri-satellite.config.json`),
    )
    .sort((a, b) => Number(a) - Number(b));

  assert.ok(ids.length > 0);
  for (const expectedId of ["4", "7", "9", "22"]) {
    assert.ok(ids.includes(expectedId), `missing numbered config set ${expectedId}`);
  }

  for (const id of ids) {
    const pbfPath = `configs/${id}-mapbox-pbf.config.json`;
    const satellitePath = `configs/${id}-mapbox-satellite.config.json`;
    const esriPath = `configs/${id}-esri-satellite.config.json`;
    const pbfRaw = JSON.parse(await readFile(pbfPath, "utf8"));
    const satelliteRaw = JSON.parse(await readFile(satellitePath, "utf8"));
    const esriRaw = JSON.parse(await readFile(esriPath, "utf8"));

    assert.deepEqual(satelliteRaw.ranges, pbfRaw.ranges);
    assert.deepEqual(esriRaw.ranges, pbfRaw.ranges);
    assert.ok(tileCount(pbfRaw.ranges) > 0);

    const pbf = await loadConfig(pbfPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    const satellite = await loadConfig(satellitePath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    const esri = await loadConfig(esriPath, { env: {}, platform: "linux" });

    assert.equal(pbf.layer, "vector");
    assert.equal(pbf.format, "pbf");
    assert.equal(pbf.tile.extension, "vector.pbf");
    assert.equal(satellite.layer, "satellite");
    assert.equal(satellite.format, "jpg");
    assert.equal(satellite.tile.extension, "jpg");
    assert.equal(esri.layer, "esri-satellite");
    assert.equal(esri.format, "jpg");
    assert.equal(esri.tile.extension, "jpg");
    assert.equal(tileCount(satellite.ranges), tileCount(pbf.ranges));
    assert.equal(tileCount(esri.ranges), tileCount(pbf.ranges));
  }
});
