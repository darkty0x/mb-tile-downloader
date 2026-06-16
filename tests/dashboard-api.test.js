import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createDashboardApp } from "../dashboard/src/server/app.js";
import { createSecretVault } from "../dashboard/src/server/secrets.js";
import { createDashboardStore } from "../dashboard/src/server/store.js";

async function request(server, { method = "GET", path = "/", headers = {}, body } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function requestText(server, { method = "GET", path = "/", headers = {} } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers,
  });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

async function withServer(t, options = {}) {
  const app = createDashboardApp({
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
    agentToken: "agent-token",
    ...options,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  return app;
}

async function writeConfigTemplate(dir, fileName, overrides = {}) {
  const id = fileName.replace(/\.config\.json$/, "");
  await writeFile(
    path.join(dir, fileName),
    JSON.stringify(
      {
        jobName: id,
        provider: id.startsWith("esri") ? "esri" : "mapbox",
        layer: id.includes("satellite") ? "satellite" : "vector",
        format: id.includes("satellite") ? "jpg" : "pbf",
        ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
        ...overrides,
      },
      null,
      2
    )
  );
}

async function withTcpServer(t) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return server;
}

test("health endpoint does not require authentication", async (t) => {
  const server = await withServer(t);

  const response = await request(server, { path: "/health" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test("dashboard serves static assets from configured built client directory", async (t) => {
  const clientDir = await mkdtemp(path.join(os.tmpdir(), "mb-dashboard-client-"));
  await writeFile(path.join(clientDir, "index.html"), "<!doctype html><title>built dashboard</title>");
  const server = await withServer(t, { clientDir });

  const response = await requestText(server, { path: "/" });

  assert.equal(response.status, 200);
  assert.equal(response.contentType, "text/html; charset=utf-8");
  assert.match(response.body, /built dashboard/);
});

test("agent registration requires agent token", async (t) => {
  const server = await withServer(t);

  const response = await request(server, {
    method: "POST",
    path: "/api/agents/register",
    body: { machineId: "worker-a", agentInstanceId: "agent-1" },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "unauthorized");
});

test("agent can register and send heartbeat with disk snapshot", async (t) => {
  const server = await withServer(t);
  const headers = { authorization: "Bearer agent-token" };

  const registered = await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: {
      machineId: "worker-a",
      agentInstanceId: "agent-1",
      displayName: "Worker A",
    },
  });
  const heartbeat = await request(server, {
    method: "POST",
    path: "/api/agents/heartbeat",
    headers,
    body: {
      machineId: "worker-a",
      agentInstanceId: "agent-1",
      disk: [{ name: "C:", freeBytes: 100 }],
      agentSnapshot: { managed: { configPath: ".tile-state/dashboard/configs/cfg-a.json" } },
    },
  });

  assert.equal(registered.status, 200);
  assert.equal(registered.body.status, "registered");
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.machine.disk[0].name, "C:");
  assert.equal(heartbeat.body.machine.agentSnapshot.managed.configPath, ".tile-state/dashboard/configs/cfg-a.json");
});

test("agent registration conflict returns HTTP 409", async (t) => {
  const server = await withServer(t);
  const headers = { authorization: "Bearer agent-token" };

  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: { machineId: "worker-a", agentInstanceId: "agent-1" },
  });
  const conflict = await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: { machineId: "worker-a", agentInstanceId: "agent-2" },
  });

  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /already registered/);
});

test("dashboard machine list is available without an admin token", async (t) => {
  const server = await withServer(t);

  const response = await request(server, { path: "/api/machines" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.machines, []);
});

test("dashboard exposes configured agent setup token for copy fields", async (t) => {
  const server = await withServer(t, { agentToken: "configured-agent-token" });

  const response = await request(server, { path: "/api/agent-setup" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    agentTokenConfigured: true,
    agentToken: "configured-agent-token",
  });
});

test("dashboard can remove a machine and release its assigned secrets", async (t) => {
  const calls = [];
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
  });
  const server = await withServer(t, {
    store,
    secretVault: {
      async listSecretsForBrowser({ machineId } = {}) {
        if (machineId === "worker-a") {
          return [
            { secretId: "secret-a", machineId: "worker-a", secretType: "mapbox_token", status: "active" },
            { secretId: "secret-b", machineId: "worker-a", secretType: "proxy_txt", status: "active" },
          ];
        }
        return [];
      },
      async updateSecret(secretId, input) {
        calls.push([secretId, input]);
        return { secretId, ...input };
      },
      async listSecretsForAgent() {
        return [];
      },
    },
  });

  const deleted = await request(server, {
    method: "DELETE",
    path: "/api/machines/worker-a",
  });
  const listed = await request(server, { path: "/api/machines" });

  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.machine.machineId, "worker-a");
  assert.deepEqual(listed.body.machines, []);
  assert.deepEqual(calls, [
    ["secret-a", { machineId: null }],
    ["secret-b", { machineId: null }],
  ]);
});

