import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

test("downloader --range-index selects one original config range", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-range-index-"));
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      provider: "esri",
      output: { dir: path.join(dir, "download") },
      ranges: [
        { zoom: 2, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 },
        { zoom: 2, xStart: 1, xEnd: 2, yStart: 0, yEnd: 0 },
      ],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", configPath, "--dry-run", "--range-index=1"],
    { cwd: process.cwd(), env: process.env }
  );

  assert.ok(stdout.includes("Rows planned: 2"), stdout);
  assert.ok(stdout.includes("Tiles planned: 2"), stdout);
});

test("downloader --range-index rejects indexes outside the config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-range-index-bad-"));
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(configPath, JSON.stringify(esriConfig(path.join(dir, "download"))));

  await assert.rejects(
    () =>
      execFileAsync(process.execPath, ["downloader.js", configPath, "--dry-run", "--range-index=1"], {
        cwd: process.cwd(),
        env: process.env,
      }),
    /outside config range count/
  );
});

test("downloader dry-run skips proxy discovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-dry-proxy-"));
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(configPath, JSON.stringify(esriConfig(path.join(dir, "download"))));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", configPath, "--dry-run"],
    {
      cwd: process.cwd(),
      timeout: 3_000,
      env: {
        ...process.env,
        TILE_DOWNLOADER_PROXY_LIST: "http://127.0.0.1:9",
      },
    }
  );

  assert.ok(stdout.includes("Mode: dry-run"), stdout);
});

test("downloader --no-proxy skips proxy discovery without requiring a healthy proxy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-no-proxy-flag-"));
  const outputDir = path.join(dir, "download");
  const tilePath = path.join(outputDir, "esri-satellite", "1", "0", "0.jpg");
  const configPath = path.join(dir, "esri.config.json");
  await mkdir(path.dirname(tilePath), { recursive: true });
  await writeFile(tilePath, "jpg");
  await writeFile(configPath, JSON.stringify(esriConfig(outputDir)));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", configPath, "--validate", "--no-proxy"],
    {
      cwd: process.cwd(),
      timeout: 5_000,
      env: {
        ...process.env,
        TILE_DOWNLOADER_PROXY_LIST: "http://127.0.0.1:9",
      },
    }
  );

  assert.ok(stdout.includes("Proxy: disabled (--no-proxy)"), stdout);
  assert.equal(stdout.includes("Proxy: fallback enabled from env"), false);
  assert.ok(stdout.includes("Mode: validate/download missing"), stdout);
});

test("downloader accepts deprecated --proxy-trace as a compatibility no-op", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-proxy-trace-"));
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(configPath, JSON.stringify(esriConfig(path.join(dir, "download"))));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", configPath, "--dry-run", "--proxy-trace"],
    {
      cwd: process.cwd(),
      env: process.env,
    }
  );

  assert.ok(stdout.includes("Mode: dry-run"), stdout);
});

test("downloader enables paid proxy list from environment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-env-proxy-"));
  const outputDir = path.join(dir, "download");
  const tilePath = path.join(outputDir, "esri-satellite", "1", "0", "0.jpg");
  const configPath = path.join(dir, "esri.config.json");
  await mkdir(path.dirname(tilePath), { recursive: true });
  await writeFile(tilePath, "jpg");
  await writeFile(configPath, JSON.stringify(esriConfig(outputDir)));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", configPath, "--validate"],
    {
      cwd: process.cwd(),
      timeout: 5_000,
      env: {
        ...process.env,
        TILE_DOWNLOADER_PROXY_LIST: "http://127.0.0.1:9,http://127.0.0.2:9",
      },
    }
  );

  assert.ok(stdout.includes("Proxy: fallback enabled from env (direct first)"), stdout);
  assert.ok(stdout.includes("Mode: validate/download missing"), stdout);
});

test("delete-unavailable removes Esri unavailable placeholder files and keeps valid imagery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-delete-unavailable-"));
  const outputDir = path.join(dir, "download");
  const placeholder = Buffer.from("unavailable placeholder");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  const unavailablePath = path.join(outputDir, "esri-satellite", "2", "1", "0.jpg");
  const validPath = path.join(outputDir, "esri-satellite", "2", "1", "1.jpg");
  const configPath = path.join(dir, "esri.config.json");
  await mkdir(path.dirname(unavailablePath), { recursive: true });
  await writeFile(unavailablePath, placeholder);
  await writeFile(validPath, "real imagery");
  await writeFile(configPath, JSON.stringify({
    provider: "esri",
    ranges: [{ zoomStart: 2, zoomEnd: 2, xStart: 1, xEnd: 1, yStart: 0, yEnd: 1 }],
    output: { dir: outputDir },
    tile: { unavailableTileSha256: placeholderHash },
  }));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", "delete-unavailable", configPath],
    {
      cwd: process.cwd(),
      timeout: 5_000,
      env: process.env,
    }
  );

  await assert.rejects(() => access(unavailablePath));
  await access(validPath);
  assert.match(stdout, /^Unavailable tiles deleted: 1$/m);
  assert.match(stdout, /^Tiles scanned: 2$/m);
});

test("delete-unavailable scans existing files, not every configured coordinate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-delete-existing-only-"));
  const outputDir = path.join(dir, "download");
  const placeholder = Buffer.from("unavailable placeholder");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  const unavailablePath = path.join(outputDir, "esri-satellite", "14", "1", "0.jpg");
  const configPath = path.join(dir, "esri.config.json");
  await mkdir(path.dirname(unavailablePath), { recursive: true });
  await writeFile(unavailablePath, placeholder);
  await writeFile(configPath, JSON.stringify({
    provider: "esri",
    ranges: [{ zoomStart: 14, zoomEnd: 14, xStart: 1, xEnd: 1, yStart: 0, yEnd: 9999 }],
    output: { dir: outputDir },
    tile: { unavailableTileSha256: placeholderHash },
  }));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["downloader.js", "delete-unavailable", configPath],
    {
      cwd: process.cwd(),
      timeout: 5_000,
      env: process.env,
    }
  );

  await assert.rejects(() => access(unavailablePath));
  assert.match(stdout, /^Tiles scanned: 1$/m);
  assert.match(stdout, /^Unavailable tiles deleted: 1$/m);
});
