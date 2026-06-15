import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDashboardApp } from "../dashboard/src/server/app.js";
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
    adminToken: "admin-token",
    ...options,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  return app;
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
    },
  });

  assert.equal(registered.status, 200);
  assert.equal(registered.body.status, "registered");
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.machine.disk[0].name, "C:");
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

test("dashboard machine list requires admin token", async (t) => {
  const server = await withServer(t);

  const unauthorized = await request(server, { path: "/api/machines" });
  const authorized = await request(server, {
    path: "/api/machines",
    headers: { authorization: "Bearer admin-token" },
  });

  assert.equal(unauthorized.status, 401);
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body.machines, []);
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
