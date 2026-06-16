import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDashboardStore } from "../dashboard/src/server/store.js";
import { materializeConfig } from "../src/agent/config-sync.js";

const validConfig = {
  provider: "esri",
  layer: "esri-satellite",
  ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
};

test("dashboard config storage validates ranges and versions edits", () => {
  const store = createDashboardStore({ idGenerator: () => "cfg-a" });

  assert.throws(
    () =>
      store.createConfig({
        machineId: "worker-a",
        name: "bad",
        config: { provider: "esri" },
      }),
    /No valid ranges/
  );

  const created = store.createConfig({
    machineId: "worker-a",
    name: "ukraine",
    config: validConfig,
    active: true,
  });
  const updated = store.updateConfig(created.configId, {
    config: { ...validConfig, jobName: "ukraine-v2" },
    active: true,
  });
  const configs = store.listConfigs({ machineId: "worker-a" });

  assert.equal(created.version, 1);
  assert.equal(updated.version, 2);
  assert.deepEqual(
    configs.map((config) => ({ version: config.version, active: config.active })),
    [
      { version: 1, active: false },
      { version: 2, active: true },
    ]
  );
});

test("dashboard config storage supports rename and delete", () => {
  const store = createDashboardStore({ idGenerator: () => "cfg-a" });

  const created = store.createConfig({
    machineId: "worker-a",
    name: "old-name",
    config: validConfig,
    active: true,
  });
  const renamed = store.updateConfig(created.configId, {
    name: "new-name",
    config: validConfig,
    active: false,
  });
  const deleted = store.deleteConfig(renamed.configId);

  assert.equal(renamed.name, "new-name");
  assert.equal(deleted.configId, renamed.configId);
  assert.deepEqual(
    store.listConfigs({ machineId: "worker-a" }).map((config) => config.configId),
    [created.configId]
  );
});

test("agent materializes dashboard config without editing root configs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-"));

  const result = await materializeConfig({
    stateDir: dir,
    configRecord: {
      configId: "cfg-a",
      version: 1,
      config: validConfig,
    },
  });
  const materialized = JSON.parse(await readFile(result.configPath, "utf8"));

  assert.equal(materialized.provider, "esri");
  assert.equal(result.configPath, path.join(dir, "dashboard", "configs", "cfg-a.json"));
});
