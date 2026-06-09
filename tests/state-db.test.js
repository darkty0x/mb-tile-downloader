import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TileStateDb } from "../src/state/state-db.js";

test("skips complete rows only when config hash matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-state-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));

  db.upsertJob({ jobName: "job", provider: "mapbox", configHash: "hash-a" });
  db.markRowComplete({
    jobName: "job",
    configHash: "hash-a",
    layer: "vector",
    z: 12,
    x: 34,
    yStart: 1,
    yEnd: 3,
    expected: 3,
    downloaded: 3,
    missing: 0,
    failed: 0,
  });

  assert.equal(
    db.shouldSkipRow({
      jobName: "job",
      configHash: "hash-a",
      layer: "vector",
      z: 12,
      x: 34,
      yStart: 1,
      yEnd: 3,
    }),
    true
  );

  assert.equal(
    db.shouldSkipRow({
      jobName: "job",
      configHash: "hash-b",
      layer: "vector",
      z: 12,
      x: 34,
      yStart: 1,
      yEnd: 3,
    }),
    false
  );

  db.close();
});

test("tracks completed range verification by config hash and range index", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-state-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));

  db.markRangeVerified({
    jobName: "job",
    configHash: "hash-a",
    layer: "vector",
    rangeIndex: 49,
    label: "range 49",
    expected: 10,
    present: 10,
    missing: 0,
  });

  assert.equal(
    db.shouldSkipRange({
      jobName: "job",
      configHash: "hash-a",
      layer: "vector",
      rangeIndex: 49,
    }),
    true
  );
  assert.equal(
    db.shouldSkipRange({
      jobName: "job",
      configHash: "hash-b",
      layer: "vector",
      rangeIndex: 49,
    }),
    false
  );
  db.close();
});

test("archived tile source invalidates range and row resume state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "state-db-"));
  const db = new TileStateDb(path.join(dir, "state.sqlite"));
  const key = {
    jobName: "archive",
    configHash: "hash",
    layer: "vector",
    z: 5,
    x: 27,
    yStart: 19,
    yEnd: 19,
  };
  db.markRowComplete({
    ...key,
    expected: 1,
    downloaded: 1,
    missing: 0,
    failed: 0,
  });
  db.markRangeVerified({
    jobName: "archive",
    configHash: "hash",
    layer: "vector",
    rangeIndex: 1,
    label: "r",
    expected: 1,
    present: 1,
    missing: 0,
  });

  assert.equal(db.shouldSkipRow(key), true);
  assert.equal(
    db.shouldSkipRange({
      jobName: "archive",
      configHash: "hash",
      layer: "vector",
      rangeIndex: 1,
    }),
    true
  );

  db.markArchivedTiles({
    jobName: "archive",
    configHash: "hash",
    layer: "vector",
    rangeIndex: 1,
    label: "r",
    z: 5,
    xStart: 27,
    xEnd: 27,
    yStart: 19,
    yEnd: 19,
    expected: 1,
  });

  assert.equal(db.shouldSkipRow(key), false);
  assert.equal(
    db.shouldSkipRange({
      jobName: "archive",
      configHash: "hash",
      layer: "vector",
      rangeIndex: 1,
    }),
    false
  );
  db.close();
});
