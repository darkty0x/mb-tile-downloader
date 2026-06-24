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

async function rawHttpRequest(server, requestText) {
  const { port } = server.address();
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(requestText));
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(data));
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error("raw request timed out"));
    });
  });
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

test("deleting an active config stops matching running jobs and queues a scoped stop command", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-01",
  });
  const config = await store.createConfig({
    machineId: "server-01",
    name: "range-a",
    active: true,
    config: {
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    },
  });
  await store.upsertJob({
    jobId: "job-a",
    machineId: "server-01",
    configId: config.configId,
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 1 },
  });

  const server = await withServer(t, { store });
  const deleted = await request(server, {
    method: "DELETE",
    path: `/api/configs/${encodeURIComponent(config.configId)}`,
  });
  const jobs = await store.listJobs({ machineId: "server-01" });
  const commands = await store.claimCommands({ machineId: "server-01" });

  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.stoppedJobs.length, 1);
  assert.equal(deleted.body.stoppedJobs[0].jobId, "job-a");
  assert.equal(deleted.body.command.commandType, "stop_pipeline");
  assert.equal(deleted.body.command.payload.configId, config.configId);
  assert.equal(jobs.find((job) => job.jobId === "job-a")?.status, "stopped");
  assert.equal(commands[0].commandType, "stop_pipeline");
  assert.equal(commands[0].payload.configId, config.configId);
});

test("deleting an active config without a running job does not queue a stop command", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-01",
  });
  const config = await store.createConfig({
    machineId: "server-01",
    name: "range-idle",
    active: true,
    config: {
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    },
  });

  const server = await withServer(t, { store });
  const deleted = await request(server, {
    method: "DELETE",
    path: `/api/configs/${encodeURIComponent(config.configId)}`,
  });
  const commands = await store.claimCommands({ machineId: "server-01" });

  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.stoppedJobs, []);
  assert.equal(deleted.body.command, null);
  assert.deepEqual(commands, []);
});

test("deleting a machine job removes task state and clears active job", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({
    machineId: "server-09",
    agentInstanceId: "agent-09",
  });
  await store.upsertJob({
    jobId: "job-delete",
    machineId: "server-09",
    configId: "config-a",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 1 },
  });

  const server = await withServer(t, { store });
  const deleted = await request(server, {
    method: "DELETE",
    path: "/api/machines/server-09/jobs/job-delete",
  });
  const jobs = await store.listJobs({ machineId: "server-09" });
  const machine = await store.getMachine("server-09");

  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.count, 1);
  assert.equal(deleted.body.jobs[0].jobId, "job-delete");
  assert.equal(jobs.length, 0);
  assert.equal(machine.currentJobId, null);
});

test("queueing stop command immediately stops active jobs and cancels pending starts", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({
    machineId: "server-09",
    agentInstanceId: "agent-09",
  });
  await store.upsertJob({
    jobId: "job-active",
    machineId: "server-09",
    configId: "config-a",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { percent: 1 },
  });
  await store.queueCommand({
    machineId: "server-09",
    commandType: "start_pipeline",
    payload: { configPath: "configs/config-a.config.json" },
    requestedBy: "test",
  });

  const server = await withServer(t, { store });
  const stopped = await request(server, {
    method: "POST",
    path: "/api/machines/server-09/commands",
    body: {
      commandType: "stop_pipeline",
      payload: {},
      requestedBy: "dashboard",
    },
  });
  const jobs = await store.listJobs({ machineId: "server-09" });
  const commands = await store.claimCommands({ machineId: "server-09" });

  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.stoppedJobs.length, 1);
  assert.equal(stopped.body.canceledCommands.length, 1);
  assert.equal(jobs.find((job) => job.jobId === "job-active")?.status, "stopped");
  assert.deepEqual(commands.map((command) => command.commandType), ["stop_pipeline"]);
});

