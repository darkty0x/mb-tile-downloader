import test from "node:test";
import assert from "node:assert/strict";

import { createMapboxProvider } from "../src/providers/mapbox.js";
import { createEsriProvider } from "../src/providers/esri.js";
import { MapboxTokenPool } from "../src/auth/mapbox-token-pool.js";

test("Mapbox provider renders arbitrary tileset URLs with current token", () => {
  const provider = createMapboxProvider({
    layer: "vector",
    tile: { extension: "vector.pbf" },
    url: {
      hosts: ["a"],
      tileset: "mapbox.streets",
      template:
        "https://{host}.tiles.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{extension}?access_token={token}",
    },
  });
  const pool = new MapboxTokenPool(["token-a"]);

  assert.equal(
    provider.buildUrl({ z: 1, x: 2, y: 3, tokenPool: pool }),
    "https://a.tiles.mapbox.com/v4/mapbox.streets/1/2/3.vector.pbf?access_token=token-a"
  );
});

test("Mapbox provider keeps composite tilesets and style query values intact", () => {
  const provider = createMapboxProvider({
    layer: "vector",
    tile: { extension: "mvt" },
    url: {
      hosts: ["a"],
      tileset: "mapbox.streets,mapbox.terrain",
      style: "mapbox://styles/mapbox/streets-v12@00",
      template:
        "https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{extension}?style={style}&access_token={token}",
    },
  });
  const pool = new MapboxTokenPool(["token-a"]);

  assert.equal(
    provider.buildUrl({ z: 12, x: 1171, y: 1566, tokenPool: pool }),
    "https://api.mapbox.com/v4/mapbox.streets,mapbox.terrain/12/1171/1566.mvt?style=mapbox://styles/mapbox/streets-v12@00&access_token=token-a"
  );
});

test("Mapbox provider classifies auth and quota failures as token failures", () => {
  const provider = createMapboxProvider({
    layer: "vector",
    tile: { extension: "vector.pbf" },
    url: { hosts: ["a"], tileset: "mapbox.streets" },
  });

  assert.equal(provider.classifyResponse({ status: 401 }).status, "token-invalid");
  assert.equal(provider.classifyResponse({ status: 403 }).status, "token-exhausted");
  assert.equal(provider.classifyResponse({ status: 429 }).status, "retry");
});

test("Esri provider supports TMS request y conversion", () => {
  const provider = createEsriProvider({
    layer: "satellite",
    tile: { extension: "jpg", yScheme: "tms" },
    url: { template: "https://example.test/tile/{z}/{y}/{x}" },
  });

  assert.equal(
    provider.buildUrl({ z: 2, x: 1, y: 0 }),
    "https://example.test/tile/2/3/1"
  );
});

test("Esri provider accepts comma-separated unavailable tile hashes", () => {
  const hash = "9eafd300d61393184a4abc1d458564cfd1cd9b6f9c4e9c74687045c0a0e5b858";
  const provider = createEsriProvider({
    layer: "satellite",
    tile: { extension: "jpg", unavailableTileSha256: `${hash}, abc` },
    url: { template: "https://example.test/tile/{z}/{y}/{x}" },
  });

  assert.equal(provider.isUnavailable(Buffer.from("not-the-placeholder")), false);
});
