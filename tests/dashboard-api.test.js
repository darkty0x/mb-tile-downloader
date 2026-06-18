import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createDashboardApp } from "../dashboard/src/server/app.js";
import { createMemoryAuthStore, hashPassword } from "../dashboard/src/server/auth.js";
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
    headers: response.headers,
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
    secretValidator: {
      async validateSecret() {
        return { ok: true, status: "active", message: "test validator accepted" };
      },
    },
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

test("dashboard serves client app for routed page URLs", async (t) => {
  const clientDir = await mkdtemp(path.join(os.tmpdir(), "mb-dashboard-client-route-"));
  await writeFile(path.join(clientDir, "index.html"), "<!doctype html><title>built dashboard</title>");
  const server = await withServer(t, { clientDir });

  const response = await requestText(server, { path: "/servers?machineId=server-01&serverTab=env" });

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

test("agent snapshots import local mapbox tokens and proxies into the secret vault", async (t) => {
  let id = 0;
  const server = await withServer(t, {
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => `secret-${++id}`,
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });
  const headers = { authorization: "Bearer agent-token" };

  const registered = await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: {
      machineId: "SERVER-01",
      agentInstanceId: "agent-1",
      agentSnapshot: {
        secrets: {
          mapboxTokens: ["pk.mapbox-a", "pk.mapbox-b", "pk.mapbox-a"],
          proxy: { values: ["http://proxy-a.example:3129", "http://proxy-b.example:3129", "http://proxy-a.example:3129"] },
        },
      },
    },
  });
  const heartbeat = await request(server, {
    method: "POST",
    path: "/api/agents/heartbeat",
    headers,
    body: {
      machineId: "server-01",
      agentInstanceId: "agent-1",
      agentSnapshot: {
        secrets: {
          mapboxTokens: ["pk.mapbox-a", "pk.mapbox-b"],
          proxy: { values: ["http://proxy-a.example:3129", "http://proxy-b.example:3129"] },
        },
      },
    },
  });
  const listed = await request(server, { path: "/api/secrets" });
  const mapboxTokens = listed.body.secrets.filter((secret) => secret.secretType === "mapbox_token");
  const proxies = listed.body.secrets.filter((secret) => secret.secretType === "proxy_txt");

  assert.equal(registered.status, 200);
  assert.deepEqual(registered.body.discoveredSecrets, { imported: 4, assigned: 4 });
  assert.equal(heartbeat.status, 200);
  assert.deepEqual(heartbeat.body.discoveredSecrets, { imported: 4, assigned: 4 });
  assert.equal(mapboxTokens.length, 2);
  assert.equal(proxies.length, 2);
  assert.deepEqual(mapboxTokens.map((secret) => secret.machineId), ["server-01", "server-01"]);
  assert.deepEqual(proxies.map((secret) => secret.machineId), ["server-01", "server-01"]);
  assert.deepEqual(mapboxTokens.map((secret) => secret.value).sort(), ["pk.mapbox-a", "pk.mapbox-b"]);
  assert.deepEqual(proxies.map((secret) => secret.value).sort(), ["http://proxy-a.example:3129", "http://proxy-b.example:3129"]);
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

test("dashboard browser APIs require login when auth store is configured", async (t) => {
  const authStore = createMemoryAuthStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await authStore.seedDefaultAdmin({
    userId: "admin",
    email: "admin@example.com",
    username: "admin",
    role: "Administrator",
    passwordHash: await hashPassword("test-pass"),
  });
  const server = await withServer(t, { authStore });

  const rejected = await request(server, { path: "/api/machines" });
  const login = await request(server, {
    method: "POST",
    path: "/api/auth/login",
    body: { login: "admin@example.com", password: "test-pass" },
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const listed = await request(server, {
    path: "/api/machines",
    headers: { cookie },
  });

  assert.equal(rejected.status, 401);
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, "admin");
  assert.match(cookie, /^ptg_session=/);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.machines, []);
});

test("dashboard login sessions support account update and logout", async (t) => {
  const authStore = createMemoryAuthStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await authStore.seedDefaultAdmin({
    userId: "admin",
    email: "admin@example.com",
    username: "admin",
    role: "Administrator",
    passwordHash: await hashPassword("test-pass"),
  });
  const server = await withServer(t, { authStore });

  const login = await request(server, {
    method: "POST",
    path: "/api/auth/login",
    body: { login: "admin", password: "test-pass" },
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const updated = await request(server, {
    method: "PUT",
    path: "/api/auth/account",
    headers: { cookie },
    body: {
      email: "owner@example.com",
      username: "owner",
      currentPassword: "test-pass",
      password: "next-pass",
    },
  });
  const me = await request(server, {
    path: "/api/auth/me",
    headers: { cookie },
  });
  const logout = await request(server, {
    method: "POST",
    path: "/api/auth/logout",
    headers: { cookie },
  });
  const afterLogout = await request(server, {
    path: "/api/auth/me",
    headers: { cookie },
  });
  const relogin = await request(server, {
    method: "POST",
    path: "/api/auth/login",
    body: { login: "owner", password: "next-pass" },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.email, "owner@example.com");
  assert.equal(me.body.user.username, "owner");
  assert.equal(logout.status, 200);
  assert.equal(afterLogout.status, 401);
  assert.equal(relogin.status, 200);
  assert.equal(relogin.body.user.email, "owner@example.com");
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
      machineId: "SERVER-01",
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

test("server connection validation rejects standalone credential records", async (t) => {
  const server = await withServer(t, {
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => "credential-generic",
    }),
  });

  const saved = await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "credential",
      label: "PowerVPS",
      value: JSON.stringify({
        protocolUrl: "https://dash.powervps.net/billmgr?func=logon",
        username: "operator@example.com",
        password: "account-password",
      }),
    },
  });
  const validated = await request(server, {
    method: "POST",
    path: "/api/server-connections/credential-generic/validate",
  });

  assert.equal(saved.status, 200);
  assert.equal(validated.status, 400);
  assert.match(validated.body.error, /server credential secret/);
});

test("dashboard rejects server connection profiles without an Agent ID", async (t) => {
  const tcpServer = await withTcpServer(t);
  const server = await withServer(t, {
    secretVault: createSecretVault({ appSecret: "test-secret" }),
  });

  const created = await request(server, {
    method: "POST",
    path: "/api/server-connections",
    body: {
      label: "Server 02",
      protocol: "rdp",
      host: "127.0.0.1",
      port: tcpServer.address().port,
      username: "root",
      password: "server-password",
    },
  });

  assert.equal(created.status, 400);
  assert.match(created.body.error, /Agent ID is required/);
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
  const templates = response.body.templates;
  assert.ok(templates.length >= 9);
  assert.ok(templates.some((template) => template.id === "mapbox-dem"));
  assert.ok(templates.some((template) => template.id === "mapbox-satellite"));
  assert.equal(
    templates.find((template) => template.id === "esri-satellite").sourcePath,
    "configs/esri-satellite.config.json"
  );
  assert.equal(
    templates.find((template) => template.id === "mapbox-pbf").sourcePath,
    "configs/mapbox-pbf.config.json"
  );
});

test("dashboard exposes built-in config presets when no root config files exist", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-empty-"));
  const server = await withServer(t, { configTemplatesDir: templatesDir });

  const response = await request(server, { path: "/api/config-templates" });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.templates.map((template) => template.id),
    [
      "esri-satellite",
      "mapbox-dem",
      "mapbox-pbf",
      "mapbox-raster-tileset",
      "mapbox-rasterarray-mrt",
      "mapbox-satellite",
      "mapbox-style-static-tiles",
      "mapbox-vector-mvt",
      "mapbox-vector-style-optimized",
    ]
  );
  assert.equal(response.body.templates.every((template) => template.sourceType === "preset"), true);
  assert.equal(response.body.templates.some((template) => "rangeCount" in template), false);
});