test("dashboard global command route queues git pull restart for connected machines", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({ machineId: "server-01", agentInstanceId: "agent-01" });
  await store.registerMachine({ machineId: "server-02", agentInstanceId: "agent-02" });
  const server = await withServer(t, { store });

  const response = await request(server, {
    method: "POST",
    path: "/api/machines/commands",
    body: {
      commandType: "git_pull_restart",
      requestedBy: "dashboard.bulk",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.count, 2);
  assert.deepEqual(response.body.machineIds, ["server-01", "server-02"]);
  assert.deepEqual(
    store.claimCommands({ machineId: "server-01" }).map((command) => command.commandType),
    ["git_pull_restart"]
  );
  assert.deepEqual(
    store.claimCommands({ machineId: "server-02" }).map((command) => command.commandType),
    ["git_pull_restart"]
  );
});

test("health endpoint does not require authentication", async (t) => {
  const server = await withServer(t);

  const response = await request(server, { path: "/health" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test("dashboard rejects malformed request target without crashing", async (t) => {
  const server = await withServer(t);

  const response = await rawHttpRequest(server, "GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  const health = await request(server, { path: "/health" });

  assert.match(response, /^HTTP\/1\.1 400 Bad Request/m);
  assert.match(response, /invalid request url/);
  assert.equal(health.status, 200);
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

test("agent heartbeat preserves local config JSON content in machine snapshots", async (t) => {
  const server = await withServer(t);
  const headers = { authorization: "Bearer agent-token" };
  const localConfigContent = JSON.stringify(
    {
      jobName: "mapbox-pbf-19-kuh",
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      ranges: [{ zoom: 19, xStart: 320278, xEnd: 323703, yStart: 168505, yEnd: 186571 }],
    },
    null,
    2
  );

  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers,
    body: {
      machineId: "server-05",
      agentInstanceId: "agent-5",
      agentSnapshot: {
        configs: [
          {
            name: "mapbox-pbf-19-kuh",
            fileName: "mapbox-pbf-19-kuh.config.json",
            path: "configs/mapbox-pbf-19-kuh.config.json",
            absolutePath: "D:/mb-tile-downloader/configs/mapbox-pbf-19-kuh.config.json",
            provider: "mapbox",
            ranges: 1,
            content: localConfigContent,
            config: JSON.parse(localConfigContent),
          },
        ],
      },
    },
  });

  const heartbeat = await request(server, {
    method: "POST",
    path: "/api/agents/heartbeat",
    headers,
    body: {
      machineId: "SERVER-05",
      agentInstanceId: "agent-5",
      agentSnapshot: {
        configs: [
          {
            name: "mapbox-pbf-19-kuh",
            fileName: "mapbox-pbf-19-kuh.config.json",
            path: "configs/mapbox-pbf-19-kuh.config.json",
            absolutePath: "D:/mb-tile-downloader/configs/mapbox-pbf-19-kuh.config.json",
            provider: "mapbox",
            ranges: 1,
            content: localConfigContent,
            config: JSON.parse(localConfigContent),
          },
        ],
      },
    },
  });
  const machines = await request(server, { path: "/api/machines" });
  const snapshot = await request(server, { path: "/api/snapshot" });
  const machine = machines.body.machines.find((item) => item.machineId === "server-05");
  const snapshotMachine = snapshot.body.snapshot.machines.find((item) => item.machineId === "server-05");

  assert.equal(heartbeat.status, 200);
  assert.equal(machine.agentSnapshot.configs[0].content, localConfigContent);
  assert.equal(snapshotMachine.agentSnapshot.configs[0].content, localConfigContent);
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

test("dashboard can add and validate an agent-only personal computer profile", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({
    machineId: "personal-pc",
    agentInstanceId: "agent-personal",
    displayName: "Personal PC",
  });
  const server = await withServer(t, {
    store,
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => "credential-personal",
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });

  const created = await request(server, {
    method: "POST",
    path: "/api/server-connections",
    body: {
      label: "Personal PC",
      machineId: "PERSONAL-PC",
      protocol: "agent",
    },
  });
  const validated = await request(server, {
    method: "POST",
    path: "/api/server-connections/credential-personal/validate",
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.connection.secretType, "server_rdp_credential");
  assert.equal(created.body.connection.targetMachineId, "personal-pc");
  assert.equal(created.body.connection.credential.machineId, "personal-pc");
  assert.equal(created.body.connection.credential.protocol, "agent");
  assert.equal(created.body.connection.credential.protocolUrl, "agent://personal-pc");
  assert.equal(created.body.connection.credential.username, "");
  assert.equal(created.body.connection.credential.hasPassword, false);
  assert.equal(validated.status, 200);
  assert.equal(validated.body.valid, true);
  assert.equal(validated.body.network.skipped, true);
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
  const pyongyangTileRanges = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: [
        "7/109/79/ - 7/109/80/",
        "8/218/158/ - 8/218/159/",
        "9/435/317/ - 9/435/317/",
        "10/870/633/ - 10/870/634/",
        "11/1739/1265/ - 11/1740/1267/",
        "12/3478/2530/ - 12/3480/2533/",
        "13/6955/5060/ - 13/6960/5065/",
        "14/13910/10120/ - 14/13920/10129/",
        "15/27819/20239/ - 15/27839/20257/",
        "16/55637/40477/ - 16/55678/40514/",
      ].join("\n"),
    },
  });
  const latLonPoint = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: "lat: 37.5665, lon: 126.9780",
    },
  });
  const missingZoom = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: "LB: 34.799, 46.82\nTR: 40.739, 52.272",
    },
  });
  const invalidLatitude = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: "lat: 91, lon: 126.9780",
    },
  });
  const invalidLongitude = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: JSON.stringify({ lat: 37.5665, lon: 181 }),
    },
  });
  const invertedBounds = await request(server, {
    method: "POST",
    path: "/api/ranges/parse",
    body: {
      input: "LB: 40, 50\nTR: 30, 60",
      zoomStart: 7,
      zoomEnd: 7,
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
  assert.equal(tileString.body.area, null);
  assert.equal(jsonRanges.status, 200);
  assert.equal(jsonRanges.body.tiles, 4);
  assert.equal(jsonRanges.body.area, null);
  assert.equal(pyongyangTileRanges.status, 200);
  assert.equal(pyongyangTileRanges.body.rangeCount, 10);
  assert.equal(pyongyangTileRanges.body.area, null);
  assert.equal(latLonPoint.status, 200);
  assert.equal(latLonPoint.body.rangeCount, 19);
  assert.deepEqual(latLonPoint.body.ranges.map((range) => range.zoomStart), Array.from({ length: 19 }, (_, index) => index + 1));
  assert.deepEqual(latLonPoint.body.ranges[18], {
    zoomStart: 19,
    zoomEnd: 19,
    xStart: 447069,
    xEnd: 447069,
    yStart: 203031,
    yEnd: 203031,
    label: "point z=19 lat=37.5665 lon=126.978",
  });
  assert.equal(latLonPoint.body.area.center.latitude, 37.5665);
  assert.equal(latLonPoint.body.area.center.longitude, 126.978);
  assert.equal(missingZoom.status, 400);
  assert.match(missingZoom.body.error, /zoom/);
  assert.equal(invalidLatitude.status, 400);
  assert.match(invalidLatitude.body.error, /latitude must be between/);
  assert.equal(invalidLongitude.status, 400);
  assert.match(invalidLongitude.body.error, /longitude must be between/);
  assert.equal(invertedBounds.status, 400);
  assert.match(invertedBounds.body.error, /TR longitude/);
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
    ["Ukraine Range 01-mapbox-pbf", "Ukraine Range 01-esri-satellite"]
  );
  assert.deepEqual(
    response.body.configs.map((config) => config.config.jobName),
    ["ukraine-range-01-mapbox-pbf", "ukraine-range-01-esri-satellite"]
  );
  assert.deepEqual(
    response.body.configs.map((config) => config.active),
    [true, true]
  );
  assert.deepEqual(
    response.body.configs.map((config) => config.config.ranges),
    [
      [{ zoomStart: 3, zoomEnd: 3, xStart: 1, xEnd: 1, yStart: 2, yEnd: 2, label: "range#1: z=3 x=1-1 y=2-2" }],
      [{ zoomStart: 3, zoomEnd: 3, xStart: 1, xEnd: 1, yStart: 2, yEnd: 2, label: "range#1: z=3 x=1-1 y=2-2" }],
    ]
  );
});

