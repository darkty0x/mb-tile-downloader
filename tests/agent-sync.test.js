import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAgent, syncManagedState } from "../src/agent/agent.js";

test("agent sync materializes active dashboard config env and secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sync-"));
  const client = {
    async listConfigs() {
      return {
        configs: [
          {
            configId: "cfg-a",
            version: 1,
            active: true,
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
            version: 1,
            active: true,
            env: { TILE_DOWNLOADER_MAX_CONCURRENCY: 24 },
          },
        ],
      };
    },
    async listSecrets() {
      return {
        secrets: [
          { secretType: "mapbox_token", value: "pk.secret-token" },
          { secretType: "proxy_txt", value: "http://proxy-a:8080,http://proxy-b:8080" },
        ],
      };
    },
  };

  const synced = await syncManagedState({
    client,
    machineId: "worker-a",
    stateDir: path.join(dir, ".tile-state"),
    projectDir: dir,
  });

  assert.equal(synced.env.TILE_DOWNLOADER_MAX_CONCURRENCY, "24");
  assert.equal(synced.secretEnv.MAPBOX_ACCESS_TOKENS, "pk.secret-token");
  assert.match(await readFile(synced.configPath, "utf8"), /"provider": "esri"/);
  assert.equal(await readFile(path.join(dir, "proxy.txt"), "utf8"), "http://proxy-a:8080\nhttp://proxy-b:8080\n");
});

test("agent register and heartbeat include protocol version", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-protocol-"));
  const calls = [];
  const client = {
    async register(payload) {
      calls.push(["register", payload]);
      return { status: "registered" };
    },
    async heartbeat(payload) {
      calls.push(["heartbeat", payload]);
      return { machine: payload };
    },
    async listConfigs() {
      return { configs: [] };
    },
    async listEnvProfiles() {
      return { envProfiles: [] };
    },
    async listSecrets() {
      return { secrets: [] };
    },
    async pollCommands() {
      return { commands: [] };
    },
  };

  await runAgent({
    env: {
      MACHINE_ID: "server-01",
      MACHINE_DISPLAY_NAME: "Server 01",
      DASHBOARD_URL: "https://dashboard.example.com",
      AGENT_TOKEN: "agent-token",
      npm_package_version: "1.2.3",
    },
    argv: ["--once"],
    stateDir: path.join(dir, ".tile-state"),
    createClient: () => client,
    collectDiskInfoImpl: async () => [
      {
        name: "C:",
        filesystem: "C:",
        mount: "C:",
        totalBytes: 100,
        freeBytes: 50,
        usedBytes: 50,
        percentUsed: 50,
      },
    ],
    projectDir: dir,
  });

  assert.equal(calls[0][0], "register");
  assert.equal(calls[1][0], "heartbeat");
  assert.equal(calls[0][1].agentProtocolVersion, 1);
  assert.equal(calls[1][1].agentProtocolVersion, 1);
});
