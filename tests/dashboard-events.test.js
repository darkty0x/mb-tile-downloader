import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardApp } from "../dashboard/src/server/app.js";
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