test("dashboard batch config preview returns editable drafts without creating configs", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json");
  await writeConfigTemplate(templatesDir, "mapbox-satellite.config.json", {
    layer: "satellite",
    format: "jpg",
  });
  let id = 0;
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
    idGenerator: () => `cfg-${++id}`,
  });
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    store,
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers: { authorization: "Bearer agent-token" },
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });

  const preview = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      preview: true,
      machineId: "worker-a",
      name: "Ukraine Range 01",
      active: true,
      templateIds: ["mapbox-pbf", "mapbox-satellite"],
      rangeInput: "19/312824/339498 - 19/321475/351754",
    },
  });
  const beforeConfirm = await request(server, { path: "/api/configs?machineId=worker-a" });

  assert.equal(preview.status, 200);
  assert.deepEqual(
    preview.body.drafts.map((draft) => draft.name),
    ["Ukraine Range 01-mapbox-pbf", "Ukraine Range 01-mapbox-satellite"]
  );
  assert.deepEqual(
    preview.body.drafts.map((draft) => draft.config.jobName),
    ["ukraine-range-01-mapbox-pbf", "ukraine-range-01-mapbox-satellite"]
  );
  assert.equal(preview.body.rangeSummary.tiles, 106047564);
  assert.equal(preview.body.rangeSummary.area, null);
  assert.equal(beforeConfirm.body.configs.length, 0);

  const editedDraft = structuredClone(preview.body.drafts[0]);
  editedDraft.name = "Edited Ukraine";
  editedDraft.config.jobName = "edited-ukraine";
  editedDraft.config.ranges[0].label = "edited range";
  const confirm = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: { drafts: [editedDraft] },
  });
  const afterConfirm = await request(server, { path: "/api/configs?machineId=worker-a" });

  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.configs.length, 1);
  assert.equal(confirm.body.configs[0].name, "Edited Ukraine");
  assert.equal(confirm.body.configs[0].config.jobName, "edited-ukraine");
  assert.equal(confirm.body.configs[0].config.ranges[0].label, "edited range");
  assert.equal(afterConfirm.body.configs.length, 1);
});

