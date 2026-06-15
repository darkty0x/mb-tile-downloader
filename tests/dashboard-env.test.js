import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDashboardStore } from "../dashboard/src/server/store.js";
import { materializeEnvProfile } from "../src/agent/env-materializer.js";

test("env profiles reject invalid and secret-looking variable names", () => {
  const store = createDashboardStore();

  assert.throws(
    () =>
      store.createEnvProfile({
        machineId: "worker-a",
        name: "default",
        env: { "bad-name": "value" },
      }),
    /invalid env name/
  );
  assert.throws(
    () =>
      store.createEnvProfile({
        machineId: "worker-a",
        name: "default",
        env: { MAPBOX_ACCESS_TOKEN: "secret" },
      }),
    /must be stored as secrets/
  );
});

test("editing env profile creates a new active version", () => {
  const store = createDashboardStore({
    idGenerator: () => "env-a",
  });

  const created = store.createEnvProfile({
    machineId: "worker-a",
    name: "default",
    env: { TILE_DOWNLOADER_MAX_CONCURRENCY: 16 },
    active: true,
  });
  const updated = store.updateEnvProfile(created.envProfileId, {
    env: { TILE_DOWNLOADER_MAX_CONCURRENCY: 32, TILE_DOWNLOADER_FAST_MODE: true },
    active: true,
  });
  const profiles = store.listEnvProfiles({ machineId: "worker-a" });

  assert.equal(created.version, 1);
  assert.equal(updated.version, 2);
  assert.equal(updated.env.TILE_DOWNLOADER_FAST_MODE, true);
  assert.deepEqual(
    profiles.map((profile) => ({ version: profile.version, active: profile.active })),
    [
      { version: 1, active: false },
      { version: 2, active: true },
    ]
  );
});

test("materializes effective env atomically without overwriting root .env", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-env-"));

  const result = await materializeEnvProfile({
    stateDir: dir,
    profile: {
      envProfileId: "env-a",
      version: 2,
      env: {
        TILE_DOWNLOADER_MAX_CONCURRENCY: 32,
        TILE_DOWNLOADER_FAST_MODE: true,
      },
    },
  });
  const generated = await readFile(path.join(dir, "dashboard", "env.generated"), "utf8");

  assert.equal(result.env.TILE_DOWNLOADER_MAX_CONCURRENCY, "32");
  assert.equal(result.env.TILE_DOWNLOADER_FAST_MODE, "true");
  assert.match(generated, /TILE_DOWNLOADER_MAX_CONCURRENCY=32/);
  assert.equal(result.envPath, path.join(dir, "dashboard", "env.generated"));
});