test("dashboard parses config ranges from bounds tile strings and JSON", async (t) => {
  const server = await withServer(t);

  const bounds = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: "LB: 34.799, 46.82\nTR: 40.739, 52.272",
      zoomStart: 19,
      zoomEnd: 19,
    },
  });
  const tileString = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: "19/312824/339498/ - 19/321475/351754",
    },
  });
  const jsonRanges = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: JSON.stringify([{ zoom: 12, xStart: 1, xEnd: 2, yStart: 3, yEnd: 4 }]),
    },
  });
  const missingZoom = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: "LB: 34.799, 46.82\nTR: 40.739, 52.272",
    },
  });

  assert.equal(bounds.status, 200);
  assert.deepEqual(bounds.body.ranges[0], {
    zoomStart: 19,
    zoomEnd: 19,
    xStart: 312823,
    xEnd: 321474,
    yStart: 172534,
    yEnd: 184789,
    label: "bounds z=19 lon=34.799-40.739 lat=46.82-52.272",
  });
  assert.equal(tileString.status, 200);
  assert.deepEqual(tileString.body.ranges[0], {
    zoomStart: 19,
    zoomEnd: 19,
    xStart: 312824,
    xEnd: 321475,
    yStart: 339498,
    yEnd: 351754,
    label: "range#1: z=19 x=312824-321475 y=339498-351754",
  });
  assert.equal(jsonRanges.status, 200);
  assert.equal(jsonRanges.body.tiles, 4);
  assert.equal(missingZoom.status, 400);
  assert.match(missingZoom.body.error, /zoom/);
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
      rangeInput: JSON.stringify([{ zoom: 3, xStart: 1, xEnd: 1, yStart: 2, yEnd: 2 }]),
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
  assert.deepEqual(
    response.body.configs.map((config) => config.config.ranges),
    [
      [{ zoomStart: 3, zoomEnd: 3, xStart: 1, xEnd: 1, yStart: 2, yEnd: 2, label: "range#1: z=3 x=1-1 y=2-2" }],
      [{ zoomStart: 3, zoomEnd: 3, xStart: 1, xEnd: 1, yStart: 2, yEnd: 2, label: "range#1: z=3 x=1-1 y=2-2" }],
    ]
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
      rangeInput: "z=3 x=2-2 y=1-1",
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
      rangeInput: JSON.stringify([{ zoom: 4, xStart: 0, xEnd: 3, yStart: 0, yEnd: 9 }]),
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
      rangeInput: "z=3 x=1-1 y=1-1",
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

test("dashboard settings expose and persist workflow notification and retry policy", async (t) => {
  const server = await withServer(t);

  const updated = await request(server, {
    method: "PUT",
    path: "/api/settings",
    body: {
      workflow: {
        autoStartNextRange: false,
        requirePreflightBeforeStart: true,
        stopTimeoutMs: 45000,
      },
      notifications: {
        telegramEnabled: true,
        webConsoleEnabled: true,
        dedupeWindowMs: 120000,
        minSeverity: "warn",
      },
      retry: {
        commandRetryLimit: 5,
        reportBackoffMs: 7500,
      },
    },
  });
  const listed = await request(server, { path: "/api/settings" });

  assert.equal(updated.status, 200);
  assert.deepEqual(listed.body.settings.workflow, {
    autoStartNextRange: false,
    requirePreflightBeforeStart: true,
    stopTimeoutMs: 45000,
  });
  assert.deepEqual(listed.body.settings.notifications, {
    telegramEnabled: true,
    webConsoleEnabled: true,
    dedupeWindowMs: 120000,
    minSeverity: "warn",
  });
  assert.deepEqual(listed.body.settings.retry, {
    commandRetryLimit: 5,
    reportBackoffMs: 7500,
  });
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

test("dashboard app bulk deletes selected secrets", async (t) => {
  const calls = [];
  const server = await withServer(t, {
    secretVault: {
      async deleteSecret(secretId) {
        calls.push(secretId);
        return { secretId };
      },
      async listSecretsForBrowser() {
        return [];
      },
      async listSecretsForAgent() {
        return [];
      },
    },
  });

  const deleted = await request(server, {
    method: "DELETE",
    path: "/api/secrets",
    headers: { authorization: "Bearer admin-token" },
    body: { secretIds: ["proxy-a", "proxy-b", "proxy-a"] },
  });

  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.secretIds, ["proxy-a", "proxy-b"]);
  assert.deepEqual(calls, ["proxy-a", "proxy-b"]);
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

test("dashboard secret route assigns new pool items across registered machines", async (t) => {
  let id = 0;
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({ machineId: "worker-a", agentInstanceId: "agent-a" });
  store.registerMachine({ machineId: "worker-b", agentInstanceId: "agent-b" });
  const server = await withServer(t, {
    store,
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => `secret-${++id}`,
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });

  const saved = await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "mapbox_token",
      label: "mapbox",
      value: "pk.token-a,pk.token-b",
    },
  });
  const listed = await request(server, { path: "/api/secrets" });

  assert.equal(saved.status, 200);
  assert.deepEqual(
    listed.body.secrets
      .filter((secret) => secret.secretType === "mapbox_token")
      .map((secret) => secret.machineId)
      .sort(),
    ["worker-a", "worker-b"]
  );
});

test("dashboard validates Mapbox tokens and proxies before assigning pool items", async (t) => {
  let id = 0;
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({ machineId: "worker-a", agentInstanceId: "agent-a" });
  const server = await withServer(t, {
    store,
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => `secret-${++id}`,
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
    secretValidator: {
      async validateSecret({ secretType, value }) {
        return {
          ok: !String(value).includes("bad"),
          status: String(value).includes("bad") ? "invalid" : "active",
          message: String(value).includes("bad") ? `${secretType} rejected` : `${secretType} ok`,
        };
      },
    },
  });

  const mapbox = await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "mapbox_token",
      label: "mapbox",
      value: "pk.good-token,pk.bad-token",
    },
  });
  const proxies = await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "proxy_txt",
      label: "proxy",
      value: "http://good-proxy.example:8080,http://bad-proxy.example:8080",
    },
  });
  const agent = await request(server, {
    path: "/api/agents/secrets?machineId=worker-a",
    headers: { authorization: "Bearer agent-token" },
  });
  const listed = await request(server, { path: "/api/secrets" });

  assert.equal(mapbox.status, 200);
  assert.equal(proxies.status, 200);
  assert.deepEqual(
    listed.body.secrets
      .filter((secret) => secret.secretType === "mapbox_token")
      .map((secret) => [secret.status, secret.usage])
      .sort(),
    [["active", "assigned"], ["invalid", "disabled"]]
  );
  assert.deepEqual(
    listed.body.secrets
      .filter((secret) => secret.secretType === "proxy_txt")
      .map((secret) => [secret.status, secret.usage])
      .sort(),
    [["active", "assigned"], ["invalid", "disabled"]]
  );
  assert.equal(agent.body.secrets.some((secret) => /bad/.test(secret.value)), false);
});

