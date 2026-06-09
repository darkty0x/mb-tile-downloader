import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { loadConfig } from "../src/config/config-loader.js";
import { TileStateDb } from "../src/state/state-db.js";

const execFileAsync = promisify(execFile);

test("zip-maker uses downloader config output.dir, layer, and tile extension", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, "--dry-run", `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  assert.match(stdout, new RegExp(`Tiles directory: ${tilesDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(stdout, /Layers: vector/);
  assert.match(stdout, /DRY RUN: would zip 1 files/);
  assert.doesNotMatch(stdout, /WAIT incomplete/);
});

test("zip-maker names archives uniquely when ranges share z and x but differ by y", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "11", "1738"), { recursive: true });
  await mkdir(path.join(tilesDir, "vector", "11", "1739"), { recursive: true });
  for (const x of [1738, 1739]) {
    for (const y of [1264, 1265, 1266]) {
      await writeFile(path.join(tilesDir, "vector", "11", String(x), `${y}.vector.pbf`), "tile");
    }
  }

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [
        { zoom: 11, xStart: 1738, xEnd: 1739, yStart: 1264, yEnd: 1265 },
        { zoom: 11, xStart: 1738, xEnd: 1739, yStart: 1266, yEnd: 1266 },
      ],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, "--dry-run", `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  assert.match(stdout, /tiles_vector_11_001738-001739_y001264-001265\.zip/);
  assert.match(stdout, /tiles_vector_11_001738-001739_y001266-001266\.zip/);
});

test("zip-maker deduplicates identical ranges before archiving", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [
        { zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 },
        { zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 },
      ],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, "--dry-run", `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  assert.equal(stdout.match(/DRY RUN: would zip/g)?.length, 1);
  assert.match(stdout, /Duplicate ranges skipped: 1/);
});

test("zip-maker always runs one archive task at a time", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      archiveConcurrency: 8,
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, "--dry-run", `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  assert.match(stdout, /Archive concurrency: 1/);
});

test("zip-maker uses direct read mode by default for faster small tile archives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, "--dry-run", `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  assert.match(stdout, /ZIP read mode: direct/);
  assert.match(stdout, /ZIP write buffer: 256 MiB/);
});

test("zip-maker rejects archive filename collisions for different ranges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      fileNameTemplate: "tiles_{layer}_{z}_{xStart}-{xEnd}.zip",
      ranges: [
        { zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 },
        { zoom: 5, xStart: 27, xEnd: 27, yStart: 20, yEnd: 20 },
      ],
    })
  );

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        ["zip-maker.js", configPath, "--dry-run", `--archive-dir=${archivesDir}`],
        { cwd: path.resolve(".") }
      ),
    /Archive filename collision/
  );
});

test("zip-maker deletes only archived y files and keeps sibling y files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  const rowDir = path.join(tilesDir, "vector", "11", "1738");
  await mkdir(rowDir, { recursive: true });
  await writeFile(path.join(rowDir, "1264.vector.pbf"), "tile-a");
  await writeFile(path.join(rowDir, "1265.vector.pbf"), "tile-b");
  await writeFile(path.join(rowDir, "1266.vector.pbf"), "tile-c");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [{ zoom: 11, xStart: 1738, xEnd: 1738, yStart: 1264, yEnd: 1265 }],
    })
  );

  await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  await assert.rejects(() => stat(path.join(rowDir, "1264.vector.pbf")), /ENOENT/);
  await assert.rejects(() => stat(path.join(rowDir, "1265.vector.pbf")), /ENOENT/);
  await stat(path.join(rowDir, "1266.vector.pbf"));
});

test("zip-maker invalidates downloader sqlite when archived source files are deleted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const configDir = path.join(dir, "configs");
  const tilesDir = path.join(configDir, "tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "satellite", "1", "0"), { recursive: true });
  await writeFile(path.join(tilesDir, "satellite", "1", "0", "0.jpg"), "tile");

  const configPath = path.join(configDir, "esri.config.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "sqlite-archive",
      provider: "esri",
      layer: "satellite",
      format: "jpg",
      output: { dir: "./tiles" },
      tile: { extension: "jpg", yScheme: "xyz" },
      ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    })
  );

  const loaded = await loadConfig(configPath, { env: {} });
  const stateDbPath = path.join(dir, ".tile-state", "sqlite-archive.sqlite");
  let db = new TileStateDb(stateDbPath);
  const key = {
    jobName: loaded.jobName,
    configHash: loaded.configHash,
    layer: loaded.layer,
    z: 1,
    x: 0,
    yStart: 0,
    yEnd: 0,
  };
  db.markRowComplete({ ...key, expected: 1, downloaded: 1, missing: 0, failed: 0 });
  db.markRangeVerified({
    jobName: loaded.jobName,
    configHash: loaded.configHash,
    layer: loaded.layer,
    rangeIndex: 1,
    label: loaded.ranges[0].label,
    expected: 1,
    present: 1,
    missing: 0,
  });
  db.close();

  await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  db = new TileStateDb(stateDbPath);
  assert.equal(db.shouldSkipRow(key), false);
  assert.equal(
    db.shouldSkipRange({
      jobName: loaded.jobName,
      configHash: loaded.configHash,
      layer: loaded.layer,
      rangeIndex: 1,
    }),
    false
  );
  db.close();
});