test("dashboard batch config preview infers a name from the selected area", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-satellite.config.json", {
    layer: "satellite",
    format: "jpg",
  });
  let resolvedCenter = null;
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    locationResolver: async ({ center }) => {
      resolvedCenter = center;
      return "Prince Edward Islands";
    },
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers: { authorization: "Bearer agent-token" },
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });

  const preview = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      preview: true,
      machineId: "worker-a",
      name: "",
      templateIds: ["mapbox-satellite"],
      rangeInput: "LB: 34.799, 46.82\nTR: 40.739, 52.272",
      zoomStart: 12,
      zoomEnd: 13,
    },
  });

  assert.equal(preview.status, 200);
  assert.deepEqual(resolvedCenter, { longitude: 37.749023, latitude: 49.560985 });
  assert.equal(preview.body.suggestedName, "Prince Edward Islands");
  assert.equal(preview.body.drafts[0].name, "Prince Edward Islands");
  assert.equal(preview.body.drafts[0].config.jobName, "prince-edward-islands-mapbox-satellite");
});

test("dashboard batch config preview auto-resolves unnamed Mapbox tile ranges through reverse geocoding", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-satellite.config.json", {
    layer: "satellite",
    format: "jpg",
  });
  const resolvedCenters = [];
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    locationResolver: async ({ center }) => {
      resolvedCenters.push(center);
      return "Pyongyang";
    },
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers: { authorization: "Bearer agent-token" },
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });

  const preview = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      preview: true,
      machineId: "worker-a",
      name: "",
      templateIds: ["mapbox-satellite"],
      rangeInput: [
        "14/13910/6254/ - 14/13920/6263/",
        "15/27819/12510/ - 15/27839/12528/",
        "16/55637/25021/ - 16/55678/25058/",
      ].join("\n"),
    },
  });

  assert.equal(preview.status, 200);
  assert.equal(resolvedCenters.length, 1);
  assert.ok(resolvedCenters[0].latitude > 0);
  assert.equal(preview.body.rangeSummary.area.label, "Pyongyang");
  assert.equal(preview.body.suggestedName, "Pyongyang");
  assert.equal(preview.body.drafts[0].name, "Pyongyang");
  assert.equal(preview.body.drafts[0].config.jobName, "pyongyang-mapbox-satellite");
  assert.deepEqual(preview.body.drafts[0].config.ranges, [
    { zoomStart: 14, zoomEnd: 14, xStart: 13910, xEnd: 13920, yStart: 6254, yEnd: 6263, label: "range#1: z=14 x=13910-13920 y=6254-6263" },
    { zoomStart: 15, zoomEnd: 15, xStart: 27819, xEnd: 27839, yStart: 12510, yEnd: 12528, label: "range#2: z=15 x=27819-27839 y=12510-12528" },
    { zoomStart: 16, zoomEnd: 16, xStart: 55637, xEnd: 55678, yStart: 25021, yEnd: 25058, label: "range#3: z=16 x=55637-55678 y=25021-25058" },
  ]);
});

test("dashboard batch config preview repairs inverted-y tile paste into Mapbox XYZ ranges", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-satellite.config.json", {
    layer: "satellite",
    format: "jpg",
  });
  const resolvedCenters = [];
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    locationResolver: async ({ center }) => {
      resolvedCenters.push(center);
      return center.latitude > 0 ? "Pyongyang" : "";
    },
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers: { authorization: "Bearer agent-token" },
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });

  const preview = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      preview: true,
      machineId: "worker-a",
      name: "",
      templateIds: ["mapbox-satellite"],
      rangeInput: [
        "14/13910/10120/ - 14/13920/10129/",
        "15/27819/20239/ - 15/27839/20257/",
        "16/55637/40477/ - 16/55678/40514/",
      ].join("\n"),
    },
  });

  assert.equal(preview.status, 200);
  assert.equal(resolvedCenters.length, 2);
  assert.ok(resolvedCenters[0].latitude < 0);
  assert.ok(resolvedCenters[1].latitude > 0);
  assert.equal(preview.body.suggestedName, "Pyongyang");
  assert.equal(preview.body.drafts[0].name, "Pyongyang");
  assert.deepEqual(preview.body.drafts[0].config.ranges, [
    { zoomStart: 14, zoomEnd: 14, xStart: 13910, xEnd: 13920, yStart: 6254, yEnd: 6263, label: "range#1: z=14 x=13910-13920 y=6254-6263" },
    { zoomStart: 15, zoomEnd: 15, xStart: 27819, xEnd: 27839, yStart: 12510, yEnd: 12528, label: "range#2: z=15 x=27819-27839 y=12510-12528" },
    { zoomStart: 16, zoomEnd: 16, xStart: 55637, xEnd: 55678, yStart: 25021, yEnd: 25058, label: "range#3: z=16 x=55637-55678 y=25021-25058" },
  ]);
});

