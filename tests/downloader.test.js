import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

function esriConfig(pathName) {
  return {
    provider: "esri",
    ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    output: { dir: pathName },
  };
}

test("downloader falls back to provided configs when MACHINE_NAME does not match provided files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-machine-config-"));
  const firstConfig = path.join(dir, "a.config.json");
  const secondConfig = path.join(dir, "b.config.json");

  await writeFile(firstConfig, JSON.stringify(esriConfig("download-a")));
  await writeFile(secondConfig, JSON.stringify(esriConfig("download-b")));

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "downloader.js",
      firstConfig,
      secondConfig,
      "--validate",
      "--dry-run",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MACHINE_NAME: "mcs",
      },
    }
  );

  assert.ok(stdout.includes("using configured config list"), stdout);
});

test("downloader accepts --max-concurrent-requests and applies it to runtime profile", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-concurrency-"));
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(configPath, JSON.stringify(esriConfig(path.join(dir, "download"))));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", configPath, "--dry-run", "--max-concurrent-requests", "192", "--esri-fast"],
    {
      cwd: process.cwd(),
      env: process.env,
    }
  );

  assert.ok(stdout.includes("Concurrency: requests=192"), stdout);
});