test("dashboard can add and validate a server connection profile", async (t) => {
  const tcpServer = await withTcpServer(t);
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-1",
    displayName: "Server 01",
  });
  const server = await withServer(t, {
    store,
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => "credential-rdp",
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });
  const port = tcpServer.address().port;

  const created = await request(server, {
    method: "POST",
    path: "/api/server-connections",
    body: {
      label: "Server 01 RDP",
      machineId: "server-01",
      protocol: "rdp",
      host: "127.0.0.1",
      port,
      username: "root",
      password: "server-password",
    },
  });
  const validated = await request(server, {
    method: "POST",
    path: "/api/server-connections/credential-rdp/validate",
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.connection.machineId, null);
  assert.equal(created.body.connection.secretType, "server_rdp_credential");
  assert.equal(created.body.connection.targetMachineId, "server-01");
  assert.equal(created.body.connection.credential.machineId, "server-01");
  assert.equal(created.body.connection.credential.protocolUrl, `rdp://127.0.0.1:${port}`);
  assert.equal(JSON.stringify(created.body).includes("server-password"), false);
  assert.equal(validated.status, 200);
  assert.equal(validated.body.valid, true);
  assert.equal(validated.body.network.ok, true);
  assert.equal(validated.body.agent.ok, true);
  assert.equal(validated.body.controlPath, "agent");
});

test("dashboard settings expose and persist alert thresholds", async (t) => {
  const server = await withServer(t);

  const defaults = await request(server, { path: "/api/settings" });
  const updated = await request(server, {
    method: "PUT",
    path: "/api/settings",
    body: {
      alertThresholds: {
        mapboxTokensPerServer: 4,
        proxiesPerServer: 125,
      },
    },
  });
  const listed = await request(server, { path: "/api/settings" });

  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.body.settings.alertThresholds, {
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50,
  });
  assert.equal(defaults.body.settings.sync.dashboardPollMs, 5000);
  assert.equal(updated.status, 200);
  assert.deepEqual(listed.body.settings.alertThresholds, {
    mapboxTokensPerServer: 4,
    proxiesPerServer: 125,
  });
});

test("dashboard exposes reusable config type templates from root config files", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json");
  await writeConfigTemplate(templatesDir, "esri-satellite.config.json", {
    provider: "esri",
    layer: "esri-satellite",
    format: "jpg",
  });
  await writeConfigTemplate(templatesDir, "1-ukraine-mapbox-pbf-cmi.config.json");
  const server = await withServer(t, { configTemplatesDir: templatesDir });

  const response = await request(server, { path: "/api/config-templates" });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.templates.map((template) => template.id),
    ["esri-satellite", "mapbox-pbf"]
  );
  assert.deepEqual(
    response.body.templates.map((template) => template.sourcePath),
    ["configs/esri-satellite.config.json", "configs/mapbox-pbf.config.json"]
  );
});

test("dashboard batch config creation creates one runnable config per selected type", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json");
  await writeConfigTemplate(templatesDir, "esri-satellite.config.json", {
    provider: "esri",
    layer: "esri-satellite",
    format: "jpg",
  });
  let id = 0;
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
      idGenerator: () => `cfg-${++id}`,
    }),
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers: { authorization: "Bearer agent-token" },
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });

  const response = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      machineId: "worker-a",
      name: "Ukraine Range 01",
      active: true,
      templateIds: ["mapbox-pbf", "esri-satellite"],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.configs.map((config) => config.name),
    ["Ukraine Range 01 - mapbox-pbf", "Ukraine Range 01 - esri-satellite"]
  );
  assert.deepEqual(
    response.body.configs.map((config) => config.config.jobName),
    ["ukraine-range-01-mapbox-pbf", "ukraine-range-01-esri-satellite"]
  );
  assert.deepEqual(
    response.body.configs.map((config) => config.active),
    [true, false]
  );
});

test("dashboard batch config creation assigns selected config types to selected servers", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json");
  let id = 0;
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
      idGenerator: () => `cfg-${++id}`,
    }),
  });
  const headers = { authorization: "Bearer agent-token" };
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: { machineId: "worker-b", agentInstanceId: "agent-b", displayName: "Worker B" },
  });

  const response = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      name: "Ukraine",
      active: true,
      machineIds: ["worker-a", "worker-b"],
      templateIds: ["mapbox-pbf"],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.configs.map((config) => ({
      machineId: config.machineId,
      name: config.name,
      jobName: config.config.jobName,
      ranges: config.config.ranges.length,
      active: config.active,
    })),
    [
      {
        machineId: "worker-a",
        name: "Ukraine - Worker A",
        jobName: "ukraine-mapbox-pbf-worker-a",
        ranges: 1,
        active: true,
      },
      {
        machineId: "worker-b",
        name: "Ukraine - Worker B",
        jobName: "ukraine-mapbox-pbf-worker-b",
        ranges: 1,
        active: true,
      },
    ]
  );
});

