import { randomUUID } from "node:crypto";

import { normalizeRanges } from "../../../src/config/config-loader.js";
import { normalizeMachineId } from "../../../src/runtime/machine-id.js";
import { normalizeDashboardSettings } from "./settings.js";

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_COMMAND_LEASE_MS = 120_000;
const SETTINGS_KEY = "dashboard";
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_NAME_PATTERN = /(TOKEN|PASSWORD|SECRET|KEY|ACCESS|CREDENTIAL)/;
const EVENT_SEVERITIES = new Set(["debug", "info", "warn", "error", "success"]);
const ACTIVE_JOB_STATUSES = new Set(["running", "queued", "claimed"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "stopped"]);
const COMMAND_TYPES = new Set([
  "start_pipeline",
  "stop_pipeline",
  "pause_after_range",
  "resume_pipeline",
  "sync_config",
  "sync_env",
  "write_env",
  "write_config",
  "clear_agent_log",
  "git_pull_restart",
  "run_preflight",
]);
const RUNTIME_START_COMMAND_TYPES = new Set(["start_pipeline", "resume_pipeline", "run_preflight"]);

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

function requireStoredMachineId(value, name = "machineId") {
  const machineId = normalizeMachineId(value);
  if (!machineId) throw new Error(`${name} is required`);
  return machineId;
}

function optionalStoredMachineId(value) {
  return normalizeMachineId(value) || null;
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toJsonbParam(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
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
    agentSnapshot: jsonValue(row.agent_snapshot_json, {}),
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
    readAt: iso(row.read_at),
    createdAt: iso(row.created_at),
  };
}