test("dashboard batch config preview rejects unnamed Mapbox tile ranges when reverse geocoding fails", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  await writeConfigTemplate(templatesDir, "mapbox-satellite.config.json", {
    layer: "satellite",
    format: "jpg",
  });
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    locationResolver: async () => "",
  });
  await request(server, {
    method: "POST",
    path: "/api/agents/register",
    headers: { authorization: "Bearer agent-token" },
    body: { machineId: "worker-a", agentInstanceId: "agent-a", displayName: "Worker A" },
  });

  const preview = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      preview: true,
      machineId: "worker-a",
      name: "",
      templateIds: ["mapbox-satellite"],
      rangeInput: "7/109/79/ - 7/109/80/",
    },
  });

  assert.equal(preview.status, 400);
  assert.match(preview.body.error, /Could not resolve a location name/i);
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
        name: "Ukraine-Worker A",
        jobName: "ukraine-mapbox-pbf-worker-a",
        ranges: 1,
        active: true,
      },
      {
        machineId: "worker-b",
        name: "Ukraine-Worker B",
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
  assert.deepEqual(response.body.configs.map((config) => config.config.ranges), [
    [{ zoom: 4, xStart: 0, xEnd: 1, yStart: 0, yEnd: 9, label: "range#1: z=4 x=0-3 y=0-9 x=0-1" }],
    [{ zoom: 4, xStart: 2, xEnd: 3, yStart: 0, yEnd: 9, label: "range#1: z=4 x=0-3 y=0-9 x=2-3" }],
  ]);
});

test("dashboard batch config creation smart-splits matching config types across selected servers", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  const fullRange = { zoom: 4, xStart: 0, xEnd: 3, yStart: 0, yEnd: 9 };
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json", { ranges: [fullRange] });
  await writeConfigTemplate(templatesDir, "mapbox-satellite.config.json", { ranges: [fullRange] });
  await writeConfigTemplate(templatesDir, "esri-satellite.config.json", { ranges: [fullRange] });
  const normalizedFullRange = {
    zoomStart: 4,
    zoomEnd: 4,
    xStart: 0,
    xEnd: 3,
    yStart: 0,
    yEnd: 9,
    label: "range#1: z=4 x=0-3 y=0-9",
  };
  let id = 0;
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
      idGenerator: () => `cfg-${++id}`,
    }),
  });
  const headers = { authorization: "Bearer agent-token" };
  for (const worker of ["a", "b", "c"]) {
    await request(server, {
      method: "POST",
      path: "/api/agents/register",
      headers,
      body: { machineId: `worker-${worker}`, agentInstanceId: `agent-${worker}`, displayName: `Worker ${worker.toUpperCase()}` },
    });
  }

  const response = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      name: "Ukraine",
      active: true,
      splitAcrossMachines: true,
      machineIds: ["worker-a", "worker-b", "worker-c"],
      templateIds: ["mapbox-pbf", "mapbox-satellite", "esri-satellite"],
      rangeInput: JSON.stringify([fullRange]),
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.configs.map((config) => ({
      machineId: config.machineId,
      name: config.name,
      jobName: config.config.jobName,
      provider: config.config.provider,
      layer: config.config.layer,
      ranges: config.config.ranges,
    })),
    [
      {
        machineId: "worker-a",
        name: "Ukraine-mapbox-pbf-Worker A",
        jobName: "ukraine-mapbox-pbf-worker-a",
        provider: "mapbox",
        layer: "vector",
        ranges: [normalizedFullRange],
      },
      {
        machineId: "worker-b",
        name: "Ukraine-mapbox-satellite-Worker B",
        jobName: "ukraine-mapbox-satellite-worker-b",
        provider: "mapbox",
        layer: "satellite",
        ranges: [normalizedFullRange],
      },
      {
        machineId: "worker-c",
        name: "Ukraine-esri-satellite-Worker C",
        jobName: "ukraine-esri-satellite-worker-c",
        provider: "esri",
        layer: "satellite",
        ranges: [normalizedFullRange],
      },
    ]
  );
});