test("dashboard batch config creation can split one selected type across selected servers", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json", {
    ranges: [{ zoom: 4, xStart: 0, xEnd: 3, yStart: 0, yEnd: 9 }],
  });
  let id = 0;
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
      idGenerator: () => `cfg-${++id}`,
    }),
  });
  const headers = { authorization: "Bearer agent-token" };
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: { machineId: "worker-b", agentInstanceId: "agent-b", displayName: "Worker B" },
  });

  const response = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      name: "Ukraine",
      active: true,
      splitAcrossMachines: true,
      machineIds: ["worker-a", "worker-b"],
      templateIds: ["mapbox-pbf"],
    },
  });
  const tileCounts = response.body.configs.map((config) =>
    config.config.ranges.reduce(
      (sum, range) => sum + (range.xEnd - range.xStart + 1) * (range.yEnd - range.yStart + 1),
      0
    )
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.configs.map((config) => config.machineId), ["worker-a", "worker-b"]);
  assert.deepEqual(response.body.configs.map((config) => config.config.jobName), [
    "ukraine-mapbox-pbf-worker-a",
    "ukraine-mapbox-pbf-worker-b",
  ]);
  assert.deepEqual(tileCounts, [20, 20]);
  assert.deepEqual(response.body.configs.map((config) => config.config.ranges.length), [2, 2]);
});

test("dashboard batch config creation rejects unknown server assignment", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json");
  const server = await withServer(t, { configTemplatesDir: templatesDir });

  const response = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      name: "Ukraine",
      machineIds: ["missing-worker"],
      templateIds: ["mapbox-pbf"],
    },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /unknown machine id: missing-worker/);
});

test("dashboard settings reject invalid alert thresholds", async (t) => {
  const server = await withServer(t);

  const response = await request(server, {
    method: "PUT",
    path: "/api/settings",
    body: {
      alertThresholds: {
        mapboxTokensPerServer: -1,
      },
    },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /mapboxTokensPerServer/);
});

test("dashboard settings expose and persist sync polling", async (t) => {
  const server = await withServer(t);

  const updated = await request(server, {
    method: "PUT",
    path: "/api/settings",
    body: {
      sync: {
        dashboardPollMs: 2500,
      },
    },
  });
  const listed = await request(server, { path: "/api/settings" });

  assert.equal(updated.status, 200);
  assert.equal(listed.body.settings.sync.dashboardPollMs, 2500);
});

test("dashboard app awaits async persistent store methods", async (t) => {
  const server = await withServer(t, {
    store: {
      async registerMachine() {
        return { status: "registered", machine: { machineId: "worker-a" } };
      },
      async listMachines() {
        return [{ machineId: "worker-a" }];
      },
    },
  });

  const registered = await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers: { authorization: "Bearer agent-token" },
    body: { machineId: "worker-a", agentInstanceId: "agent-1" },
  });
  const listed = await request(server, {
    path: "/api/machines",
    headers: { authorization: "Bearer admin-token" },
  });

  assert.equal(registered.body.status, "registered");
  assert.deepEqual(listed.body.machines, [{ machineId: "worker-a" }]);
});

test("dashboard app awaits async secret vault methods", async (t) => {
  const server = await withServer(t, {
    secretVault: {
      async createSecret(input) {
        return { secretId: "secret-a", machineId: input.machineId };
      },
      async listSecretsForBrowser() {
        return [{ secretId: "secret-a", redactedValue: "pk.s...alue" }];
      },
      async listSecretsForAgent() {
        return [{ secretId: "secret-a", value: "pk.secret-value" }];
      },
    },
  });

  const saved = await request(server, {
    method: "POST",
    path: "/api/secrets",
    headers: { authorization: "Bearer admin-token" },
    body: {
      machineId: "worker-a",
      secretType: "mapbox_token",
      label: "primary",
      value: "pk.secret-value",
    },
  });
  const agent = await request(server, {
    path: "/api/agents/secrets?machineId=worker-a",
    headers: { authorization: "Bearer agent-token" },
  });

  assert.equal(saved.body.secret.secretId, "secret-a");
  assert.equal(agent.body.secrets[0].value, "pk.secret-value");
});

