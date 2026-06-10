import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { loadConfig } from "../src/config/config-loader.js";

const assignees = ["mcs", "kuh", "rhc", "kyj", "cig", "cmi"];
const expectedTileCounts = {
  mcs: 79459567,
  kuh: 79469468,
  rhc: 79452851,
  kyj: 79453493,
  cig: 79453494,
  cmi: 79454768,
};

function tileCount(ranges) {
  return ranges.reduce((sum, range) => sum + (range.xEnd - range.xStart + 1) * (range.yEnd - range.yStart + 1), 0);
}

test("Prince Edward per-user PBF and satellite configs share validated ranges", async () => {
  for (const assignee of assignees) {
    const pbfPath = `configs/prince-edward-mapbox-pbf-${assignee}.config.json`;
    const satellitePath = `configs/prince-edward-mapbox-satellite-${assignee}.config.json`;
    const pbfRaw = JSON.parse(await readFile(pbfPath, "utf8"));
    const satelliteRaw = JSON.parse(await readFile(satellitePath, "utf8"));

    assert.deepEqual(satelliteRaw.ranges, pbfRaw.ranges);
    assert.equal(tileCount(pbfRaw.ranges), expectedTileCounts[assignee]);

    const pbf = await loadConfig(pbfPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    const satellite = await loadConfig(satellitePath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });

    assert.equal(pbf.layer, "vector");
    assert.equal(pbf.format, "pbf");
    assert.equal(pbf.tile.extension, "vector.pbf");
    assert.equal(satellite.layer, "satellite");
    assert.equal(satellite.format, "jpg");
    assert.equal(satellite.tile.extension, "jpg");
    assert.equal(tileCount(pbf.ranges), expectedTileCounts[assignee]);
    assert.equal(tileCount(satellite.ranges), expectedTileCounts[assignee]);
  }
});