test("dashboard validates assigned Mapbox keys before targeted rebalance", async (t) => {
  let id = 0;
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  for (const machineId of ["worker-a", "worker-b", "worker-c"]) {
    store.registerMachine({ machineId, agentInstanceId: `${machineId}-agent` });
  }
  const secretVault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  secretVault.createSecret({
    machineId: "worker-a",
    secretType: "mapbox_token",
    label: "existing good",
    value: "pk.existing-good",
    status: "active",
  });
  secretVault.createSecret({
    machineId: "worker-a",
    secretType: "mapbox_token",
    label: "existing bad",
    value: "pk.existing-bad",
    status: "active",
  });
  const server = await withServer(t, {
    store,
    secretVault,
    secretValidator: {
      async validateSecret({ value }) {
        return String(value).includes("bad")
          ? { ok: false, status: "invalid", message: "expired token" }
          : { ok: true, status: "active", message: "valid token" };
      },
    },
  });

  const saved = await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "mapbox_token",
      label: "mapbox",
      value: "pk.new-1,pk.new-2,pk.new-3,pk.new-4,pk.new-5,pk.new-6,pk.new-7",
      machineIds: ["worker-a", "worker-b", "worker-c"],
      validateExisting: true,
    },
  });
  const listed = await request(server, { path: "/api/secrets" });
  const activeCounts = listed.body.secrets
    .filter((secret) => secret.secretType === "mapbox_token" && secret.status === "active")
    .reduce((counts, secret) => {
      counts[secret.machineId] = (counts[secret.machineId] || 0) + 1;
      return counts;
    }, {});

  assert.equal(saved.status, 200);
  assert.equal(listed.body.secrets.find((secret) => secret.label === "existing bad").status, "invalid");
  assert.deepEqual(activeCounts, { "worker-a": 3, "worker-b": 3, "worker-c": 2 });
});