test("zip-maker removes runtime temp files after successful archive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
      stateFile: "./archive-resume.json",
    })
  );

  await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  const archiveNames = await readdir(archivesDir);
  assert.deepEqual(
    archiveNames.filter(
      (name) =>
        name.endsWith(".tmp") ||
        name.endsWith(".central") ||
        name.endsWith(".progress.json") ||
        name.endsWith(".progress.json.tmp") ||
        name.startsWith("archive-write-probe-")
    ),
    []
  );
  assert.ok(archiveNames.includes("tiles_vector_5_000027-000027_y000019-000019.zip"));
});

test("zip-maker leaves only zip files after every range is complete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  const stateFile = path.join(dir, "archive-resume.json");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
      stateFile: "./archive-resume.json",
    })
  );

  await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  assert.deepEqual(await readdir(archivesDir), [
    "tiles_vector_5_000027-000027_y000019-000019.zip",
  ]);
  await assert.rejects(() => stat(stateFile), /ENOENT/);
});

test("zip-maker resumes by skipping existing archives and archiving missing ranges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await mkdir(archivesDir, { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile-a");
  await writeFile(path.join(tilesDir, "vector", "5", "27", "20.vector.pbf"), "tile-b");
  await writeFile(
    path.join(archivesDir, "tiles_vector_5_000027-000027_y000019-000019.zip"),
    "already-zipped"
  );

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [
        { zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 },
        { zoom: 5, xStart: 27, xEnd: 27, yStart: 20, yEnd: 20 },
      ],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, "--keep", `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  assert.match(stdout, /SKIP existing: tiles_vector_5_000027-000027_y000019-000019\.zip/);
  assert.match(stdout, /ARCHIVE: tiles_vector_5_000027-000027_y000020-000020\.zip/);
  await stat(path.join(archivesDir, "tiles_vector_5_000027-000027_y000020-000020.zip"));
});

test("zip-maker deletes existing archived sources without materializing every tile path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  const archiveName = "tiles_vector_5_000027-000027_y000001-080000.zip";
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await mkdir(archivesDir, { recursive: true });
  await writeFile(path.join(archivesDir, archiveName), "already-zipped");

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      deleteExistingArchivedSources: true,
      deleteConcurrency: 1,
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 1, yEnd: 80000 }],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--max-old-space-size=16", "zip-maker.js", configPath, `--archive-dir=${archivesDir}`],
    { cwd: path.resolve("."), timeout: 60000 }
  );

  assert.match(stdout, new RegExp(`SKIP existing: ${archiveName}`));
  assert.match(stdout, /deleted source files 80000\/80000/);
});

test("zip-maker resumes by replacing stale partial archive files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zip-maker-"));
  const tilesDir = path.join(dir, "downloaded-tiles");
  const archivesDir = path.join(dir, "archives");
  const archiveName = "tiles_vector_5_000027-000027_y000019-000019.zip";
  await mkdir(path.join(tilesDir, "vector", "5", "27"), { recursive: true });
  await mkdir(archivesDir, { recursive: true });
  await writeFile(path.join(tilesDir, "vector", "5", "27", "19.vector.pbf"), "tile");
  await writeFile(path.join(archivesDir, `${archiveName}.tmp`), "stale-partial");
  await writeFile(path.join(archivesDir, `${archiveName}.tmp.central`), "stale-central");
  await writeFile(path.join(archivesDir, `${archiveName}.progress.json`), '{"status":"failed"}');

  const configPath = path.join(dir, "mapbox-pbf-mcs.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "mapbox-pbf-mcs",
      provider: "mapbox",
      layer: "vector",
      output: { dir: "./downloaded-tiles" },
      tile: { extension: "vector.pbf" },
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
    })
  );

  await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, "--keep", `--archive-dir=${archivesDir}`],
    { cwd: path.resolve(".") }
  );

  await stat(path.join(archivesDir, archiveName));
  await assert.rejects(() => stat(path.join(archivesDir, `${archiveName}.tmp`)), /ENOENT/);
  await assert.rejects(() => stat(path.join(archivesDir, `${archiveName}.tmp.central`)), /ENOENT/);
  await assert.rejects(() => stat(path.join(archivesDir, `${archiveName}.progress.json`)), /ENOENT/);
});
