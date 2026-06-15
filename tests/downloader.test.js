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
        GEONODE_PROXY_LIST_URL: "http://127.0.0.1:9/proxies",
        GEONODE_HTTPS_PROXY_LIST: "http://127.0.0.1:9",
        TILE_DOWNLOADER_PROXY_HEALTHCHECK_TIMEOUT_MS: "5000",
      },
    }
  );

  assert.ok(stdout.includes("Mode: dry-run"), stdout);
});

test("downloader accepts --proxy-trace and prints trace state", async () => {
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

  assert.ok(stdout.includes("Proxy trace: enabled"), stdout);
});

test("downloader refuses to start Esri download when no healthy proxy is found", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-downloader-no-proxy-"));
  const configPath = path.join(dir, "esri.config.json");
  await writeFile(configPath, JSON.stringify(esriConfig(path.join(dir, "download"))));

  await assert.rejects(
    async () => execFileAsync(
      process.execPath,
      ["downloader.js", configPath, "--proxy-trace"],
      {
        cwd: process.cwd(),
        timeout: 5_000,
        env: {
          ...process.env,
          GEONODE_PROXY_LIST_URL: "http://127.0.0.1:9/proxies",
          GEONODE_PROXY_LIST_CACHE_PATH: path.join(dir, "proxy-list-cache.json"),
          GEONODE_PROXY_BLACKLIST_PATH: path.join(dir, "proxy-blacklist.json"),
          TILE_DOWNLOADER_PROXY_HEALTHCHECK_TIMEOUT_MS: "100",
        },
      }
    ),
    (error) => {
      const output = `${error.stdout || ""}\n${error.stderr || ""}`;
      assert.match(output, /No healthy proxy candidates|Proxy setup did not produce a healthy proxy/);
      assert.equal(output.includes("Mode: download/resume"), false);
      assert.equal(output.includes("▶ Range"), false);
      return true;
    }
  );
});
