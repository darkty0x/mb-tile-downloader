import test from "node:test";
import assert from "node:assert/strict";

import { createPostgresDashboardStore } from "../dashboard/src/server/postgres-store.js";

function createFakePgDb() {
  const tables = {
    machines: new Map(),
    machine_events: [],
    machine_commands: new Map(),
    configs: new Map(),
    env_profiles: new Map(),
    dashboard_settings: new Map(),
  };
  let serial = 0;

  function rows(values) {
    return { rows: values, rowCount: values.length };
  }

  return {
    tables,
    async query(sql, params = []) {
      if (/SELECT \* FROM machines WHERE machine_id=\$1/.test(sql)) {
        const row = tables.machines.get(params[0]);
        return rows(row ? [{ ...row }] : []);
      }
      if (/SELECT value_json FROM dashboard_settings WHERE key=\$1/.test(sql)) {
        const row = tables.dashboard_settings.get(params[0]);
        return rows(row ? [{ ...row }] : []);
      }
      if (/INSERT INTO dashboard_settings/.test(sql)) {
        const [key, value_json, updated_at] = params;
        const row = { key, value_json, updated_at };
        tables.dashboard_settings.set(key, row);
        return rows([{ value_json }]);
      }
      if (/INSERT INTO machines/.test(sql)) {
        const [
          machine_id,
          agent_instance_id,
          display_name,
          status,
          platform,
          version,
          last_seen_at,
          lease_expires_at,
          disk_json,
          agent_snapshot_json,
          current_job_id,
          created_at,
          updated_at,
        ] = params;
        const existing = tables.machines.get(machine_id);
        const row = {
          machine_id,
          agent_instance_id,
          display_name,
          status,
          platform,
          version,
          last_seen_at,
          lease_expires_at,
          disk_json,
          agent_snapshot_json,
          current_job_id,
          created_at: existing?.created_at || created_at,
          updated_at,
        };
        tables.machines.set(machine_id, row);
        return rows([{ ...row }]);
      }
      if (/SELECT \* FROM machines ORDER BY machine_id/.test(sql)) {
        return rows([...tables.machines.values()].sort((a, b) => a.machine_id.localeCompare(b.machine_id)));
      }
      if (/INSERT INTO machine_events/.test(sql)) {
        const [machine_id, job_id, severity, type, message, data_json, created_at] = params;
        const row = {
          id: ++serial,
          machine_id,
          job_id,
          severity,
          type,
          message,
          data_json,
          created_at,
        };
        tables.machine_events.push(row);
        return rows([{ ...row }]);
      }
      if (/SELECT \* FROM machine_events/.test(sql)) {
        const machineId = params[0];
        const limit = params[1] || params[0];
        const source = machineId && typeof machineId === "string"
          ? tables.machine_events.filter((row) => row.machine_id === machineId)
          : tables.machine_events;
        return rows(source.slice(-limit));
      }
      if (/INSERT INTO machine_commands/.test(sql)) {
        const [machine_id, command_type, payload_json, requested_by, requested_at] = params;
        const row = {
          id: ++serial,
          machine_id,
          command_type,
          payload_json,
          status: "queued",
          requested_by,
          requested_at,
          claimed_at: null,
          completed_at: null,
          error: null,
        };
        tables.machine_commands.set(String(row.id), row);
        return rows([{ ...row }]);
      }
      if (/SELECT \* FROM machine_commands/.test(sql)) {
        const [machineId, limit] = params;
        return rows(
          [...tables.machine_commands.values()]
            .filter((row) => row.machine_id === machineId && row.status === "queued")
            .slice(0, limit)
        );
      }
      if (/UPDATE machine_commands\s+SET status='queued'/.test(sql)) {
        const [machineId, expiredBefore] = params;
        for (const row of tables.machine_commands.values()) {
          if (
            row.machine_id === machineId
            && row.status === "claimed"
            && new Date(row.claimed_at).getTime() <= new Date(expiredBefore).getTime()
            && row.completed_at === null
          ) {
            row.status = "queued";
            row.claimed_at = null;
          }
        }
        return rows([]);
      }
      if (/UPDATE machine_commands SET status='claimed'/.test(sql)) {
        const [claimed_at, id] = params;
        const row = tables.machine_commands.get(String(id));
        if (!row || row.status !== "queued") return rows([]);
        row.status = "claimed";
        row.claimed_at = claimed_at;
        return rows([{ ...row }]);
      }
      if (/UPDATE machine_commands SET status=\$1.*claimed_at=\$5/s.test(sql)) {
        const [status, completed_at, error, id, claimed_at] = params;
        const row = tables.machine_commands.get(String(id));
        if (!row || row.claimed_at !== claimed_at) return rows([]);
        row.status = status;
        row.completed_at = completed_at;
        row.error = error;
        return rows([{ ...row }]);
      }
      if (/UPDATE machine_commands SET status=\$1/.test(sql)) {
        const [status, completed_at, error, id] = params;
        const row = tables.machine_commands.get(String(id));
        row.status = status;
        row.completed_at = completed_at;
        row.error = error;
        return rows(row ? [{ ...row }] : []);
      }
      if (/UPDATE configs SET active=false/.test(sql)) {
        const [machine_id] = params;
        for (const row of tables.configs.values()) {
          if (row.machine_id === machine_id) row.active = false;
        }
        return rows([]);
      }
      if (/INSERT INTO configs/.test(sql)) {
        const [config_id, machine_id, name, version, config_json, active, created_at, updated_at] = params;
        const row = { config_id, machine_id, name, version, config_json, active, created_at, updated_at };
        tables.configs.set(config_id, row);
        return rows([{ ...row }]);
      }
      if (/SELECT \* FROM configs WHERE config_id=\$1/.test(sql)) {
        const row = tables.configs.get(params[0]);
        return rows(row ? [{ ...row }] : []);
      }
      if (/SELECT \* FROM configs/.test(sql)) {
        const machineId = params[0];
        const source = machineId === undefined
          ? [...tables.configs.values()]
          : [...tables.configs.values()].filter((row) => row.machine_id === machineId);
        return rows(source.sort((a, b) => a.version - b.version || a.name.localeCompare(b.name)));
      }
      if (/UPDATE env_profiles SET active=false/.test(sql)) {
        const [machine_id] = params;
        for (const row of tables.env_profiles.values()) {
          if (row.machine_id === machine_id) row.active = false;
        }
        return rows([]);
      }
      if (/INSERT INTO env_profiles/.test(sql)) {
        const [env_profile_id, machine_id, name, version, env_json, active, created_at, updated_at] = params;
        const row = { env_profile_id, machine_id, name, version, env_json, active, created_at, updated_at };
        tables.env_profiles.set(env_profile_id, row);
        return rows([{ ...row }]);
      }
      if (/SELECT \* FROM env_profiles WHERE env_profile_id=\$1/.test(sql)) {
        const row = tables.env_profiles.get(params[0]);
        return rows(row ? [{ ...row }] : []);
      }
      if (/SELECT \* FROM env_profiles/.test(sql)) {
        const machineId = params[0];
        const source = machineId === undefined
          ? [...tables.env_profiles.values()]
          : [...tables.env_profiles.values()].filter((row) => row.machine_id === machineId);
        return rows(source.sort((a, b) => a.version - b.version || a.name.localeCompare(b.name)));
      }

      throw new Error(`unhandled SQL: ${sql}`);
    },
  };
}

