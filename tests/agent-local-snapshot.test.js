import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectLocalSnapshot } from "../src/agent/local-snapshot.js";

test("local snapshot reports local configs env files proxy counts and bounded storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-snapshot-"));
  await mkdir(path.join(dir, "configs"), { recursive: true });
  await mkdir(path.join(dir, ".tile-state", "dashboard", "configs"), { recursive: true });
  await mkdir(path.join(dir, "tiles"), { recursive: true });
  await mkdir(path.join(dir, "zips"), { recursive: true });
  await writeFile(path.join(dir, ".env"), "MACHINE_ID=server-01\nAGENT_TOKEN=secret-token\n");
  await writeFile(path.join(dir, "proxy.txt"), "http://proxy-a:8080\nhttp://proxy-b:8080\n");
  await writeFile(path.join(dir, "tiles", "0.tile"), "tile");
  await writeFile(path.join(dir, "zips", "range.zip"), "zip");
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
  assert.equal(snapshot.envFiles[0].variables.find((item) => item.name === "AGENT_TOKEN").value, "********");
  assert.equal(snapshot.secrets.proxy.availableCount, 2);
  assert.equal(snapshot.secrets.mapboxTokenCount, 2);
  assert.equal(snapshot.storage.find((item) => item.type === "tiles").fileCount, 1);
  assert.equal(snapshot.storage.find((item) => item.type === "zip").fileCount, 1);
});