test("dashboard batch config creation can force range split for multiple config types", async (t) => {
  const templatesDir = await mkdtemp(path.join(os.tmpdir(), "mb-config-templates-"));
  const fullRange = { zoom: 4, xStart: 0, xEnd: 3, yStart: 0, yEnd: 9 };
  await writeConfigTemplate(templatesDir, "mapbox-pbf.config.json", { ranges: [fullRange] });
  await writeConfigTemplate(templatesDir, "mapbox-satellite.config.json", { ranges: [fullRange] });
  let id = 0;
  const server = await withServer(t, {
    configTemplatesDir: templatesDir,
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
      idGenerator: () => `cfg-${++id}`,
    }),
  });
  const headers = { authorization: "Bearer agent-token" };
  for (const worker of ["a", "b"]) {
    await request(server, {
      method: "POST",
      path: "/api/agents/register",
      headers,
      body: { machineId: `worker-${worker}`, agentInstanceId: `agent-${worker}`, displayName: `Worker ${worker.toUpperCase()}` },
    });
  }

  const response = await request(server, {
    method: "POST",
    path: "/api/configs/batch",
    body: {
      name: "Ukraine",
      active: true,
      splitAcrossMachines: true,
      splitStrategy: "ranges",
      machineIds: ["worker-a", "worker-b"],
      templateIds: ["mapbox-pbf", "mapbox-satellite"],
      rangeInput: JSON.stringify([fullRange]),
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.configs.map((config) => config.machineId), [
    "worker-a",
    "worker-b",
    "worker-a",
    "worker-b",
  ]);
  assert.deepEqual(
    response.body.configs.map((config) => config.config.ranges[0].xEnd - config.config.ranges[0].xStart + 1),
    [2, 2, 2, 2]
  );
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

test("dashboard settings expose existing telegram chat id without leaking bot token", async (t) => {
  const previousBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-def";
  process.env.TELEGRAM_CHAT_ID = "-100123";
  t.after(() => {
    if (previousBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousBotToken;
    if (previousChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChatId;
  });
  const server = await withServer(t);

  const settings = await request(server, { path: "/api/settings" });
  const snapshot = await request(server, { path: "/api/snapshot" });

  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body.settings.telegramEnv, {
    botTokenConfigured: true,
    chatId: "-100123",
  });
  assert.equal(settings.body.settings.telegramEnv.botToken, undefined);
  assert.deepEqual(snapshot.body.snapshot.settings.telegramEnv, {
    botTokenConfigured: true,
    chatId: "-100123",
  });
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
  store.updateSettings({
    rootEnvTemplate: {
      sourceMachineId: "global",
      updatedAt: "2026-06-16T00:00:00.000Z",
      envText: [
        "STORJ_ACCESS=storj-access",
        "STORJ_PASSPHRASE=storj passphrase",
        "STORJ_BUCKET=mapbox",
        "DASHBOARD_URL=https://dashboard.example",
        "AGENT_TOKEN=agent-token",
        "TILE_DOWNLOADER_PROXY_MODE=fallback",
        "TILE_DOWNLOADER_OUTPUT_MODE=dynamic",
        "TILE_DOWNLOADER_OUTPUT_FOLDER=mb-tile-downloader/tiles",
      ].join("\n"),
    },
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
  assert.deepEqual(downloadCommands.map((command) => command.commandType), ["write_env"]);
  assert.deepEqual(validateCommands.map((command) => command.commandType), ["write_env"]);
  assert.match(downloadCommands[0].payload.envText, /MACHINE_ID=download-worker/);
  assert.match(downloadCommands[0].payload.envText, /MAPBOX_ACCESS_TOKENS=pk\.download-worker/);
  assert.match(downloadCommands[0].payload.envText, /STORJ_ACCESS=storj-access/);
  assert.doesNotMatch(downloadCommands[0].payload.envText, /\*{3,}|\.{3,}/);
  assert.deepEqual(zipCommands, []);
  assert.deepEqual(uploadCommands, []);
  assert.equal(listed.body.secrets.find((secret) => secret.label === "zip-worker-token").status, "invalid");
});

test("dashboard machine env sync writes root env from DB template", async (t) => {
  let id = 0;
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.updateSettings({
    rootEnvTemplate: {
      sourceMachineId: "global",
      updatedAt: "2026-06-16T00:00:00.000Z",
      envText: [
        "STORJ_ACCESS=storj-access",
        "STORJ_PASSPHRASE=storj passphrase",
        "STORJ_BUCKET=mapbox",
        "DASHBOARD_URL=https://dashboard.example",
        "AGENT_TOKEN=agent-token",
        "TILE_DOWNLOADER_PROXY_MODE=fallback",
        "TILE_DOWNLOADER_OUTPUT_MODE=dynamic",
        "TILE_DOWNLOADER_OUTPUT_FOLDER=mb-tile-downloader/tiles",
      ].join("\n"),
    },
  });
  await store.registerMachine({
    machineId: "server-05",
    agentInstanceId: "agent-05",
    agentSnapshot: {
      envFiles: [{
        path: ".env",
        exists: true,
        content: "MACHINE_ID=server-05\nSTORJ_ACCESS=********\nDASHBOARD_URL=http....xyz\n",
      }],
    },
  });
  const secretVault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  secretVault.createSecret({
    machineId: "server-05",
    secretType: "mapbox_token",
    label: "server-05-token",
    value: "pk.server05",
    status: "active",
  });
  const server = await withServer(t, { store, secretVault });

  const response = await request(server, {
    method: "POST",
    path: "/api/machines/server-05/commands",
    body: {
      commandType: "sync_env",
      requestedBy: "dashboard",
    },
  });
  const commands = store.claimCommands({ machineId: "server-05" });

  assert.equal(response.status, 200);
  assert.equal(response.body.command.commandType, "write_env");
  assert.deepEqual(commands.map((command) => command.commandType), ["write_env"]);
  assert.match(commands[0].payload.envText, /MACHINE_ID=server-05/);
  assert.match(commands[0].payload.envText, /STORJ_ACCESS=storj-access/);
  assert.match(commands[0].payload.envText, /DASHBOARD_URL=https:\/\/dashboard\.example/);
  assert.match(commands[0].payload.envText, /MAPBOX_ACCESS_TOKENS=pk\.server05/);
  assert.doesNotMatch(commands[0].payload.envText, /\*{3,}|\.{3,}/);
});

test("dashboard telegram env route uses DB global env template, not masked snapshots", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.updateSettings({
    rootEnvTemplate: {
      sourceMachineId: "global",
      updatedAt: "2026-06-16T00:00:00.000Z",
      envText: [
        "STORJ_ACCESS=storj-access",
        "STORJ_PASSPHRASE=storj passphrase",
        "STORJ_BUCKET=mapbox",
        "DASHBOARD_URL=https://dashboard.example",
        "AGENT_TOKEN=agent-token",
        "TILE_DOWNLOADER_PROXY_MODE=fallback",
        "TILE_DOWNLOADER_OUTPUT_MODE=dynamic",
        "TILE_DOWNLOADER_OUTPUT_FOLDER=mb-tile-downloader/tiles",
      ].join("\n"),
    },
  });
  store.registerMachine({
    machineId: "server-04",
    agentInstanceId: "agent-04",
    agentSnapshot: {
      envFiles: [{
        path: ".env",
        exists: true,
        content: "MACHINE_ID=server-04\nSTORJ_ACCESS=local-should-not-be-used\nDASHBOARD_URL=https://wrong.example\n",
      }],
    },
  });
  store.registerMachine({
    machineId: "server-05",
    agentInstanceId: "agent-05",
    agentSnapshot: {
      envFiles: [{
        path: ".env",
        exists: true,
        content: "MACHINE_ID=server-05\nSTORJ_ACCESS=********\nDASHBOARD_URL=http.....xyz\n",
      }],
    },
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
  const server04Commands = store.claimCommands({ machineId: "server-04" });
  const server05Commands = store.claimCommands({ machineId: "server-05" });

  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.queued.map((item) => item.machineId), ["server-04", "server-05"]);
  assert.deepEqual(updated.body.skipped, []);
  assert.match(store.getSettings().rootEnvTemplate.envText, /TELEGRAM_BOT_TOKEN=123456:ABC-def/);
  assert.match(store.getSettings().rootEnvTemplate.envText, /TELEGRAM_CHAT_ID=-100123/);
  assert.equal(server04Commands[0].commandType, "write_env");
  assert.match(server04Commands[0].payload.envText, /MACHINE_ID=server-04/);
  assert.match(server04Commands[0].payload.envText, /DASHBOARD_URL=https:\/\/dashboard\.example/);
  assert.match(server04Commands[0].payload.envText, /TELEGRAM_BOT_TOKEN=123456:ABC-def/);
  assert.match(server04Commands[0].payload.envText, /TELEGRAM_CHAT_ID=-100123/);
  assert.doesNotMatch(server04Commands[0].payload.envText, /\*{3,}|\.{3,}/);
  assert.equal(server05Commands[0].commandType, "write_env");
  assert.match(server05Commands[0].payload.envText, /MACHINE_ID=server-05/);
  assert.match(server05Commands[0].payload.envText, /STORJ_ACCESS=storj-access/);
  assert.doesNotMatch(server05Commands[0].payload.envText, /\*{3,}|\.{3,}/);
});

test("dashboard global env route stores DB template and queues per-machine root env writes", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({ machineId: "server-01", agentInstanceId: "agent-01" });
  await store.registerMachine({ machineId: "server-02", agentInstanceId: "agent-02" });
  const server = await withServer(t, { store });

  const updated = await request(server, {
    method: "POST",
    path: "/api/env/global",
    body: {
      envText: [
        "STORJ_ACCESS=storj-access",
        "STORJ_PASSPHRASE=storj passphrase",
        "STORJ_BUCKET=mapbox",
        "DASHBOARD_URL=https://dashboard.example",
        "AGENT_TOKEN=agent-token",
        "TILE_DOWNLOADER_PROXY_MODE=fallback",
        "TILE_DOWNLOADER_OUTPUT_MODE=dynamic",
        "TILE_DOWNLOADER_OUTPUT_FOLDER=mb-tile-downloader/tiles",
      ].join("\n"),
    },
  });

  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.queued.map((item) => item.machineId), ["server-01", "server-02"]);
  const server01Commands = store.claimCommands({ machineId: "server-01" });
  const server02Commands = store.claimCommands({ machineId: "server-02" });
  assert.match(server01Commands[0].payload.envText, /MACHINE_ID=server-01/);
  assert.match(server02Commands[0].payload.envText, /MACHINE_ID=server-02/);
  assert.match(server02Commands[0].payload.envText, /STORJ_ACCESS=storj-access/);
  assert.equal(store.getSettings().rootEnvTemplate.sourceMachineId, "global");
});

test("dashboard command route refuses masked root env writes", async (t) => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  await store.registerMachine({ machineId: "server-01", agentInstanceId: "agent-01" });
  const server = await withServer(t, { store });

  const response = await request(server, {
    method: "POST",
    path: "/api/machines/server-01/commands",
    body: {
      commandType: "write_env",
      payload: {
        envText: [
          "MACHINE_ID=server-01",
          "STORJ_ACCESS=********",
          "DASHBOARD_URL=http....xyz",
        ].join("\n"),
      },
    },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /masked \.env values/);
  assert.deepEqual(store.claimCommands({ machineId: "server-01" }), []);
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

test("dashboard bulk-validates resource pool secrets and returns invalid ids", async (t) => {
  let id = 0;
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  vault.createSecret({
    secretType: "mapbox_token",
    label: "mapbox",
    value: "valid-mapbox-token",
  });
  vault.createSecret({
    secretType: "mapbox_token",
    label: "mapbox",
    value: "expired-mapbox-token",
  });
  vault.createSecret({
    secretType: "proxy_txt",
    label: "proxy",
    value: "http://valid-proxy.example:8080",
  });
  const server = await withServer(t, {
    secretVault: vault,
    secretValidator: {
      async validateSecret({ value }) {
        const ok = !String(value).includes("expired");
        return { ok, status: ok ? "active" : "invalid", message: ok ? "valid" : "expired" };
      },
    },
  });

  const validated = await request(server, {
    method: "POST",
    path: "/api/secrets/validate",
    body: { secretTypes: ["mapbox_token"] },
  });
  const listed = await request(server, { path: "/api/secrets" });

  assert.equal(validated.status, 200);
  assert.equal(validated.body.validation.checked, 2);
  assert.equal(validated.body.validation.invalid, 1);
  assert.deepEqual(validated.body.validation.invalidSecretIds, ["secret-2"]);
  assert.equal(listed.body.secrets.find((secret) => secret.secretId === "secret-1").status, "active");
  assert.equal(listed.body.secrets.find((secret) => secret.secretId === "secret-2").status, "invalid");
  assert.equal(listed.body.secrets.find((secret) => secret.secretId === "secret-3").status, "active");
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

test("dashboard secret edit route returns exact resource value for admin editing", async (t) => {
  const server = await withServer(t, {
    secretVault: createSecretVault({
      appSecret: "test-secret",
      idGenerator: () => "mapbox-a",
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
  });

  await request(server, {
    method: "POST",
    path: "/api/secrets",
    body: {
      secretType: "mapbox_token",
      label: "Mapbox",
      value: "pk.exact-token-value",
    },
  });
  const single = await request(server, { path: "/api/secrets/mapbox-a" });
  const listed = await request(server, { path: "/api/secrets" });

  assert.equal(single.status, 200);
  assert.equal(single.body.secret.secretType, "mapbox_token");
  assert.equal(single.body.secret.value, "pk.exact-token-value");
  assert.equal(listed.body.secrets[0].value, "pk.exact-token-value");
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