test("dashboard app exposes secret update and delete management routes", async (t) => {
  const calls = [];
  const server = await withServer(t, {
    secretVault: {
      async createSecret(input) {
        calls.push(["create", input]);
        return { secretId: "secret-a", machineId: input.machineId };
      },
      async updateSecret(secretId, input) {
        calls.push(["update", secretId, input]);
        return { secretId, machineId: input.machineId || "worker-a" };
      },
      async deleteSecret(secretId) {
        calls.push(["delete", secretId]);
        return { secretId };
      },
      async listSecretsForBrowser() {
        return [{ secretId: "secret-a", redactedValue: "pk.s...alue", status: "inactive" }];
      },
      async listSecretsForAgent() {
        return [];
      },
    },
  });

  const updated = await request(server, {
    method: "PUT",
    path: "/api/secrets/secret-a",
    headers: { authorization: "Bearer admin-token" },
    body: { machineId: "worker-a", label: "backup", status: "inactive" },
  });
  const deleted = await request(server, {
    method: "DELETE",
    path: "/api/secrets/secret-a",
    headers: { authorization: "Bearer admin-token" },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.secret.status, "inactive");
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.secretId, "secret-a");
  assert.equal(calls[0][0], "update");
  assert.equal(calls[1][0], "delete");
});

test("dashboard secret route imports proxy lists as global pool items", async (t) => {
  let id = 0;
  const server = await withServer(t, {
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => `secret-${++id}`,
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });
  const headers = { authorization: "Bearer admin-token" };

  const saved = await request(server, {
    method: "POST",
    path: "/api/secrets",
    headers,
    body: {
      secretType: "proxy_txt",
      label: "premium proxy",
      value: "http://proxy-a.example:8080, http://proxy-b.example:8080",
    },
  });
  const listed = await request(server, {
    path: "/api/secrets",
    headers,
  });

  assert.equal(saved.status, 200);
  assert.equal(listed.body.secrets.filter((secret) => secret.secretType === "proxy_txt").length, 2);
  assert.equal(listed.body.secrets.every((secret) => secret.machineId === null), true);
  assert.equal(listed.body.secrets.every((secret) => secret.usage === "available"), true);
});

test("dashboard secret route stores credentials with redacted browser metadata", async (t) => {
  const server = await withServer(t, {
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => "credential-a",
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });
  const headers = { authorization: "Bearer admin-token" };

  const saved = await request(server, {
    method: "POST",
    path: "/api/secrets",
    headers,
    body: {
      secretType: "credential",
      label: "Storj",
      value: JSON.stringify({
        protocolUrl: "https://ap1.storj.io",
        username: "operator@example.com",
        password: "very-secret-password",
      }),
    },
  });
  const listed = await request(server, {
    path: "/api/secrets",
    headers,
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.secret.secretType, "credential");
  assert.deepEqual(saved.body.secret.credential, {
    protocolUrl: "https://ap1.storj.io",
    protocol: "https",
    host: "ap1.storj.io",
    port: 443,
    username: "operator@example.com",
    hasPassword: true,
  });
  assert.equal(JSON.stringify(listed.body).includes("very-secret-password"), false);
  assert.equal(listed.body.secrets[0].redactedValue, "operator@example.com @ ap1.storj.io");
});

test("dashboard secret edit route returns one decrypted credential without unredacting lists", async (t) => {
  const server = await withServer(t, {
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => "credential-a",
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });

  await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "credential",
      label: "Server 01",
      value: JSON.stringify({
        protocolUrl: "rdp://95.216.38.91:7777",
        machineId: "SERVER-01",
        username: "root",
        password: "server-password",
      }),
    },
  });
  const single = await request(server, { path: "/api/secrets/credential-a" });
  const listed = await request(server, { path: "/api/secrets" });

  assert.equal(single.status, 200);
  assert.equal(single.body.secret.secretType, "credential");
  assert.equal(JSON.parse(single.body.secret.value).password, "server-password");
  assert.equal(JSON.stringify(listed.body).includes("server-password"), false);
});

test("dashboard credential update route persists edited agent id", async (t) => {
  const server = await withServer(t, {
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => "credential-a",
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });

  await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "credential",
      label: "Server 02",
      value: JSON.stringify({
        protocolUrl: "rdp://195.201.245.29:7777",
        machineId: "SERVER-02",
        username: "root",
        password: "server-password",
      }),
    },
  });
  const updated = await request(server, {
    method: "PUT",
    path: "/api/secrets/credential-a",
    body: {
      label: "Server 02",
      status: "active",
      value: JSON.stringify({
        protocolUrl: "rdp://195.201.245.29:7777",
        machineId: "SERVER-22",
        username: "root",
        password: "server-password",
      }),
    },
  });
  const single = await request(server, { path: "/api/secrets/credential-a" });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.secret.targetMachineId, "SERVER-22");
  assert.equal(updated.body.secret.credential.machineId, "SERVER-22");
  assert.equal(JSON.parse(single.body.secret.value).machineId, "SERVER-22");
});
