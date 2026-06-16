import { randomUUID } from "node:crypto";

import { normalizeRanges } from "../../../src/config/config-loader.js";
import { normalizeDashboardSettings } from "./settings.js";

const DEFAULT_LEASE_MS = 120_000;
const SETTINGS_KEY = "dashboard";
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_NAME_PATTERN = /(TOKEN|PASSWORD|SECRET|KEY|ACCESS|CREDENTIAL)/;
const EVENT_SEVERITIES = new Set(["debug", "info", "warn", "error", "success"]);
const COMMAND_TYPES = new Set([
  "start_pipeline",
  "stop_pipeline",
  "pause_after_range",
  "resume_pipeline",
  "sync_config",
  "sync_env",
  "run_preflight",
]);

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config must be an object");
  }
  if (!["mapbox", "esri"].includes(String(config.provider || "").toLowerCase())) {
    throw new Error("config.provider must be one of: mapbox, esri");
  }
  normalizeRanges(config);
  return structuredClone(config);
}

function normalizeEnv(env = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`invalid env name: ${name}`);
    if (SECRET_NAME_PATTERN.test(name)) {
      throw new Error(`env "${name}" must be stored as secrets`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`env "${name}" must be a string, number, or boolean`);
    }
    normalized[name] = value;
  }
  return normalized;
}

