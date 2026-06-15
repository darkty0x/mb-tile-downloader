import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardApp } from "../dashboard/src/server/app.js";
import { createDashboardStore } from "../dashboard/src/server/store.js";
import { createControlClient } from "../src/agent/control-client.js";

async function withServer(t) {
  const server = createDashboardApp({
    store: createDashboardStore({
      now: () => new Date("2026-06-16T00:00:00.000Z"),
    }),
    agentToken: "agent-token",
    adminToken: "admin-token",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("control client registers and heartbeats with bearer auth", async (t) => {
  const baseUrl = await withServer(t);
  const client = createControlClient({ baseUrl, agentToken: "agent-token" });

  const registered = await client.register({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A",
  });
  const heartbeat = await client.heartbeat({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    disk: [{ name: "C:", freeBytes: 100 }],
  });

  assert.equal(registered.status, "registered");
  assert.equal(heartbeat.machine.disk[0].name, "C:");
});

test("control client raises a conflict error when machine id is live elsewhere", async (t) => {
  const baseUrl = await withServer(t);
  const first = createControlClient({ baseUrl, agentToken: "agent-token" });
  const second = createControlClient({ baseUrl, agentToken: "agent-token" });

  await first.register({ machineId: "worker-a", agentInstanceId: "agent-1" });

  await assert.rejects(
    () => second.register({ machineId: "worker-a", agentInstanceId: "agent-2" }),
    (err) => err.status === 409 && /already registered/.test(err.message)
  );
});