test("dashboard rebalance revalidates keys and queues env sync only for download and validate jobs", async (t) => {
  let id = 0;
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  for (const machineId of ["download-worker", "validate-worker", "zip-worker", "upload-worker"]) {
    store.registerMachine({ machineId, agentInstanceId: `${machineId}-agent` });
  }
  store.upsertJob({
    jobId: "job-download",
    machineId: "download-worker",
    configId: "config-a",
    status: "running",
    stage: "download",
  });
  store.upsertJob({
    jobId: "job-validate",
    machineId: "validate-worker",
    configId: "config-a",
    status: "running",
    stage: "validate",
  });
  store.upsertJob({
    jobId: "job-zip",
    machineId: "zip-worker",
    configId: "config-a",
    status: "running",
    stage: "zip",
  });
  store.upsertJob({
    jobId: "job-upload",
    machineId: "upload-worker",
    configId: "config-a",
    status: "running",
    stage: "upload",
  });
  const secretVault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  for (const machineId of ["download-worker", "validate-worker", "zip-worker", "upload-worker"]) {
    secretVault.createSecret({
      machineId,
      secretType: "mapbox_token",
      label: `${machineId}-token`,
      value: `pk.${machineId}`,
      status: "active",
    });
  }
  const server = await withServer(t, {
    store,
    secretVault,
    secretValidator: {
      async validateSecret({ value }) {
        return String(value).includes("zip-worker")
          ? { ok: false, status: "invalid", message: "expired token" }
          : { ok: true, status: "active", message: "valid token" };
      },
    },
  });

  const rebalance = await request(server, {
    method: "POST",
    path: "/api/secrets/rebalance",
    body: {
      validateExisting: true,
      secretTypes: ["mapbox_token"],
    },
  });
  const downloadCommands = store.claimCommands({ machineId: "download-worker" });
  const validateCommands = store.claimCommands({ machineId: "validate-worker" });
  const zipCommands = store.claimCommands({ machineId: "zip-worker" });
  const uploadCommands = store.claimCommands({ machineId: "upload-worker" });
  const listed = await request(server, { path: "/api/secrets" });

  assert.equal(rebalance.status, 200);
  assert.equal(rebalance.body.validation.checked, 4);
  assert.equal(rebalance.body.syncEnv.queued, 2);
  assert.deepEqual(downloadCommands.map((command) => command.commandType), ["sync_env"]);
  assert.deepEqual(validateCommands.map((command) => command.commandType), ["sync_env"]);
  assert.deepEqual(zipCommands, []);
  assert.deepEqual(uploadCommands, []);
  assert.equal(listed.body.secrets.find((secret) => secret.label === "zip-worker-token").status, "invalid");
});

