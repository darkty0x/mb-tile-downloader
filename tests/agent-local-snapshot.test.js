import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyTileStorageEstimates, collectLocalSnapshot } from "../src/agent/local-snapshot.js";

test("local snapshot reports local configs env files proxy counts and bounded storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-snapshot-"));
  await mkdir(path.join(dir, "configs"), { recursive: true });
  await mkdir(path.join(dir, ".tile-state", "dashboard", "configs"), { recursive: true });
  await mkdir(path.join(dir, "tiles", "esri", "14", "9600"), { recursive: true });
  await mkdir(path.join(dir, "archives"), { recursive: true });
  await writeFile(path.join(dir, ".env"), "MACHINE_ID=server-01\nAGENT_TOKEN=secret-token\n");
  await writeFile(path.join(dir, "proxy.txt"), "http://proxy-a:8080\nhttp://proxy-b:8080\n");
  await writeFile(path.join(dir, "tiles", "esri", "14", "9600", "5824.jpg"), "tile");
  await writeFile(path.join(dir, "archives", "range.zip"), "zip");
  await writeFile(
    path.join(dir, "configs", "1-ukraine-esri-satellite.config.json"),
    JSON.stringify({ provider: "esri", layer: "satellite", ranges: [{ zoom: 1 }] })
  );
  const activeConfigPath = path.join(dir, ".tile-state", "dashboard", "configs", "cfg-a.json");
  await writeFile(
    activeConfigPath,
    JSON.stringify({ provider: "esri", name: "Ukraine Range", output: { dir: "tiles" }, ranges: [{ zoom: 1 }] })
  );

  const snapshot = await collectLocalSnapshot({
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    synced: {
      configPath: activeConfigPath,
      secretsEnvPath: path.join(dir, ".tile-state", "dashboard", "secrets.env.generated"),
      proxyPath: path.join(dir, "proxy.txt"),
      secretEnv: { MAPBOX_ACCESS_TOKENS: "pk.a,pk.b" },
    },
  });

  assert.equal(snapshot.managed.activeConfigName, "Ukraine Range");
  assert.equal(snapshot.configs[0].type, "esri-satellite");
  assert.equal(snapshot.envFiles.length, 1);
  assert.equal(snapshot.envFiles[0].path, ".env");
  assert.equal(snapshot.envFiles[0].variables.find((item) => item.name === "AGENT_TOKEN").value, "secret-token");
  assert.equal(snapshot.secrets.proxy.availableCount, 2);
  assert.equal(snapshot.secrets.mapboxTokenCount, 2);
  assert.equal(snapshot.storage.find((item) => item.type === "tiles").fileCount, 1);
  assert.equal(snapshot.storage.find((item) => item.type === "tiles").dirCount, 3);
  assert.match(snapshot.storage.find((item) => item.type === "tiles").absolutePath, /tiles$/);
  assert.equal(snapshot.storage.find((item) => item.type === "zip").fileCount, 1);
  assert.match(snapshot.storage.find((item) => item.type === "zip").absolutePath, /archives$/);
  assert.equal(snapshot.storage.some((item) => item.type === "state"), false);
  assert.equal(snapshot.storage.some((item) => item.type === "configs"), false);
});

test("local snapshot reports exact tile storage beyond shallow scan limits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-snapshot-large-"));
  const tileDir = path.join(dir, "tiles", "vector", "17", "76642");
  await mkdir(tileDir, { recursive: true });
  await mkdir(path.join(dir, "archives"), { recursive: true });
  await writeFile(path.join(dir, ".env"), "MACHINE_ID=server-01\n");

  await Promise.all(
    Array.from({ length: 2005 }, (_, index) =>
      writeFile(path.join(tileDir, `${index}.pbf`), "tile")
    )
  );

  const snapshot = await collectLocalSnapshot({ projectDir: dir, stateDir: path.join(dir, ".tile-state") });
  const tiles = snapshot.storage.find((item) => item.type === "tiles");
  assert.equal(tiles.fileCount, 2005);
  assert.equal(tiles.sizeBytes, 2005 * 4);
  assert.equal(tiles.truncated, false);
});

test("local snapshot omits mapbox tokens from env list and reports them as API keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-snapshot-env-"));
  await mkdir(path.join(dir, "tiles"), { recursive: true });
  await mkdir(path.join(dir, "archives"), { recursive: true });
  await writeFile(path.join(dir, ".env"), "MACHINE_ID=server-01\nMAPBOX_ACCESS_TOKENS=pk.one,pk.two\nPORT=3001\n");

  const snapshot = await collectLocalSnapshot({ projectDir: dir, stateDir: path.join(dir, ".tile-state") });

  assert.equal(snapshot.envFiles[0].variables.some((item) => item.name === "MAPBOX_ACCESS_TOKENS"), false);
  assert.equal(snapshot.envFiles[0].variables.some((item) => item.name === "PORT"), true);
  assert.deepEqual(snapshot.secrets.mapboxTokens, ["pk.one", "pk.two"]);
  assert.equal(snapshot.secrets.mapboxTokenCount, 2);
});

test("local snapshot scans every configured tile root exactly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-snapshot-roots-"));
  const tileRootA = path.join(dir, "tiles-a");
  const tileRootB = path.join(dir, "tiles-b");
  await mkdir(path.join(tileRootA, "vector", "17", "1"), { recursive: true });
  await mkdir(path.join(tileRootB, "vector", "17", "2"), { recursive: true });
  await mkdir(path.join(dir, "archives"), { recursive: true });
  await writeFile(path.join(dir, ".env"), "MACHINE_ID=server-01\n");
  await writeFile(path.join(tileRootA, "vector", "17", "1", "1.pbf"), "root-a");
  await writeFile(path.join(tileRootB, "vector", "17", "2", "2.pbf"), "root-b");

  const snapshot = await collectLocalSnapshot({
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    env: {
      TILE_DOWNLOADER_OUTPUT_ROOTS: `${tileRootA},${tileRootB}`,
    },
  });
  const tileItems = snapshot.storage.filter((item) => item.type === "tiles" && item.exists);

  assert.equal(tileItems.length, 2);
  assert.equal(tileItems.reduce((sum, item) => sum + item.fileCount, 0), 2);
  assert.equal(tileItems.reduce((sum, item) => sum + item.sizeBytes, 0), "root-a".length + "root-b".length);
  assert.equal(tileItems.some((item) => item.truncated), false);
});

test("tile storage estimate uses drive usage when exact tile walk is implausibly tiny", () => {
  const eightyFourGb = 84 * 1024 * 1024 * 1024;
  const estimated = applyTileStorageEstimates({
    disks: [
      {
        name: "C:",
        mount: "C:",
        totalBytes: 476 * 1024 * 1024 * 1024,
        usedBytes: eightyFourGb,
        freeBytes: 392 * 1024 * 1024 * 1024,
      },
    ],
    tileStorage: [
      {
        label: "Tile Content",
        type: "tiles",
        exists: true,
        absolutePath: "C:/mb-tile-downloader/tiles",
        sizeBytes: 621 * 1024,
        fileCount: 613,
        dirCount: 13877,
      },
    ],
    otherStorage: [
      {
        label: "Zip Archives",
        type: "zip",
        exists: true,
        absolutePath: "C:/mb-tile-downloader/archives",
        sizeBytes: 0,
      },
    ],
  });

  assert.equal(estimated[0].sizeEstimated, true);
  assert.equal(estimated[0].exactSizeBytes, 621 * 1024);
  assert.equal(estimated[0].sizeBytes, eightyFourGb);
});
