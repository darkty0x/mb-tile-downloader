import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAgent, runCommand, syncManagedState } from "../src/agent/agent.js";
import { syncDashboardSecretsIfConfigured } from "../src/agent/dashboard-secrets-sync.js";

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

test("agent sync materializes every active dashboard config for ordered pipeline starts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sync-configs-"));
  const client = {
    async listConfigs() {
      return {
        configs: [
          {
            configId: "cfg-first",
            version: 1,
            active: true,
            config: {
              provider: "esri",
              jobName: "first-config",
              ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
            },
          },
          {
            configId: "cfg-second",
            version: 1,
            active: true,
            config: {
              provider: "mapbox",
              jobName: "second-config",
              ranges: [{ zoom: 2, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1 }],
            },
          },
        ],
      };
    },
    async listEnvProfiles() {
      return { envProfiles: [] };
    },
    async listSecrets() {
      return { secrets: [] };
    },
  };

  const synced = await syncManagedState({
    client,
    machineId: "worker-a",
    stateDir: path.join(dir, ".tile-state"),
    projectDir: dir,
  });

  assert.deepEqual(
    synced.configPaths.map((configPath) => path.basename(configPath)),
    ["cfg-first.json", "cfg-second.json"]
  );
  assert.equal(path.basename(synced.configPath), "cfg-first.json");
  assert.match(await readFile(synced.configPaths[0], "utf8"), /first-config/);
  assert.match(await readFile(synced.configPaths[1], "utf8"), /second-config/);
});

test("direct downloader dashboard secret sync materializes server-assigned proxies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-secret-sync-"));
  const env = {
    DASHBOARD_URL: "https://dashboard.example.com",
    AGENT_TOKEN: "agent-token",
    MACHINE_ID: "worker-a",
  };
  const logs = [];

  const result = await syncDashboardSecretsIfConfigured({
    env,
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    log: (message) => logs.push(message),
    createClient: () => ({
      async listSecrets(machineId) {
        assert.equal(machineId, "worker-a");
        return {
          secrets: [
            { secretType: "mapbox_token", value: "pk.secret-token" },
            { secretType: "proxy_txt", value: "proxy-a.example:8080,proxy-b.example:8080" },
          ],
        };
      },
    }),
  });

  assert.equal(result.synced, true);
  assert.equal(env.MAPBOX_ACCESS_TOKENS, "pk.secret-token");
  assert.equal(await readFile(path.join(dir, "proxy.txt"), "utf8"), "proxy-a.example:8080\nproxy-b.example:8080\n");
  assert.deepEqual(logs, ["Dashboard secrets synced: mapbox=1 proxies=2 proxy=dashboard"]);
});

test("direct downloader dashboard secret sync preserves local proxies when none assigned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-secret-sync-local-proxy-"));
  await writeFile(path.join(dir, "proxy.txt"), "local-proxy.example:8080\n", "utf8");
  const logs = [];

  const result = await syncDashboardSecretsIfConfigured({
    env: {
      DASHBOARD_URL: "https://dashboard.example.com",
      AGENT_TOKEN: "agent-token",
      MACHINE_ID: "worker-a",
    },
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    log: (message) => logs.push(message),
    createClient: () => ({
      async listSecrets(machineId) {
        assert.equal(machineId, "worker-a");
        return { secrets: [] };
      },
    }),
  });

  assert.equal(result.synced, true);
  assert.equal(result.proxyPath, null);
  assert.equal(await readFile(path.join(dir, "proxy.txt"), "utf8"), "local-proxy.example:8080\n");
  assert.deepEqual(logs, ["Dashboard secrets synced: mapbox=0 proxies=0 proxy=local-preserved"]);
});

test("direct downloader dashboard secret sync skips when dashboard env is incomplete", async () => {
  const result = await syncDashboardSecretsIfConfigured({
    env: { DASHBOARD_URL: "https://dashboard.example.com" },
    createClient: () => {
      throw new Error("client should not be created");
    },
  });

  assert.equal(result.synced, false);
});

test("agent register and heartbeat include protocol version", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-protocol-"));
  const calls = [];
  let runnerEnv = null;
  let snapshotSynced = null;
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
      return {
        envProfiles: [
          {
            envProfileId: "env-a",
            active: true,
            version: 1,
            env: {
              DASHBOARD_AGENT_PAUSE_AFTER_RANGE_FILE: "dashboard-override",
            },
          },
        ],
      };
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
    createRunner: ({ env }) => {
      runnerEnv = env;
      return {
        async run() {
          return { code: 0, signal: null };
        },
        stop() {
          return false;
        },
      };
    },
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
    collectLocalSnapshotImpl: async ({ synced }) => {
      snapshotSynced = synced;
      return { managed: { envPath: synced.envPath } };
    },
    projectDir: dir,
  });

  assert.equal(calls[0][0], "register");
  assert.equal(calls[1][0], "heartbeat");
  assert.equal(calls[0][1].agentProtocolVersion, 1);
  assert.equal(calls[1][1].agentProtocolVersion, 1);
  assert.equal(calls[1][1].agentSnapshot.managed.envPath, snapshotSynced.envPath);
  assert.match(runnerEnv.DASHBOARD_AGENT_PAUSE_AFTER_RANGE_FILE, /\.tile-state\/dashboard\/control\/pause-after-range$/);
  assert.notEqual(runnerEnv.DASHBOARD_AGENT_PAUSE_AFTER_RANGE_FILE, "dashboard-override");
});