test("dashboard telegram env route queues root env writes for all machines with env snapshots", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-a",
    agentSnapshot: {
      envFiles: [{
        path: ".env",
        exists: true,
        content: "PORT=3001\nTELEGRAM_BOT_TOKEN=old-token\nKEEP_ME=yes",
      }],
    },
  });
  store.registerMachine({
    machineId: "worker-b",
    agentInstanceId: "agent-b",
    agentSnapshot: {
      envFiles: [{
        path: ".env",
        exists: true,
        variables: [
          { name: "DASHBOARD_URL", value: "https://dashboard.example" },
        ],
      }],
    },
  });
  store.registerMachine({
    machineId: "worker-c",
    agentInstanceId: "agent-c",
    agentSnapshot: { envFiles: [] },
  });
  const server = await withServer(t, { store });

  const updated = await request(server, {
    method: "POST",
    path: "/api/env/telegram",
    body: {
      botToken: "123456:ABC-def",
      chatId: "-100123",
    },
  });
  const workerACommands = store.claimCommands({ machineId: "worker-a" });
  const workerBCommands = store.claimCommands({ machineId: "worker-b" });
  const workerCCommands = store.claimCommands({ machineId: "worker-c" });

  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.queued.map((item) => item.machineId), ["worker-a", "worker-b"]);
  assert.deepEqual(updated.body.skipped, [{ machineId: "worker-c", reason: ".env snapshot missing" }]);
  assert.equal(workerACommands[0].commandType, "write_env");
  assert.match(workerACommands[0].payload.envText, /PORT=3001/);
  assert.match(workerACommands[0].payload.envText, /TELEGRAM_BOT_TOKEN=123456:ABC-def/);
  assert.match(workerACommands[0].payload.envText, /TELEGRAM_CHAT_ID=-100123/);
  assert.match(workerACommands[0].payload.envText, /KEEP_ME=yes/);
  assert.equal(workerBCommands[0].commandType, "write_env");
  assert.match(workerBCommands[0].payload.envText, /DASHBOARD_URL=https:\/\/dashboard\.example/);
  assert.match(workerBCommands[0].payload.envText, /TELEGRAM_BOT_TOKEN=123456:ABC-def/);
  assert.deepEqual(workerCCommands, []);
});