function commandFromRow(row, { commandLeaseMs = DEFAULT_COMMAND_LEASE_MS } = {}) {
  const claimedAt = iso(row.claimed_at);
  const claimedExpiresAt = claimedAt
    ? new Date(new Date(claimedAt).getTime() + commandLeaseMs).toISOString()
    : null;
  return {
    id: String(row.id),
    machineId: row.machine_id,
    commandType: row.command_type,
    payload: jsonValue(row.payload_json, {}),
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: iso(row.requested_at),
    claimedAt,
    claimedExpiresAt,
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
    active: true,
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

function jobFromRow(row) {
  return {
    jobId: row.job_id,
    machineId: row.machine_id,
    configId: row.config_id,
    rangeId: row.range_id,
    status: row.status,
    stage: row.stage,
    progress: jsonValue(row.progress_json, {}),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    error: row.error,
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
  commandLeaseMs = DEFAULT_COMMAND_LEASE_MS,
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
        [SETTINGS_KEY, toJsonbParam(settings, {}), now().toISOString()]
      );
      return normalizeDashboardSettings(jsonValue(row?.value_json, settings));
    },

    async registerMachine(input) {
      const machineId = requireStoredMachineId(input.machineId);
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
          last_seen_at, lease_expires_at, disk_json, agent_snapshot_json, current_job_id, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (machine_id) DO UPDATE SET
          agent_instance_id=excluded.agent_instance_id,
          display_name=excluded.display_name,
          status=excluded.status,
          platform=excluded.platform,
          version=excluded.version,
          last_seen_at=excluded.last_seen_at,
          lease_expires_at=excluded.lease_expires_at,
          disk_json=excluded.disk_json,
          agent_snapshot_json=excluded.agent_snapshot_json,
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
          toJsonbParam(Array.isArray(input.disk) ? input.disk : jsonValue(existing?.disk_json, []), []),
          toJsonbParam(input.agentSnapshot && typeof input.agentSnapshot === "object"
            ? input.agentSnapshot
            : jsonValue(existing?.agent_snapshot_json, {}), {}),
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
      const machineId = requireStoredMachineId(input.machineId);
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
          last_seen_at, lease_expires_at, disk_json, agent_snapshot_json, current_job_id, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (machine_id) DO UPDATE SET
          status=excluded.status,
          platform=excluded.platform,
          last_seen_at=excluded.last_seen_at,
          lease_expires_at=excluded.lease_expires_at,
          disk_json=excluded.disk_json,
          agent_snapshot_json=excluded.agent_snapshot_json,
          current_job_id=excluded.current_job_id,
          updated_at=excluded.updated_at
        RETURNING *`,
        [
          machineId,
          agentInstanceId,
          existing.display_name,
          input.status || "online",
          input.platform || existing.platform,
          existing.version,
          at.toISOString(),
          addMs(at, leaseMs).toISOString(),
          toJsonbParam(Array.isArray(input.disk) ? input.disk : jsonValue(existing.disk_json, []), []),
          toJsonbParam(input.agentSnapshot && typeof input.agentSnapshot === "object"
            ? input.agentSnapshot
            : jsonValue(existing.agent_snapshot_json, {}), {}),
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
      const row = await firstRow(db, "SELECT * FROM machines WHERE machine_id=$1", [normalizeMachineId(machineId)]);
      return row ? machineFromRow(row, { now: now() }) : null;
    },

    async clearMachineConsole(machineId) {
      const normalizedMachineId = requireStoredMachineId(machineId);
      const existing = await firstRow(db, "SELECT * FROM machines WHERE machine_id=$1", [normalizedMachineId]);
      if (!existing) throw new Error(`machine "${normalizedMachineId}" not found`);
      const at = now();
      const agentSnapshot = jsonValue(existing.agent_snapshot_json, {});
      agentSnapshot.console = {
        ...(agentSnapshot.console || {}),
        recentLines: [],
        clearedAt: at.toISOString(),
      };
      const row = await firstRow(
        db,
        "UPDATE machines SET agent_snapshot_json=$2, updated_at=$3 WHERE machine_id=$1 RETURNING *",
        [normalizedMachineId, toJsonbParam(agentSnapshot, {}), at.toISOString()]
      );
      return machineFromRow(row, { now: at });
    },

    async deleteMachine(machineId) {
      const normalizedMachineId = requireStoredMachineId(machineId);
      const row = await firstRow(db, "SELECT * FROM machines WHERE machine_id=$1", [normalizedMachineId]);
      if (!row) throw new Error(`machine "${normalizedMachineId}" not found`);
      await db.query("DELETE FROM machine_commands WHERE machine_id=$1", [normalizedMachineId]);
      await db.query("DELETE FROM machine_events WHERE machine_id=$1", [normalizedMachineId]);
      await db.query("DELETE FROM machine_jobs WHERE machine_id=$1", [normalizedMachineId]);
      await db.query("DELETE FROM configs WHERE machine_id=$1", [normalizedMachineId]);
      await db.query("DELETE FROM env_profiles WHERE machine_id=$1", [normalizedMachineId]);
      await db.query("DELETE FROM machines WHERE machine_id=$1", [normalizedMachineId]);
      return machineFromRow(row, { now: now() });
    },

    async createConfig(input) {
      const machineId = optionalStoredMachineId(input.machineId);
      const name = requireNonEmpty(input.name, "name");
      const config = validateConfig(input.config);
      const at = now().toISOString();
      const row = await firstRow(
        db,
        `INSERT INTO configs (
          config_id, machine_id, name, version, config_json, active, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [idGenerator(), machineId, name, 1, toJsonbParam(config, {}), true, at, at]
      );
      return configFromRow(row);
    },

    async updateConfig(configId, input) {
      const existing = await firstRow(db, "SELECT * FROM configs WHERE config_id=$1", [configId]);
      if (!existing) throw new Error(`config "${configId}" not found`);
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
          toJsonbParam(validateConfig(input.config ?? jsonValue(existing.config_json, {})), {}),
          true,
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
      const normalizedMachineId = machineId === undefined ? undefined : optionalStoredMachineId(machineId);
      const result = machineId === undefined
        ? await db.query("SELECT * FROM configs ORDER BY version, name", [])
        : await db.query("SELECT * FROM configs WHERE machine_id=$1 ORDER BY version, name", [normalizedMachineId]);
      return result.rows.map(configFromRow);
    },

    async createEnvProfile(input) {
      const machineId = optionalStoredMachineId(input.machineId);
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
        [idGenerator(), machineId, name, 1, toJsonbParam(env, {}), Boolean(input.active), at, at]
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
          toJsonbParam(normalizeEnv(input.env ?? jsonValue(existing.env_json, {})), {}),
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
      const normalizedMachineId = machineId === undefined ? undefined : optionalStoredMachineId(machineId);
      const result = machineId === undefined
        ? await db.query("SELECT * FROM env_profiles ORDER BY version, name", [])
        : await db.query("SELECT * FROM env_profiles WHERE machine_id=$1 ORDER BY version, name", [normalizedMachineId]);
      return result.rows.map(envProfileFromRow);
    },

    async recordEvent(input) {
      const machineId = requireStoredMachineId(input.machineId);
      const severity = input.severity || "info";
      if (!EVENT_SEVERITIES.has(severity)) throw new Error(`invalid event severity: ${severity}`);
      const row = await firstRow(
        db,
        `INSERT INTO machine_events (
          machine_id, job_id, severity, type, message, data_json, read_at, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [
          machineId,
          input.jobId || null,
          severity,
          requireNonEmpty(input.type, "type"),
          requireNonEmpty(input.message, "message"),
          toJsonbParam(input.data && typeof input.data === "object" ? input.data : {}, {}),
          null,
          now().toISOString(),
        ]
      );
      return eventFromRow(row);
    },

    async listEvents({ machineId, limit = 200 } = {}) {
      const normalizedMachineId = machineId === undefined ? undefined : optionalStoredMachineId(machineId);
      const result = machineId === undefined
        ? await db.query("SELECT * FROM machine_events ORDER BY created_at ASC LIMIT $1", [limit])
        : await db.query("SELECT * FROM machine_events WHERE machine_id=$1 ORDER BY created_at ASC LIMIT $2", [normalizedMachineId, limit]);
      return result.rows.map(eventFromRow);
    },

    async markEventsRead({ machineId, eventIds } = {}) {
      const normalizedMachineId = machineId === undefined ? undefined : optionalStoredMachineId(machineId);
      const ids = Array.isArray(eventIds) ? eventIds.map(String).filter(Boolean) : null;
      const at = now().toISOString();
      let result;
      if (ids?.length) {
        result = normalizedMachineId === undefined
          ? await db.query(
              "UPDATE machine_events SET read_at=COALESCE(read_at,$1) WHERE id = ANY($2::bigint[]) RETURNING *",
              [at, ids]
            )
          : await db.query(
              "UPDATE machine_events SET read_at=COALESCE(read_at,$1) WHERE machine_id=$2 AND id = ANY($3::bigint[]) RETURNING *",
              [at, normalizedMachineId, ids]
            );
      } else {
        result = normalizedMachineId === undefined
          ? await db.query("UPDATE machine_events SET read_at=COALESCE(read_at,$1) RETURNING *", [at])
          : await db.query("UPDATE machine_events SET read_at=COALESCE(read_at,$1) WHERE machine_id=$2 RETURNING *", [at, normalizedMachineId]);
      }
      return result.rows.map(eventFromRow);
    },

    async deleteEvents({ machineId, eventIds, readState } = {}) {
      const normalizedMachineId = machineId === undefined ? undefined : optionalStoredMachineId(machineId);
      const ids = Array.isArray(eventIds) ? eventIds.map(String).filter(Boolean) : null;
      const readClause = readState === "read"
        ? "read_at IS NOT NULL"
        : readState === "unread"
          ? "read_at IS NULL"
          : "TRUE";
      let result;
      if (ids?.length) {
        result = normalizedMachineId === undefined
          ? await db.query(
              `DELETE FROM machine_events WHERE id = ANY($1::bigint[]) AND ${readClause} RETURNING *`,
              [ids]
            )
          : await db.query(
              `DELETE FROM machine_events WHERE machine_id=$1 AND id = ANY($2::bigint[]) AND ${readClause} RETURNING *`,
              [normalizedMachineId, ids]
            );
      } else {
        result = normalizedMachineId === undefined
          ? await db.query(`DELETE FROM machine_events WHERE ${readClause} RETURNING *`, [])
          : await db.query(`DELETE FROM machine_events WHERE machine_id=$1 AND ${readClause} RETURNING *`, [normalizedMachineId]);
      }
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
          requireStoredMachineId(input.machineId),
          commandType,
          toJsonbParam(input.payload && typeof input.payload === "object" ? input.payload : {}, {}),
          input.requestedBy || null,
          now().toISOString(),
        ]
      );
      return commandFromRow(row, { commandLeaseMs });
    },

    async cancelPendingRuntimeCommands({ machineId, reason = "pipeline stopped" } = {}) {
      const normalizedMachineId = requireStoredMachineId(machineId);
      const result = await db.query(
        `UPDATE machine_commands
         SET status='cancelled', completed_at=$1, error=$2
         WHERE machine_id=$3
           AND status='queued'
           AND command_type = ANY($4::text[])
         RETURNING *`,
        [now().toISOString(), reason, normalizedMachineId, [...RUNTIME_START_COMMAND_TYPES]]
      );
      return result.rows.map((row) => commandFromRow(row, { commandLeaseMs }));
    },

    async claimCommands({ machineId, limit = 10 }) {
      const normalizedMachineId = requireStoredMachineId(machineId);
      const at = now();
      const expiredBefore = new Date(at.getTime() - commandLeaseMs).toISOString();
      await db.query(
        `UPDATE machine_commands
        SET status='queued', claimed_at=NULL
        WHERE machine_id=$1
          AND status='claimed'
          AND completed_at IS NULL
          AND claimed_at <= $2`,
        [normalizedMachineId, expiredBefore]
      );
      const queued = await db.query(
        "SELECT * FROM machine_commands WHERE machine_id=$1 AND status='queued' ORDER BY requested_at ASC LIMIT $2",
        [normalizedMachineId, limit]
      );
      const claimed = [];
      for (const row of queued.rows) {
        const updated = await firstRow(
          db,
          "UPDATE machine_commands SET status='claimed', claimed_at=$1 WHERE id=$2 AND status='queued' RETURNING *",
          [at.toISOString(), row.id]
        );
        if (updated) claimed.push(commandFromRow(updated, { commandLeaseMs }));
      }
      return claimed;
    },

    async completeCommand({ commandId, error = null, claimedAt = null }) {
      const row = claimedAt
        ? await firstRow(
            db,
            "UPDATE machine_commands SET status=$1, completed_at=$2, error=$3 WHERE id=$4 AND claimed_at=$5 RETURNING *",
            [error ? "failed" : "completed", now().toISOString(), error, commandId, claimedAt]
          )
        : await firstRow(
            db,
            "UPDATE machine_commands SET status=$1, completed_at=$2, error=$3 WHERE id=$4 RETURNING *",
            [error ? "failed" : "completed", now().toISOString(), error, commandId]
          );
      if (!row) {
        if (claimedAt) throw new Error(`command "${commandId}" claim expired or was reclaimed`);
        throw new Error(`command "${commandId}" not found`);
      }
      return commandFromRow(row, { commandLeaseMs });
    },

    async upsertJob(input) {
      const jobId = requireNonEmpty(input.jobId, "jobId");
      const existing = await firstRow(db, "SELECT * FROM machine_jobs WHERE job_id=$1", [jobId]);
      const at = now().toISOString();
      const status = requireNonEmpty(input.status, "status");
      if (existing && TERMINAL_JOB_STATUSES.has(existing.status) && !TERMINAL_JOB_STATUSES.has(status)) {
        return jobFromRow(existing);
      }
      const finishedAt = input.finishedAt
        || (TERMINAL_JOB_STATUSES.has(status) ? at : null);
      const machineId = requireStoredMachineId(input.machineId ?? existing?.machine_id);
      const row = await firstRow(
        db,
        `INSERT INTO machine_jobs (
          job_id, machine_id, config_id, range_id, status, stage, progress_json,
          started_at, finished_at, error
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (job_id) DO UPDATE SET
          machine_id=excluded.machine_id,
          config_id=excluded.config_id,
          range_id=excluded.range_id,
          status=excluded.status,
          stage=excluded.stage,
          progress_json=excluded.progress_json,
          finished_at=excluded.finished_at,
          error=excluded.error
        RETURNING *`,
        [
          jobId,
          machineId,
          requireNonEmpty(input.configId ?? existing?.config_id, "configId"),
          input.rangeId ?? existing?.range_id ?? null,
          status,
          requireNonEmpty(input.stage, "stage"),
          toJsonbParam(input.progress && typeof input.progress === "object" ? input.progress : {}, {}),
          input.startedAt || iso(existing?.started_at) || at,
          finishedAt,
          input.error || null,
        ]
      );
      await db.query(
        "UPDATE machines SET current_job_id=$1, updated_at=$2 WHERE machine_id=$3",
        [TERMINAL_JOB_STATUSES.has(status) ? null : jobId, at, machineId]
      );
      return jobFromRow(row);
    },

    async stopRunningJobs({ machineId, configId = null, error = "pipeline stopped", stage = null, progress = null } = {}) {
      const normalizedMachineId = requireStoredMachineId(machineId);
      const at = now().toISOString();
      const statuses = [...ACTIVE_JOB_STATUSES];
      const result = await db.query(
        `UPDATE machine_jobs
         SET status='stopped',
             stage=COALESCE($2, stage),
             progress_json=CASE WHEN $3::jsonb IS NULL THEN progress_json ELSE $3::jsonb END,
             finished_at=$4,
             error=$5
         WHERE machine_id=$1
           AND status = ANY($6::text[])
           AND ($7::text IS NULL OR config_id=$7)
         RETURNING *`,
        [
          normalizedMachineId,
          stage,
          progress && typeof progress === "object" ? toJsonbParam(progress, {}) : null,
          at,
          error,
          statuses,
          configId === null ? null : String(configId),
        ]
      );
      await db.query(
        `UPDATE machines
         SET current_job_id=NULL, updated_at=$1
         WHERE machine_id=$2
           AND (
             $3::text IS NULL
             OR current_job_id IS NULL
             OR current_job_id IN (
               SELECT job_id FROM machine_jobs WHERE machine_id=$2 AND config_id=$3
             )
           )`,
        [at, normalizedMachineId, configId === null ? null : String(configId)]
      );
      return result.rows.map(jobFromRow);
    },

    async deleteMachineJobs({ machineId, jobId = null } = {}) {
      const normalizedMachineId = requireStoredMachineId(machineId);
      const targetJobId = jobId === null || jobId === undefined || jobId === "" ? null : String(jobId);
      const at = now().toISOString();
      const result = targetJobId
        ? await db.query(
          "DELETE FROM machine_jobs WHERE machine_id=$1 AND job_id=$2 RETURNING *",
          [normalizedMachineId, targetJobId]
        )
        : await db.query(
          "DELETE FROM machine_jobs WHERE machine_id=$1 RETURNING *",
          [normalizedMachineId]
        );

      if (targetJobId) {
        await db.query(
          "UPDATE machines SET current_job_id=NULL, updated_at=$1 WHERE machine_id=$2 AND current_job_id=$3",
          [at, normalizedMachineId, targetJobId]
        );
      } else {
        await db.query(
          "UPDATE machines SET current_job_id=NULL, updated_at=$1 WHERE machine_id=$2",
          [at, normalizedMachineId]
        );
      }
      return result.rows.map(jobFromRow);
    },

    async listJobs({ machineId } = {}) {
      const normalizedMachineId = machineId === undefined ? undefined : optionalStoredMachineId(machineId);
      const result = machineId === undefined
        ? await db.query("SELECT * FROM machine_jobs ORDER BY started_at DESC, job_id ASC", [])
        : await db.query("SELECT * FROM machine_jobs WHERE machine_id=$1 ORDER BY started_at DESC, job_id ASC", [normalizedMachineId]);
      return result.rows.map(jobFromRow);
    },

    async getSnapshot() {
      const [machines, jobs, events, configs, envProfiles, settings] = await Promise.all([
        this.listMachines(),
        this.listJobs(),
        this.listEvents(),
        this.listConfigs(),
        this.listEnvProfiles(),
        this.getSettings(),
      ]);
      return { machines, jobs, events, configs, envProfiles, settings };
    },
  };
}
