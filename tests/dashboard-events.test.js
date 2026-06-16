import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createDashboardApp } from "../dashboard/src/server/app.js";
import { createSecretVault } from "../dashboard/src/server/secrets.js";
import { createDashboardStore } from "../dashboard/src/server/store.js";

async function request(server, { method = "GET", path = "/", headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("records dashboard events with validated severity", () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
    idGenerator: () => "evt-1",
  });

  const event = store.recordEvent({
    machineId: "worker-a",
    jobId: "job-a",
    severity: "warn",
    type: "range.failed",
    message: "range failed",
    data: { rangeIndex: 0 },
  });

  assert.equal(event.id, "evt-1");
  assert.equal(event.createdAt, "2026-06-16T00:00:00.000Z");
  assert.deepEqual(store.listEvents({ machineId: "worker-a" }), [event]);
  assert.throws(
    () =>
      store.recordEvent({
        machineId: "worker-a",
        severity: "nope",
        type: "bad",
        message: "bad",
      }),
    /invalid event severity/
  );
});

test("agent can post events and dashboard can list them", async (t) => {
  const server = createDashboardApp({
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
      idGenerator: () => "evt-1",
    }),
    agentToken: "agent-token",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const posted = await request(server, {
    method: "POST",
    path: "/api/agents/events",
    headers: { authorization: "Bearer agent-token" },
    body: {
      machineId: "worker-a",
      severity: "info",
      type: "pipeline.started",
      message: "started",
      data: { configId: "cfg-a" },
    },
  });
  const listed = await request(server, {
    path: "/api/events?machineId=worker-a",
    headers: { authorization: "Bearer admin-token" },
  });

  assert.equal(posted.status, 200);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.events[0].type, "pipeline.started");
});

test("proxy blocked events mark assigned dashboard proxy secrets unavailable", async (t) => {
  const secretVault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => "proxy-a",
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  secretVault.createSecret({
    machineId: "worker-a",
    secretType: "proxy_txt",
    label: "proxy-a",
    value: "proxy-a.example:8080",
  });
  const server = createDashboardApp({
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
      idGenerator: () => "evt-1",
    }),
    agentToken: "agent-token",
    secretVault,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const proxyHash = createHash("sha256").update("http://proxy-a.example:8080").digest("hex");
  const posted = await request(server, {
    method: "POST",
    path: "/api/agents/events",
    headers: { authorization: "Bearer agent-token" },
    body: {
      machineId: "worker-a",
      severity: "warn",
      type: "proxy.blocked",
      message: "esri proxy blocked by provider",
      data: { proxyHash, providerStatus: 403 },
    },
  });
  const browser = await request(server, {
    path: "/api/secrets?machineId=worker-a",
  });
  const agent = await request(server, {
    path: "/api/agents/secrets?machineId=worker-a",
    headers: { authorization: "Bearer agent-token" },
  });

  assert.equal(posted.status, 200);
  assert.equal(posted.body.secret.status, "error");
  assert.equal(browser.body.secrets[0].status, "error");
  assert.equal(browser.body.secrets[0].usage, "disabled");
  assert.deepEqual(agent.body.secrets, []);
});
