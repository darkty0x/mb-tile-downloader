import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { loadConfig } from "../src/config/config-loader.js";

function tileCount(ranges) {
  return ranges.reduce((sum, range) => sum + (range.xEnd - range.xStart + 1) * (range.yEnd - range.yStart + 1), 0);
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const latRad = lat * Math.PI / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n),
  };
}

async function assertProviderSet({ pbfPath, satellitePath, esriPath }) {
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

test("PBF, Mapbox satellite, and Esri satellite config sets share validated ranges", async () => {
  const files = await readdir("configs");
  const ids = files
    .map((file) => file.match(/^(.+)-mapbox-pbf\.config\.json$/)?.[1])
    .filter(Boolean)
    .filter(
      (id) =>
        files.includes(`${id}-mapbox-satellite.config.json`) &&
        files.includes(`${id}-esri-satellite.config.json`),
    )
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const id of ids) {
    await assertProviderSet({
      pbfPath: `configs/${id}-mapbox-pbf.config.json`,
      satellitePath: `configs/${id}-mapbox-satellite.config.json`,
      esriPath: `configs/${id}-esri-satellite.config.json`,
    });
  }

  for (const machine of ["cmi", "cig", "kyj", "rhc", "kuh"]) {
    await assertProviderSet({
      pbfPath: `configs/1-ukraine-mapbox-pbf-${machine}.config.json`,
      satellitePath: `configs/1-ukraine-mapbox-satellite-${machine}.config.json`,
      esriPath: `configs/1-ukraine-esri-satellite-${machine}.config.json`,
    });
  }
});

