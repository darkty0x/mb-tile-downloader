import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { unzipOne } from "../unzip-ranges.js";

const execFileAsync = promisify(execFile);
const cwd = path.resolve(".");

test("unzip-ranges ignores empty zip archives without marking them complete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unzip-ranges-"));
  const rangeDir = path.join(dir, "28-haenam-radar-esri-satellite");
  const zipName = "tiles_esri-satellite_19_445810-446299_y208721-209055.zip";
  const zipPath = path.join(rangeDir, zipName);
  await mkdir(rangeDir, { recursive: true });
  await writeFile(zipPath, "");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["unzip-ranges.js", dir, "--concurrency=1"],
    { cwd }
  );

  assert.match(stdout, /ignored-empty: 28-haenam-radar-esri-satellite/);
  assert.match(stdout, /Ignored empty: 1/);

  const markerPath = path.join(
    dir,
    ".unzip-state",
    `28-haenam-radar-esri-satellite__${zipName}.json`
  );
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.status, "ignored-empty");
  assert.equal(marker.reason, "empty zip archive");
});

test("unzip-ranges skips zip paths that disappear before stat", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unzip-ranges-missing-"));
  const zipPath = path.join(
    dir,
    "27-gunsan-missile-alert-center",
    "satellite",
    ".downloads",
    "000-tiles_satellite_15_027893-027924_y012863-012893.zip"
  );

  const result = await unzipOne({ rootDir: dir, zipPath, force: false, dryRun: false });

  assert.deepEqual(result, {
    status: "missing",
    rel: path.join(
      "27-gunsan-missile-alert-center",
      "satellite",
      ".downloads",
      "000-tiles_satellite_15_027893-027924_y012863-012893.zip"
    ),
  });

  const markerPath = path.join(
    dir,
    ".unzip-state",
    "27-gunsan-missile-alert-center__satellite__.downloads__000-tiles_satellite_15_027893-027924_y012863-012893.zip.json"
  );
  await assert.rejects(access(markerPath), { code: "ENOENT" });
});