test("postgres store persists machine registration, heartbeat, and conflicts", async () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const db = createFakePgDb();
  const store = createPostgresDashboardStore({ db, now: () => now });

  const registered = await store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    displayName: "Worker A",
  });
  const heartbeat = await store.heartbeatMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
    platform: "Microsoft Windows Server 2019 Standard",
    disk: [{ name: "C:", freeBytes: 100 }],
    agentSnapshot: { managed: { configPath: ".tile-state/dashboard/configs/a.json" } },
  });

  assert.equal(registered.status, "registered");
  assert.equal(heartbeat.platform, "Microsoft Windows Server 2019 Standard");
  assert.equal(heartbeat.disk[0].name, "C:");
  assert.equal(heartbeat.agentSnapshot.managed.configPath, ".tile-state/dashboard/configs/a.json");
  assert.equal((await store.listMachines())[0].machineId, "worker-a");

  await assert.rejects(
    () => store.registerMachine({ machineId: "worker-a", agentInstanceId: "agent-2" }),
    /already registered by another live agent/
  );

  now = new Date("2026-06-16T00:03:00.000Z");
  const takeover = await store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-2",
  });
  assert.equal(takeover.status, "takeover");
});

test("postgres store persists dashboard alert settings", async () => {
  const db = createFakePgDb();
  const store = createPostgresDashboardStore({
    db,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });

  assert.deepEqual((await store.getSettings()).alertThresholds, {
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50,
  });
  assert.equal((await store.getSettings()).sync.dashboardPollMs, 5000);

  await store.updateSettings({
    alertThresholds: {
      mapboxTokensPerServer: 5,
      proxiesPerServer: 80,
    },
    sync: {
      dashboardPollMs: 3000,
    },
  });

  assert.deepEqual((await store.getSettings()).alertThresholds, {
    mapboxTokensPerServer: 5,
    proxiesPerServer: 80,
  });
  assert.equal((await store.getSettings()).sync.dashboardPollMs, 3000);
});

