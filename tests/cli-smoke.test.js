import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cwd = path.resolve(".");

const TILE_BYTES = Buffer.from("real local tile bytes");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function withTileServer(handler, fn) {
  const server = http.createServer(handler);
  const port = await listen(server);
  try {
    return await fn(port);
  } finally {
    await close(server);
  }
}

function esriConfig({ outputDir, port, unavailableTileSha256 }) {
  return {
    provider: "esri",
    layer: "esri-satellite",
    format: "jpg",
    url: {
      template: `http://127.0.0.1:${port}/tile/{z}/{y}/{x}`,
    },
    output: { dir: outputDir },
    tile: {
      extension: "jpg",
      yScheme: "xyz",
      ...(unavailableTileSha256 ? { unavailableTileSha256 } : null),
    },
    ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
  };
}

async function writeConfig(dir, config) {
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  return configPath;
}

test("real CLI download fetches a tile over HTTP and writes it to disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-cli-download-"));
  const outputDir = path.join(dir, "tiles");
  let requests = 0;

  await withTileServer((req, res) => {
    requests += 1;
    assert.equal(req.url, "/tile/1/0/0");
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(TILE_BYTES);
  }, async (port) => {
    const configPath = await writeConfig(dir, esriConfig({ outputDir, port }));
    const stateDir = path.join(dir, "state");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["downloader.js", configPath, "--no-proxy", "--state-db", stateDir],
      { cwd, timeout: 10_000, env: process.env }
    );

    const tilePath = path.join(outputDir, "esri-satellite", "1", "0", "0.jpg");
    assert.deepEqual(await readFile(tilePath), TILE_BYTES);
    assert.match(stdout, /Tiles downloaded: 1/);
    assert.equal(requests, 1);
  });
});

test("real CLI validate redownloads an existing Esri unavailable placeholder", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-cli-redownload-"));
  const outputDir = path.join(dir, "tiles");
  const placeholder = Buffer.from("map data not yet available placeholder");
  const placeholderHash = crypto.createHash("sha256").update(placeholder).digest("hex");
  const tilePath = path.join(outputDir, "esri-satellite", "1", "0", "0.jpg");
  await mkdir(path.dirname(tilePath), { recursive: true });
  await writeFile(tilePath, placeholder);
  let requests = 0;

  await withTileServer((req, res) => {
    requests += 1;
    assert.equal(req.url, "/tile/1/0/0");
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(TILE_BYTES);
  }, async (port) => {
    const configPath = await writeConfig(
      dir,
      esriConfig({ outputDir, port, unavailableTileSha256: placeholderHash })
    );
    const stateDir = path.join(dir, "state");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["downloader.js", configPath, "--validate", "--no-proxy", "--state-db", stateDir],
      { cwd, timeout: 10_000, env: process.env }
    );

    assert.deepEqual(await readFile(tilePath), TILE_BYTES);
    assert.match(stdout, /Tiles downloaded: 1/);
    assert.equal(requests, 1);
  });
});

test("real zip CLI creates one archive and keeps source tiles by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-cli-zip-"));
  const outputDir = path.join(dir, "tiles");
  const archiveDir = path.join(dir, "archives");
  const tilePath = path.join(outputDir, "esri-satellite", "1", "0", "0.jpg");
  await mkdir(path.dirname(tilePath), { recursive: true });
  await writeFile(tilePath, TILE_BYTES);

  const configPath = await writeConfig(dir, {
    provider: "esri",
    layer: "esri-satellite",
    format: "jpg",
    output: { dir: outputDir },
    tile: { extension: "jpg", yScheme: "xyz" },
    ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    ["zip-maker.js", configPath, `--archive-dir=${archiveDir}`],
    { cwd, timeout: 10_000, env: process.env }
  );

  const archives = (await readdir(archiveDir)).filter((name) => name.endsWith(".zip"));
  assert.equal(archives.length, 1);
  assert.ok((await stat(path.join(archiveDir, archives[0]))).size > 0);
  await access(tilePath);
  assert.match(stdout, /Delete after archive: false/);
  assert.match(stdout, /Done\. archived=1/);
});
