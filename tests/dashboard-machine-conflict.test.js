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

test("clears cached downloader console lines without deleting machine events", () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    agentSnapshot: {
      console: {
        recentLines: ["row 1", "row 2"],
      },
    },
  });
  store.recordEvent({
    machineId: "worker-a",
    severity: "info",
    type: "command.accepted",
    message: "Sync config completed.",
  });

  const cleared = store.clearMachineConsole("worker-a");

  assert.deepEqual(cleared.agentSnapshot.console.recentLines, []);
  assert.equal(cleared.agentSnapshot.console.clearedAt, "2026-06-16T00:00:00.000Z");
  assert.equal(store.listEvents({ machineId: "worker-a" }).length, 1);
});

test("deletes a machine and its machine-owned dashboard state", () => {
  const store = createDashboardStore({
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });

  store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
  });
  store.createConfig({
    machineId: "worker-a",
    name: "worker config",
    active: true,
    config: { provider: "esri", layer: "satellite", ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }] },
  });
  store.createEnvProfile({
    machineId: "worker-a",
    name: "worker env",
    active: true,
    env: { TILE_DOWNLOADER_MAX_CONCURRENCY: 64 },
  });
  store.recordEvent({
    machineId: "worker-a",
    severity: "info",
    type: "range.started",
    message: "started",
  });
  store.queueCommand({
    machineId: "worker-a",
    commandType: "run_preflight",
    requestedBy: "dashboard",
  });

  const deleted = store.deleteMachine("worker-a");

  assert.equal(deleted.machineId, "worker-a");
  assert.deepEqual(store.listMachines(), []);
  assert.deepEqual(store.listConfigs({ machineId: "worker-a" }), []);
  assert.deepEqual(store.listEnvProfiles({ machineId: "worker-a" }), []);
  assert.deepEqual(store.listEvents({ machineId: "worker-a" }), []);
  assert.deepEqual(store.claimCommands({ machineId: "worker-a" }), []);
});

test("requeues claimed commands after command lease expiry", () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const store = createDashboardStore({
    now: () => now,
    commandLeaseMs: 60_000,
  });

  store.queueCommand({
    machineId: "worker-a",
    commandType: "run_preflight",
    requestedBy: "dashboard",
  });

  const firstClaim = store.claimCommands({ machineId: "worker-a" });
  const activeLeaseClaim = store.claimCommands({ machineId: "worker-a" });

  now = new Date("2026-06-16T00:01:01.000Z");
  const expiredLeaseClaim = store.claimCommands({ machineId: "worker-a" });

  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].status, "claimed");
  assert.equal(firstClaim[0].claimedExpiresAt, "2026-06-16T00:01:00.000Z");
  assert.deepEqual(activeLeaseClaim, []);
  assert.equal(expiredLeaseClaim.length, 1);
  assert.equal(expiredLeaseClaim[0].id, firstClaim[0].id);
  assert.equal(expiredLeaseClaim[0].claimedAt, "2026-06-16T00:01:01.000Z");
  assert.equal(expiredLeaseClaim[0].claimedExpiresAt, "2026-06-16T00:02:01.000Z");
});

test("rejects stale command acknowledgement after lease is reclaimed", () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const store = createDashboardStore({
    now: () => now,
    commandLeaseMs: 60_000,
  });

  const queued = store.queueCommand({
    machineId: "worker-a",
    commandType: "run_preflight",
  });
  const [firstClaim] = store.claimCommands({ machineId: "worker-a" });

  now = new Date("2026-06-16T00:01:01.000Z");
  const [secondClaim] = store.claimCommands({ machineId: "worker-a" });

  assert.notEqual(secondClaim.claimedAt, firstClaim.claimedAt);
  assert.throws(
    () => store.completeCommand({ commandId: queued.id, claimedAt: firstClaim.claimedAt }),
    /claim expired/
  );

  const completed = store.completeCommand({
    commandId: queued.id,
    claimedAt: secondClaim.claimedAt,
  });

  assert.equal(completed.status, "completed");
});

test("does not replay expired stop commands", () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const store = createDashboardStore({
    now: () => now,
    commandLeaseMs: 60_000,
  });

  const queuedStop = store.queueCommand({
    machineId: "worker-a",
    commandType: "stop_pipeline",
  });

  now = new Date("2026-06-16T00:01:01.000Z");
  assert.deepEqual(store.claimCommands({ machineId: "worker-a" }), []);

  assert.throws(
    () => store.completeCommand({ commandId: queuedStop.id }),
    /not currently claimed/
  );
});

test("does not reclaim expired claimed stop commands", () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const store = createDashboardStore({
    now: () => now,
    commandLeaseMs: 60_000,
  });

  const queuedStop = store.queueCommand({
    machineId: "worker-a",
    commandType: "stop_pipeline",
  });
  const [firstClaim] = store.claimCommands({ machineId: "worker-a" });

  now = new Date("2026-06-16T00:01:01.000Z");
  assert.deepEqual(store.claimCommands({ machineId: "worker-a" }), []);

  assert.throws(
    () => store.completeCommand({ commandId: queuedStop.id, claimedAt: firstClaim.claimedAt }),
    /not currently claimed/
  );
});