test("agent writes forwarded process output to the local console snapshot log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-log-"));
  const stateDir = path.join(dir, ".tile-state");
  const calls = [];
  let runnerEnv = null;
  const client = {
    async register() {
      return { status: "registered" };
    },
    async heartbeat(payload) {
      calls.push(["heartbeat", payload.agentSnapshot.console?.recentLines || []]);
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
      return {
        commands: [
          {
            id: "cmd-preflight",
            commandType: "run_preflight",
            payload: { configPath: "configs/a.json" },
            claimedAt: "claim-preflight",
          },
        ],
      };
    },
    async ackCommand(commandId) {
      calls.push(["ack", commandId]);
    },
    async postEvent(event) {
      calls.push(["event", event.message]);
    },
  };

  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));

  await runAgent({
    env: {
      MACHINE_ID: "server-01",
      DASHBOARD_URL: "https://dashboard.example.com",
      AGENT_TOKEN: "agent-token",
    },
    argv: ["--once"],
    stateDir,
    createClient: () => client,
    createRunner: ({ env, onLine }) => {
      runnerEnv = env;
      return {
        async run() {
          await onLine("preflight wrote this line", "stdout");
          return { code: 0, signal: null };
        },
        stop() {
          return false;
        },
      };
    },
    collectDiskInfoImpl: async () => [],
    projectDir: dir,
  });

  assert.match(runnerEnv.DASHBOARD_AGENT_LOG_PATH, /\.tile-state\/dashboard-agent\.log$/);
  assert.match(await readFile(path.join(stateDir, "dashboard-agent.log"), "utf8"), /preflight wrote this line/);
  assert.equal(calls.some((call) => call[0] === "event" && call[1] === "preflight wrote this line"), false);
  assert.equal(calls.some((call) => call[0] === "ack" && call[1] === "cmd-preflight"), true);
  assert.deepEqual(calls.at(-1)?.[0], "heartbeat");
  assert.match(calls.at(-1)?.[1]?.join("\n") || "", /preflight wrote this line/);
});

test("agent write_env command updates root env and preserves mapbox tokens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-write-env-"));
  await writeFile(path.join(dir, ".env"), "MAPBOX_ACCESS_TOKENS=pk.one,pk.two\nPORT=3001\n");
  const calls = [];
  const client = {
    async postEvent(event) {
      calls.push(["event", event.type, event.message]);
    },
    async ackCommand(commandId) {
      calls.push(["ack", commandId]);
    },
  };

  await runCommand({
    id: "cmd-write-env",
    commandType: "write_env",
    payload: { envText: "PORT=4000\nDASHBOARD_URL=https://dashboard.example.com\n" },
    claimedAt: "claim-write-env",
  }, {
    client,
    runner: { stop: () => false, run: async () => ({ code: 0, signal: null }) },
    machineId: "server-01",
    projectDir: dir,
    syncNow: async () => calls.push(["sync"]),
  });

  const envText = await readFile(path.join(dir, ".env"), "utf8");
  assert.match(envText, /PORT=4000/);
  assert.match(envText, /DASHBOARD_URL=https:\/\/dashboard\.example\.com/);
  assert.match(envText, /MAPBOX_ACCESS_TOKENS=pk\.one,pk\.two/);
  assert.deepEqual(calls.map((call) => call[0]), ["sync", "event", "ack"]);
});

test("agent write_env command refuses masked env values and leaves root env unchanged", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-write-env-mask-"));
  const originalEnv = "PORT=3001\nSTORJ_ACCESS=real-access\n";
  await writeFile(path.join(dir, ".env"), originalEnv);
  const calls = [];
  const client = {
    async postEvent(event) {
      calls.push(["event", event.type, event.message]);
    },
    async ackCommand(commandId, payload) {
      calls.push(["ack", commandId, payload]);
    },
  };

  await runCommand({
    id: "cmd-write-env-mask",
    commandType: "write_env",
    payload: { envText: "PORT=4000\nSTORJ_ACCESS=********\n" },
    claimedAt: "claim-write-env-mask",
  }, {
    client,
    runner: { stop: () => false, run: async () => ({ code: 0, signal: null }) },
    machineId: "server-01",
    projectDir: dir,
    syncNow: async () => calls.push(["sync"]),
  });

  assert.equal(await readFile(path.join(dir, ".env"), "utf8"), originalEnv);
  assert.equal(calls.some((call) => call[0] === "sync"), false);
  assert.equal(calls.find((call) => call[0] === "event")?.[1], "command.failed");
  assert.match(calls.find((call) => call[0] === "event")?.[2] || "", /masked \.env value/);
});

test("agent write_env command does not preserve an already masked mapbox token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-write-env-masked-preserve-"));
  await writeFile(path.join(dir, ".env"), "MAPBOX_ACCESS_TOKENS=********\nPORT=3001\n");
  const calls = [];
  const client = {
    async postEvent(event) {
      calls.push(["event", event.type, event.message]);
    },
    async ackCommand(commandId) {
      calls.push(["ack", commandId]);
    },
  };

  await runCommand({
    id: "cmd-write-env-no-mask-preserve",
    commandType: "write_env",
    payload: { envText: "PORT=4000\nDASHBOARD_URL=https://dashboard.example.com\n" },
    claimedAt: "claim-write-env-no-mask-preserve",
  }, {
    client,
    runner: { stop: () => false, run: async () => ({ code: 0, signal: null }) },
    machineId: "server-01",
    projectDir: dir,
    syncNow: async () => calls.push(["sync"]),
  });

  const envText = await readFile(path.join(dir, ".env"), "utf8");
  assert.doesNotMatch(envText, /MAPBOX_ACCESS_TOKENS=\*+/);
  assert.match(envText, /PORT=4000/);
  assert.match(envText, /DASHBOARD_URL=https:\/\/dashboard\.example\.com/);
  assert.deepEqual(calls.map((call) => call[0]), ["sync", "event", "ack"]);
});
