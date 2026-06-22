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
    split.reduce(
      (sum, item) =>
        sum +
        item.config.ranges.reduce(
          (rangeSum, range) => rangeSum + (range.xEnd - range.xStart + 1) * (range.yEnd - range.yStart + 1),
          0
        ),
      0
    ),
    12
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

test("splits a single contiguous range into contiguous machine ranges", () => {
  const raw = {
    jobName: "esri-satellite",
    provider: "esri",
    ranges: [
      {
        zoom: 12,
        xStart: 2388,
        xEnd: 2395,
        yStart: 1377,
        yEnd: 1388,
        label: "bounds z=12",
      },
    ],
  };

  const split = splitConfigByRows(raw, { names: ["server-01", "server-02"] });

  assert.deepEqual(
    split.map((item) => item.config.ranges),
    [
      [
        {
          zoom: 12,
          xStart: 2388,
          xEnd: 2391,
          yStart: 1377,
          yEnd: 1388,
          label: "bounds z=12 x=2388-2391",
        },
      ],
      [
        {
          zoom: 12,
          xStart: 2392,
          xEnd: 2395,
          yStart: 1377,
          yEnd: 1388,
          label: "bounds z=12 x=2392-2395",
        },
      ],
    ]
  );
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