function machineFromRow(row, { now = null } = {}) {
  const leaseExpired = now && new Date(row.lease_expires_at).getTime() <= now.getTime();
  return {
    machineId: row.machine_id,
    agentInstanceId: row.agent_instance_id,
    displayName: row.display_name,
    status: row.status === "online" && leaseExpired ? "offline" : row.status,
    platform: row.platform,
    version: row.version,
    disk: jsonValue(row.disk_json, []),
    currentJobId: row.current_job_id,
    lastSeenAt: iso(row.last_seen_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    machineId: row.machine_id,
    jobId: row.job_id,
    severity: row.severity,
    type: row.type,
    message: row.message,
    data: jsonValue(row.data_json, {}),
    createdAt: iso(row.created_at),
  };
}

function commandFromRow(row) {
  return {
    id: String(row.id),
    machineId: row.machine_id,
    commandType: row.command_type,
    payload: jsonValue(row.payload_json, {}),
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: iso(row.requested_at),
    claimedAt: iso(row.claimed_at),
    completedAt: iso(row.completed_at),
    error: row.error,
  };
}

function configFromRow(row) {
  return {
    configId: row.config_id,
    machineId: row.machine_id,
    name: row.name,
    version: row.version,
    config: jsonValue(row.config_json, {}),
    active: row.active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function envProfileFromRow(row) {
  return {
    envProfileId: row.env_profile_id,
    machineId: row.machine_id,
    name: row.name,
    version: row.version,
    env: jsonValue(row.env_json, {}),
    active: row.active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function firstRow(db, sql, params) {
  const result = await db.query(sql, params);
  return result.rows[0] || null;
}

export function createPostgresDashboardStore({
  db,
  now = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  idGenerator = randomUUID,
} = {}) {
  if (!db?.query) throw new Error("db.query is required");

  return {
    async getSettings() {
      const row = await firstRow(db, "SELECT value_json FROM dashboard_settings WHERE key=$1", [SETTINGS_KEY]);
      return normalizeDashboardSettings(jsonValue(row?.value_json, {}));
    },

    async updateSettings(input) {
      const current = await firstRow(db, "SELECT value_json FROM dashboard_settings WHERE key=$1", [SETTINGS_KEY]);
      const settings = normalizeDashboardSettings(input, normalizeDashboardSettings(jsonValue(current?.value_json, {})));
      const row = await firstRow(
        db,
        `INSERT INTO dashboard_settings (key, value_json, updated_at)
        VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET
          value_json=excluded.value_json,
          updated_at=excluded.updated_at
        RETURNING value_json`,
        [SETTINGS_KEY, settings, now().toISOString()]
      );
      return normalizeDashboardSettings(jsonValue(row?.value_json, settings));
    },

    async registerMachine(input) {
      const machineId = requireNonEmpty(input.machineId, "machineId");
      const agentInstanceId = requireNonEmpty(input.agentInstanceId, "agentInstanceId");
      const at = now();
      const existing = await firstRow(db, "SELECT * FROM machines WHERE machine_id=$1", [machineId]);
      if (existing) {
        const leaseLive = new Date(existing.lease_expires_at).getTime() > at.getTime();
        if (existing.agent_instance_id !== agentInstanceId && leaseLive) {
          throw new Error(`machine id "${machineId}" is already registered by another live agent`);
        }
      }

      const createdAt = existing?.created_at || at.toISOString();
      const row = await firstRow(
        db,
        `INSERT INTO machines (
          machine_id, agent_instance_id, display_name, status, platform, version,
          last_seen_at, lease_expires_at, disk_json, current_job_id, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (machine_id) DO UPDATE SET
          agent_instance_id=excluded.agent_instance_id,
          display_name=excluded.display_name,
          status=excluded.status,
          platform=excluded.platform,
          version=excluded.version,
          last_seen_at=excluded.last_seen_at,
          lease_expires_at=excluded.lease_expires_at,
          disk_json=excluded.disk_json,
          current_job_id=excluded.current_job_id,
          updated_at=excluded.updated_at
        RETURNING *`,
        [
          machineId,
          agentInstanceId,
          input.displayName || machineId,
          "online",
          input.platform || existing?.platform || null,
          input.version || existing?.version || null,
          at.toISOString(),
          addMs(at, leaseMs).toISOString(),
          Array.isArray(input.disk) ? input.disk : jsonValue(existing?.disk_json, []),
          input.currentJobId ?? existing?.current_job_id ?? null,
          createdAt,
          at.toISOString(),
        ]
      );

      const status = !existing
        ? "registered"
        : existing.agent_instance_id === agentInstanceId
          ? "renewed"
          : "takeover";
      return { status, machine: machineFromRow(row, { now: at }) };
    },

    async heartbeatMachine(input) {
      const machineId = requireNonEmpty(input.machineId, "machineId");
      const agentInstanceId = requireNonEmpty(input.agentInstanceId, "agentInstanceId");
      const existing = await firstRow(db, "SELECT * FROM machines WHERE machine_id=$1", [machineId]);
      if (!existing) throw new Error(`machine id "${machineId}" is not registered`);
      if (existing.agent_instance_id !== agentInstanceId) {
        throw new Error(`machine id "${machineId}" heartbeat came from a different agent`);
      }
      const at = now();
      const row = await firstRow(
        db,
        `INSERT INTO machines (
          machine_id, agent_instance_id, display_name, status, platform, version,
          last_seen_at, lease_expires_at, disk_json, current_job_id, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (machine_id) DO UPDATE SET
          status=excluded.status,
          last_seen_at=excluded.last_seen_at,
          lease_expires_at=excluded.lease_expires_at,
          disk_json=excluded.disk_json,
          current_job_id=excluded.current_job_id,
          updated_at=excluded.updated_at
        RETURNING *`,
        [
          machineId,
          agentInstanceId,
          existing.display_name,
          input.status || "online",
          existing.platform,
          existing.version,
          at.toISOString(),
          addMs(at, leaseMs).toISOString(),
          Array.isArray(input.disk) ? input.disk : jsonValue(existing.disk_json, []),
          input.currentJobId ?? existing.current_job_id,
          iso(existing.created_at),
          at.toISOString(),
        ]
      );
      return machineFromRow(row, { now: at });
    },

    async listMachines() {
      const result = await db.query("SELECT * FROM machines ORDER BY machine_id", []);
      const at = now();
      return result.rows.map((row) => machineFromRow(row, { now: at }));
    },

    async getMachine(machineId) {
      const row = await firstRow(db, "SELECT * FROM machines WHERE machine_id=$1", [machineId]);
      return row ? machineFromRow(row, { now: now() }) : null;
    },

    async createConfig(input) {
      const machineId = input.machineId ? input.machineId.trim() : null;
      const name = requireNonEmpty(input.name, "name");
      const config = validateConfig(input.config);
      const at = now().toISOString();
      if (input.active) {
        await db.query("UPDATE configs SET active=false WHERE machine_id=$1", [machineId]);
      }
      const row = await firstRow(
        db,
        `INSERT INTO configs (
          config_id, machine_id, name, version, config_json, active, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [idGenerator(), machineId, name, 1, config, Boolean(input.active), at, at]
      );
      return configFromRow(row);
    },

    async updateConfig(configId, input) {
      const existing = await firstRow(db, "SELECT * FROM configs WHERE config_id=$1", [configId]);
      if (!existing) throw new Error(`config "${configId}" not found`);
      const active = Boolean(input.active);
      if (active) {
        await db.query("UPDATE configs SET active=false WHERE machine_id=$1", [existing.machine_id]);
      }
      const at = now().toISOString();
      const row = await firstRow(
        db,
        `INSERT INTO configs (
          config_id, machine_id, name, version, config_json, active, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [
          `${existing.config_id}-v${existing.version + 1}`,
          existing.machine_id,
          input.name ? requireNonEmpty(input.name, "name") : existing.name,
          existing.version + 1,
          validateConfig(input.config ?? jsonValue(existing.config_json, {})),
          active,
          iso(existing.created_at),
          at,
        ]
      );
      return configFromRow(row);
    },

    async deleteConfig(configId) {
      const row = await firstRow(db, "DELETE FROM configs WHERE config_id=$1 RETURNING *", [configId]);
      if (!row) throw new Error(`config "${configId}" not found`);
      return configFromRow(row);
    },

    async listConfigs({ machineId } = {}) {
      const result = machineId === undefined
        ? await db.query("SELECT * FROM configs ORDER BY version, name", [])
        : await db.query("SELECT * FROM configs WHERE machine_id=$1 ORDER BY version, name", [machineId]);
      return result.rows.map(configFromRow);
    },

    async createEnvProfile(input) {
      const machineId = input.machineId ? input.machineId.trim() : null;
      const name = requireNonEmpty(input.name, "name");
      const env = normalizeEnv(input.env);
      const at = now().toISOString();
      if (input.active) {
        await db.query("UPDATE env_profiles SET active=false WHERE machine_id=$1", [machineId]);
      }
      const row = await firstRow(
        db,
        `INSERT INTO env_profiles (
          env_profile_id, machine_id, name, version, env_json, active, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [idGenerator(), machineId, name, 1, env, Boolean(input.active), at, at]
      );
      return envProfileFromRow(row);
    },

    async updateEnvProfile(envProfileId, input) {
      const existing = await firstRow(db, "SELECT * FROM env_profiles WHERE env_profile_id=$1", [envProfileId]);
      if (!existing) throw new Error(`env profile "${envProfileId}" not found`);
      const active = Boolean(input.active);
      if (active) {
        await db.query("UPDATE env_profiles SET active=false WHERE machine_id=$1", [existing.machine_id]);
      }
      const at = now().toISOString();
      const row = await firstRow(
        db,
        `INSERT INTO env_profiles (
          env_profile_id, machine_id, name, version, env_json, active, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [
          `${existing.env_profile_id}-v${existing.version + 1}`,
          existing.machine_id,
          input.name ? requireNonEmpty(input.name, "name") : existing.name,
          existing.version + 1,
          normalizeEnv(input.env ?? jsonValue(existing.env_json, {})),
          active,
          iso(existing.created_at),
          at,
        ]
      );
      return envProfileFromRow(row);
    },

    async deleteEnvProfile(envProfileId) {
      const row = await firstRow(db, "DELETE FROM env_profiles WHERE env_profile_id=$1 RETURNING *", [envProfileId]);
      if (!row) throw new Error(`env profile "${envProfileId}" not found`);
      return envProfileFromRow(row);
    },

    async listEnvProfiles({ machineId } = {}) {
      const result = machineId === undefined
        ? await db.query("SELECT * FROM env_profiles ORDER BY version, name", [])
        : await db.query("SELECT * FROM env_profiles WHERE machine_id=$1 ORDER BY version, name", [machineId]);
      return result.rows.map(envProfileFromRow);
    },

    async recordEvent(input) {
      const machineId = requireNonEmpty(input.machineId, "machineId");
      const severity = input.severity || "info";
      if (!EVENT_SEVERITIES.has(severity)) throw new Error(`invalid event severity: ${severity}`);
      const row = await firstRow(
        db,
        `INSERT INTO machine_events (
          machine_id, job_id, severity, type, message, data_json, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
        [
          machineId,
          input.jobId || null,
          severity,
          requireNonEmpty(input.type, "type"),
          requireNonEmpty(input.message, "message"),
          input.data && typeof input.data === "object" ? input.data : {},
          now().toISOString(),
        ]
      );
      return eventFromRow(row);
    },

    async listEvents({ machineId, limit = 200 } = {}) {
      const result = machineId === undefined
        ? await db.query("SELECT * FROM machine_events ORDER BY created_at ASC LIMIT $1", [limit])
        : await db.query("SELECT * FROM machine_events WHERE machine_id=$1 ORDER BY created_at ASC LIMIT $2", [machineId, limit]);
      return result.rows.map(eventFromRow);
    },

    async queueCommand(input) {
      const commandType = requireNonEmpty(input.commandType, "commandType");
      if (!COMMAND_TYPES.has(commandType)) throw new Error(`unsupported command: ${commandType}`);
      const row = await firstRow(
        db,
        `INSERT INTO machine_commands (
          machine_id, command_type, payload_json, requested_by, requested_at
        )
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *`,
        [
          requireNonEmpty(input.machineId, "machineId"),
          commandType,
          input.payload && typeof input.payload === "object" ? input.payload : {},
          input.requestedBy || null,
          now().toISOString(),
        ]
      );
      return commandFromRow(row);
    },

    async claimCommands({ machineId, limit = 10 }) {
      const queued = await db.query(
        "SELECT * FROM machine_commands WHERE machine_id=$1 AND status='queued' ORDER BY requested_at ASC LIMIT $2",
        [machineId, limit]
      );
      const claimed = [];
      for (const row of queued.rows) {
        const updated = await firstRow(
          db,
          "UPDATE machine_commands SET status='claimed', claimed_at=$1 WHERE id=$2 RETURNING *",
          [now().toISOString(), row.id]
        );
        if (updated) claimed.push(commandFromRow(updated));
      }
      return claimed;
    },

    async completeCommand({ commandId, error = null }) {
      const row = await firstRow(
        db,
        "UPDATE machine_commands SET status=$1, completed_at=$2, error=$3 WHERE id=$4 RETURNING *",
        [error ? "failed" : "completed", now().toISOString(), error, commandId]
      );
      if (!row) throw new Error(`command "${commandId}" not found`);
      return commandFromRow(row);
    },
  };
}
