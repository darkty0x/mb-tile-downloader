import test from "node:test";
import assert from "node:assert/strict";

import { splitConfigByRows } from "../src/config/config-splitter.js";

test("splits config ranges into numbered balanced machine configs", () => {
  const raw = {
    jobName: "mapbox-pbf",
    provider: "mapbox",
    layer: "vector",
    format: "pbf",
    ranges: [
      { zoom: 4, xStart: 1, xEnd: 4, yStart: 10, yEnd: 12 },
    ],
  };

  const split = splitConfigByRows(raw, { parts: 2 });

  assert.equal(split.length, 2);
  assert.equal(split[0].name, "001");
  assert.equal(split[1].name, "002");
  assert.equal(split[0].config.jobName, "mapbox-pbf-001");
  assert.equal(split[1].config.jobName, "mapbox-pbf-002");
  assert.equal(
    split.reduce((sum, item) => sum + item.config.ranges.length, 0),
    4
  );
});

test("uses explicit machine names when provided", () => {
  const raw = {
    jobName: "esri-satellite",
    provider: "esri",
    ranges: [
      { zoom: 2, xStart: 1, xEnd: 2, yStart: 1, yEnd: 1 },
    ],
  };

  const split = splitConfigByRows(raw, { names: ["cig", "cmi"] });

  assert.deepEqual(split.map((item) => item.name), ["cig", "cmi"]);
  assert.deepEqual(split.map((item) => item.config.jobName), [
    "esri-satellite-cig",
    "esri-satellite-cmi",
  ]);
});

test("rejects splits that would create empty machine configs", () => {
  assert.throws(
    () =>
      splitConfigByRows(
        {
          jobName: "tiny",
          provider: "mapbox",
          ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
        },
        { parts: 2 }
      ),
    /more split targets than rows/
  );
});