test("postgres store lists expired machines as offline", async () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const db = createFakePgDb();
  const store = createPostgresDashboardStore({ db, now: () => now });

  await store.registerMachine({
    machineId: "worker-a",
    agentInstanceId: "agent-1",
  });

  now = new Date("2026-06-16T00:03:00.000Z");

  assert.equal((await store.listMachines())[0].status, "offline");
  assert.equal((await store.getMachine("worker-a")).status, "offline");
});

test("postgres store persists events and command lifecycle", async () => {
  const db = createFakePgDb();
  const store = createPostgresDashboardStore({
    db,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });

  const event = await store.recordEvent({
    machineId: "worker-a",
    severity: "success",
    type: "pipeline.completed",
    message: "done",
  });
  const queued = await store.queueCommand({
    machineId: "worker-a",
    commandType: "run_preflight",
    payload: { configPath: "configs/a.json" },
  });
  const claimed = await store.claimCommands({ machineId: "worker-a" });
  const completed = await store.completeCommand({ commandId: queued.id });

  assert.equal(event.type, "pipeline.completed");
  assert.equal((await store.listEvents({ machineId: "worker-a" }))[0].id, event.id);
  assert.equal(claimed[0].status, "claimed");
  assert.equal(completed.status, "completed");
});

test("postgres store requeues claimed commands after command lease expiry", async () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const db = createFakePgDb();
  const store = createPostgresDashboardStore({
    db,
    now: () => now,
    commandLeaseMs: 60_000,
  });

  const queued = await store.queueCommand({
    machineId: "worker-a",
    commandType: "run_preflight",
  });
  const firstClaim = await store.claimCommands({ machineId: "worker-a" });
  const activeLeaseClaim = await store.claimCommands({ machineId: "worker-a" });

  now = new Date("2026-06-16T00:01:01.000Z");
  const expiredLeaseClaim = await store.claimCommands({ machineId: "worker-a" });

  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].id, queued.id);
  assert.equal(firstClaim[0].claimedExpiresAt, "2026-06-16T00:01:00.000Z");
  assert.deepEqual(activeLeaseClaim, []);
  assert.equal(expiredLeaseClaim.length, 1);
  assert.equal(expiredLeaseClaim[0].id, queued.id);
  assert.equal(expiredLeaseClaim[0].claimedAt, "2026-06-16T00:01:01.000Z");
  assert.equal(expiredLeaseClaim[0].claimedExpiresAt, "2026-06-16T00:02:01.000Z");
});

test("postgres store rejects stale command acknowledgement after lease is reclaimed", async () => {
  let now = new Date("2026-06-16T00:00:00.000Z");
  const db = createFakePgDb();
  const store = createPostgresDashboardStore({
    db,
    now: () => now,
    commandLeaseMs: 60_000,
  });

  const queued = await store.queueCommand({
    machineId: "worker-a",
    commandType: "run_preflight",
  });
  const [firstClaim] = await store.claimCommands({ machineId: "worker-a" });

  now = new Date("2026-06-16T00:01:01.000Z");
  const [secondClaim] = await store.claimCommands({ machineId: "worker-a" });

  assert.notEqual(secondClaim.claimedAt, firstClaim.claimedAt);
  await assert.rejects(
    () => store.completeCommand({ commandId: queued.id, claimedAt: firstClaim.claimedAt }),
    /claim expired/
  );

  const completed = await store.completeCommand({
    commandId: queued.id,
    claimedAt: secondClaim.claimedAt,
  });

  assert.equal(completed.status, "completed");
});

test("postgres store persists config and env profile versions", async () => {
  const db = createFakePgDb();
  let ids = 0;
  const store = createPostgresDashboardStore({
    db,
    idGenerator: () => `id-${++ids}`,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });

  const config = await store.createConfig({
    machineId: "worker-a",
    name: "ukraine",
    active: true,
    config: {
      provider: "esri",
      ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    },
  });
  const configV2 = await store.updateConfig(config.configId, {
    active: true,
    config: {
      provider: "esri",
      jobName: "ukraine-v2",
      ranges: [{ zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
    },
  });
  const env = await store.createEnvProfile({
    machineId: "worker-a",
    name: "default",
    active: true,
    env: { TILE_DOWNLOADER_MAX_CONCURRENCY: 32 },
  });

  assert.equal(config.version, 1);
  assert.equal(configV2.version, 2);
  assert.deepEqual(
    (await store.listConfigs({ machineId: "worker-a" })).map((item) => item.active),
    [false, true]
  );
  assert.equal((await store.listEnvProfiles({ machineId: "worker-a" }))[0].envProfileId, env.envProfileId);
});
