import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardStore } from "../dashboard/src/server/store.js";

test("registers a new machine and creates an active lease", () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });

  const result = store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A",
    platform: "win32",
    version: "1.0.0",
  });

  assert.equal(result.status, "registered");
  assert.equal(result.machine.machineId, "worker-a");
  assert.equal(result.machine.agentInstanceId, "agent-1");
  assert.equal(result.machine.status, "online");
  assert.equal(result.machine.leaseExpiresAt, "2026-06-16T00:02:00.000Z");
});

test("renews an active lease for the same machine and agent instance", () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const store = createDashboardStore({ now: () => now });

  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A",
  });

  now = new Date("2026-06-16T00:01:00.000Z");
  const result = store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A Updated",
  });

  assert.equal(result.status, "renewed");
  assert.equal(result.machine.displayName, "Worker A Updated");
  assert.equal(result.machine.leaseExpiresAt, "2026-06-16T00:03:00.000Z");
});

test("rejects a conflicting live machine id from a different agent instance", () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:30.000Z"),
  });
  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A",
  });

  assert.throws(
    () =>
      store.registerMachine({
        machineId: "worker-a",
        agentInstanceId: "agent-2",
        displayName: "Worker A Clone",
      }),
    /already registered by another live agent/
  );
});

test("allows takeover when the prior lease expired", () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const store = createDashboardStore({ now: () => now });

  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A",
  });

  now = new Date("2026-06-16T00:03:01.000Z");
  const result = store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-2",
    displayName: "Worker A Replacement",
  });

  assert.equal(result.status, "takeover");
  assert.equal(result.machine.agentInstanceId, "agent-2");
  assert.equal(result.machine.displayName, "Worker A Replacement");
});

test("lists machines as offline after heartbeat lease expires", () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const store = createDashboardStore({ now: () => now });

  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
  });

  now = new Date("2026-06-16T00:03:00.000Z");

  assert.equal(store.listMachines()[0].status, "offline");
  assert.equal(store.getMachine("worker-a").status, "offline");
});