test("Samsung Pyeongtaek site 17 configs cover P5 campus coordinate", async () => {
  const paths = [
    "configs/17-mapbox-pbf.config.json",
    "configs/17-mapbox-satellite.config.json",
    "configs/17-esri-satellite.config.json",
  ];
  const lon = 127.0456925;
  const lat = 37.031464;

  for (const configPath of paths) {
    const config = await loadConfig(configPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    for (const range of config.ranges) {
      const z = range.zoomStart;
      const tile = lonLatToTile(lon, lat, z);
      assert.ok(
        tile.x >= range.xStart && tile.x <= range.xEnd && tile.y >= range.yStart && tile.y <= range.yEnd,
        `${configPath} z${z} does not contain Samsung Pyeongtaek coordinate tile ${tile.x}/${tile.y}`,
      );
    }

    const z18 = config.ranges.find((range) => range.zoomStart === 18);
    const z19 = config.ranges.find((range) => range.zoomStart === 19);
    assert.deepEqual(
      { xStart: z18.xStart, xEnd: z18.xEnd, yStart: z18.yStart, yEnd: z18.yEnd },
      { xStart: 223574, xEnd: 223593, yStart: 101996, yEnd: 102015 },
    );
    assert.deepEqual(
      { xStart: z19.xStart, xEnd: z19.xEnd, yStart: z19.yStart, yEnd: z19.yEnd },
      { xStart: 447148, xEnd: 447186, yStart: 203992, yEnd: 204030 },
    );
  }
});

test("Desiderio Army Airfield site 14 configs cover Pyeongtaek coordinate", async () => {
  const paths = [
    "configs/14-mapbox-pbf.config.json",
    "configs/14-mapbox-satellite.config.json",
    "configs/14-esri-satellite.config.json",
  ];
  const lon = 127.0260786;
  const lat = 36.9619266;

  for (const configPath of paths) {
    const config = await loadConfig(configPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    for (const range of config.ranges) {
      const z = range.zoomStart;
      const tile = lonLatToTile(lon, lat, z);
      assert.ok(
        tile.x >= range.xStart && tile.x <= range.xEnd && tile.y >= range.yStart && tile.y <= range.yEnd,
        `${configPath} z${z} does not contain Desiderio Army Airfield coordinate tile ${tile.x}/${tile.y}`,
      );
    }

    const z18 = config.ranges.find((range) => range.zoomStart === 18);
    const z19 = config.ranges.find((range) => range.zoomStart === 19);
    assert.deepEqual(
      { xStart: z18.xStart, xEnd: z18.xEnd, yStart: z18.yStart, yEnd: z18.yEnd },
      { xStart: 223552, xEnd: 223586, yStart: 102051, yEnd: 102086 },
    );
    assert.deepEqual(
      { xStart: z19.xStart, xEnd: z19.xEnd, yStart: z19.yStart, yEnd: z19.yEnd },
      { xStart: 447104, xEnd: 447173, yStart: 204103, yEnd: 204172 },
    );
  }
});

test("SK Yongin Semiconductor Cluster site 15 configs cover Wonsam coordinate", async () => {
  const paths = [
    "configs/15-mapbox-pbf.config.json",
    "configs/15-mapbox-satellite.config.json",
    "configs/15-esri-satellite.config.json",
  ];
  const lon = 127.312444;
  const lat = 37.1518385;

  for (const configPath of paths) {
    const config = await loadConfig(configPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    for (const range of config.ranges) {
      const z = range.zoomStart;
      const tile = lonLatToTile(lon, lat, z);
      assert.ok(
        tile.x >= range.xStart && tile.x <= range.xEnd && tile.y >= range.yStart && tile.y <= range.yEnd,
        `${configPath} z${z} does not contain SK Yongin coordinate tile ${tile.x}/${tile.y}`,
      );
    }

    const z18 = config.ranges.find((range) => range.zoomStart === 18);
    const z19 = config.ranges.find((range) => range.zoomStart === 19);
    assert.deepEqual(
      { xStart: z18.xStart, xEnd: z18.xEnd, yStart: z18.yStart, yEnd: z18.yEnd },
      { xStart: 223766, xEnd: 223789, yStart: 101884, yEnd: 101907 },
    );
    assert.deepEqual(
      { xStart: z19.xStart, xEnd: z19.xEnd, yStart: z19.yStart, yEnd: z19.yEnd },
      { xStart: 447533, xEnd: 447578, yStart: 203768, yEnd: 203814 },
    );
  }
});

test("SK Hynix Cheongju site 16 configs cover P&T7 coordinate", async () => {
  const paths = [
    "configs/16-mapbox-pbf.config.json",
    "configs/16-mapbox-satellite.config.json",
    "configs/16-esri-satellite.config.json",
  ];
  const lon = 127.42997222222223;
  const lat = 36.66097222222222;

  for (const configPath of paths) {
    const config = await loadConfig(configPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    for (const range of config.ranges) {
      const z = range.zoomStart;
      const tile = lonLatToTile(lon, lat, z);
      assert.ok(
        tile.x >= range.xStart && tile.x <= range.xEnd && tile.y >= range.yStart && tile.y <= range.yEnd,
        `${configPath} z${z} does not contain SK Hynix Cheongju coordinate tile ${tile.x}/${tile.y}`,
      );
    }

    const z18 = config.ranges.find((range) => range.zoomStart === 18);
    const z19 = config.ranges.find((range) => range.zoomStart === 19);
    assert.deepEqual(
      { xStart: z18.xStart, xEnd: z18.xEnd, yStart: z18.yStart, yEnd: z18.yEnd },
      { xStart: 223853, xEnd: 223873, yStart: 102332, yEnd: 102352 },
    );
    assert.deepEqual(
      { xStart: z19.xStart, xEnd: z19.xEnd, yStart: z19.yStart, yEnd: z19.yEnd },
      { xStart: 447707, xEnd: 447746, yStart: 204665, yEnd: 204705 },
    );
  }
});

test("LG U+ Paju site 18 configs cover Deogeun-ri 1239-1 coordinate", async () => {
  const paths = [
    "configs/18-mapbox-pbf.config.json",
    "configs/18-mapbox-satellite.config.json",
    "configs/18-esri-satellite.config.json",
  ];
  const lon = 126.7559632;
  const lat = 37.8148274;

  for (const configPath of paths) {
    const config = await loadConfig(configPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    for (const range of config.ranges) {
      const z = range.zoomStart;
      const tile = lonLatToTile(lon, lat, z);
      assert.ok(
        tile.x >= range.xStart && tile.x <= range.xEnd && tile.y >= range.yStart && tile.y <= range.yEnd,
        `${configPath} z${z} does not contain LG U+ Paju coordinate tile ${tile.x}/${tile.y}`,
      );
    }

    const z18 = config.ranges.find((range) => range.zoomStart === 18);
    const z19 = config.ranges.find((range) => range.zoomStart === 19);
    assert.deepEqual(
      { xStart: z18.xStart, xEnd: z18.xEnd, yStart: z18.yStart, yEnd: z18.yEnd },
      { xStart: 223366, xEnd: 223378, yStart: 101281, yEnd: 101293 },
    );
    assert.deepEqual(
      { xStart: z19.xStart, xEnd: z19.xEnd, yStart: z19.yStart, yEnd: z19.yEnd },
      { xStart: 446733, xEnd: 446757, yStart: 202562, yEnd: 202586 },
    );
  }
});

test("SK-AWS Ulsan site 20 configs cover Yongyeon-dong coordinate", async () => {
  const paths = [
    "configs/20-mapbox-pbf.config.json",
    "configs/20-mapbox-satellite.config.json",
    "configs/20-esri-satellite.config.json",
  ];
  const lon = 129.3665054;
  const lat = 35.4667415;

  for (const configPath of paths) {
    const config = await loadConfig(configPath, { env: { MAPBOX_ACCESS_TOKENS: "token-a" }, platform: "linux" });
    for (const range of config.ranges) {
      const z = range.zoomStart;
      const tile = lonLatToTile(lon, lat, z);
      assert.ok(
        tile.x >= range.xStart && tile.x <= range.xEnd && tile.y >= range.yStart && tile.y <= range.yEnd,
        `${configPath} z${z} does not contain SK-AWS Ulsan coordinate tile ${tile.x}/${tile.y}`,
      );
    }

    const z18 = config.ranges.find((range) => range.zoomStart === 18);
    const z19 = config.ranges.find((range) => range.zoomStart === 19);
    assert.deepEqual(
      { xStart: z18.xStart, xEnd: z18.xEnd, yStart: z18.yStart, yEnd: z18.yEnd },
      { xStart: 225244, xEnd: 225303, yStart: 103389, yEnd: 103447 },
    );
    assert.deepEqual(
      { xStart: z19.xStart, xEnd: z19.xEnd, yStart: z19.yStart, yEnd: z19.yEnd },
      { xStart: 450488, xEnd: 450606, yStart: 206778, yEnd: 206895 },
    );
  }
});
