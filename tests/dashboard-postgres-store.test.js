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
      if (/UPDATE machine_commands SET status='claimed'/.test(sql)) {
        const [claimed_at, id] = params;
        const row = tables.machine_commands.get(String(id));
        row.status = "claimed";
        row.claimed_at = claimed_at;
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
    disk: [{ name: "C:", freeBytes: 100 }],
  });

  assert.equal(registered.status, "registered");
  assert.equal(heartbeat.disk[0].name, "C:");
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
