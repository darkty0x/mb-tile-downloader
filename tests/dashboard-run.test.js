import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildManagedEnv,
  publishImmediateDashboardSnapshot,
  runDashboardCommand,
  withDashboardConfig,
} from "../scripts/dashboard-run.js";

test("dashboard-run injects active dashboard config when command has no config path", () => {
  assert.deepEqual(
    withDashboardConfig(["node", "downloader.js", "--validate"], ".tile-state/dashboard/configs/cfg-a.json"),
    ["node", "downloader.js", "--validate", ".tile-state/dashboard/configs/cfg-a.json"]
  );
});

test("dashboard-run replaces explicit local config paths when dashboard config is active", () => {
  assert.deepEqual(
    withDashboardConfig(["node", "downloader.js", "configs/local.json"], ".tile-state/dashboard/configs/cfg-a.json"),
    ["node", "downloader.js", ".tile-state/dashboard/configs/cfg-a.json"]
  );
});

test("dashboard-run strips local secrets and applies dashboard env", () => {
  const env = buildManagedEnv(
    {
      DASHBOARD_URL: "https://dashboard.example.com",
      AGENT_TOKEN: "agent-token",
      MACHINE_ID: "worker-a",
      MAPBOX_ACCESS_TOKENS: "local-token",
      MAPBOX_ACCESS_TOKEN_1: "local-token-1",
      TILE_DOWNLOADER_PROXY_LIST: "local-proxy",
      TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS: "64",
    },
    {
      synced: true,
      env: { TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS: "4096" },
      secretEnv: { MAPBOX_ACCESS_TOKENS: "dashboard-token" },
    }
  );

  assert.equal(env.MAPBOX_ACCESS_TOKENS, "dashboard-token");
  assert.equal(env.MAPBOX_ACCESS_TOKEN_1, undefined);
  assert.equal(env.TILE_DOWNLOADER_PROXY_LIST, undefined);
  assert.equal(env.TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS, "4096");
  assert.equal(env.DASHBOARD_MANAGED_RUN, "1");
});

test("dashboard-run runs direct command with synced config env and secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-run-"));
  const outputPath = path.join(dir, "output.json");
  const code = await runDashboardCommand({
    argv: [
      "--",
      process.execPath,
      "-e",
      "const fs=require('fs');fs.writeFileSync(process.argv[1], JSON.stringify({token:process.env.MAPBOX_ACCESS_TOKENS, concurrency:process.env.TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS, args:process.argv.slice(2)}));",
      outputPath,
      "node",
      "downloader.js",
    ],
    env: {
      DASHBOARD_URL: "https://dashboard.example.com",
      AGENT_TOKEN: "agent-token",
      MACHINE_ID: "worker-a",
      MAPBOX_ACCESS_TOKENS: "local-token",
      TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS: "64",
    },
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    log: () => {},
    createClient: () => ({
      async register() {
        return { status: "registered" };
      },
      async postEvent() {
        return { event: {} };
      },
      async listConfigs(machineId) {
        assert.equal(machineId, "worker-a");
        return {
          configs: [
            {
              configId: "cfg-a",
              active: true,
              version: 1,
              config: {
                provider: "esri",
                ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
              },
            },
          ],
        };
      },
      async listEnvProfiles() {
        return {
          envProfiles: [
            {
              envProfileId: "env-a",
              active: true,
              version: 1,
              env: { TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS: "4096" },
            },
          ],
        };
      },
      async listSecrets() {
        return { secrets: [{ secretType: "mapbox_token", value: "dashboard-token" }] };
      },
    }),
  });

  assert.equal(code, 0);
  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(parsed.token, "dashboard-token");
  assert.equal(parsed.concurrency, "4096");
});

test("dashboard-run publishes an immediate dashboard snapshot after sync", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-run-snapshot-"));
  const calls = [];
  const result = await publishImmediateDashboardSnapshot({
    env: {
      MACHINE_ID: "worker-a",
      MACHINE_DISPLAY_NAME: "Worker A",
      npm_package_version: "1.2.3",
    },
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    synced: {
      synced: true,
      configPath: null,
      envPath: path.join(dir, ".tile-state", "dashboard", "env.generated"),
      secretsEnvPath: path.join(dir, ".tile-state", "dashboard", "secrets.env.generated"),
      proxyPath: path.join(dir, "proxy.txt"),
      secretEnv: { MAPBOX_ACCESS_TOKENS: "pk.a,pk.b" },
    },
    client: {
      async register(payload) {
        calls.push(["register", payload]);
        return { status: "registered" };
      },
      async postEvent(payload) {
        calls.push(["event", payload]);
        return { event: payload };
      },
    },
  });

  assert.equal(result.published, true);
  assert.equal(calls[0][0], "register");
  assert.equal(calls[0][1].machineId, "worker-a");
  assert.equal(calls[0][1].displayName, "Worker A");
  assert.equal(calls[0][1].agentSnapshot.secrets.mapboxTokenCount, 2);
  assert.equal(calls[1][0], "event");
  assert.equal(calls[1][1].type, "dashboard-run.synced");
});