test("dashboard exposes a validator route for existing Mapbox and proxy secrets", async (t) => {
  let id = 0;
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  vault.createSecret({
    secretType: "proxy_txt",
    label: "proxy",
    value: "http://proxy.example:8080",
  });
  const server = await withServer(t, {
    secretVault: vault,
    secretValidator: {
      async validateSecret() {
        return { ok: false, status: "invalid", message: "proxy rejected" };
      },
    },
  });

  const validated = await request(server, {
    method: "POST",
    path: "/api/secrets/secret-1/validate",
  });
  const listed = await request(server, { path: "/api/secrets" });

  assert.equal(validated.status, 200);
  assert.equal(validated.body.validation.status, "invalid");
  assert.equal(validated.body.secret.status, "invalid");
  assert.equal(listed.body.secrets[0].usage, "disabled");
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

test("dashboard server credential update route persists edited agent id", async (t) => {
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
      secretType: "server_rdp_credential",
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
  assert.equal(updated.body.secret.targetMachineId, "server-22");
  assert.equal(updated.body.secret.credential.machineId, "server-22");
  assert.equal(JSON.parse(single.body.secret.value).machineId, "server-22");
});

test("dashboard only rejects server credential secrets without an Agent ID", async (t) => {
  const server = await withServer(t, {
    secretVault: createSecretVault({ appSecret: "test-secret" }),
  });

  const serverTyped = await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "server_rdp_credential",
      label: "Server 02",
      value: JSON.stringify({
        protocolUrl: "rdp://195.201.245.29:7777",
        username: "root",
        password: "server-password",
      }),
    },
  });
  const genericRdp = await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "credential",
      label: "Server 02",
      value: JSON.stringify({
        protocolUrl: "rdp://195.201.245.29:7777",
        username: "root",
        password: "server-password",
      }),
    },
  });

  assert.equal(serverTyped.status, 400);
  assert.match(serverTyped.body.error, /Agent ID is required/);
  assert.equal(genericRdp.status, 200);
  assert.equal(genericRdp.body.secret.secretType, "credential");
  assert.equal(genericRdp.body.secret.targetMachineId, undefined);
  assert.equal(genericRdp.body.secret.credential.machineId, undefined);
});
