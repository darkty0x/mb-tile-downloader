import { randomUUID } from "node:crypto";

import { normalizeRanges } from "../../../src/config/config-loader.js";

const DEFAULT_LEASE_MS = 120_000;
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

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function iso(date) {
  return date.toISOString();
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function normalizeMachine(record, { now = null } = {}) {
  const leaseExpired = now && Date.parse(record.leaseExpiresAt) <= now.getTime();
  return {
    machineId: record.machineId,
    agentInstanceId: record.agentInstanceId,
    displayName: record.displayName,
    status: record.status === "online" && leaseExpired ? "offline" : record.status,
    platform: record.platform,
    version: record.version,
    disk: record.disk,
    currentJobId: record.currentJobId,
    lastSeenAt: record.lastSeenAt,
    leaseExpiresAt: record.leaseExpiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeEnvValue(value, name) {
  if (!ENV_NAME_PATTERN.test(name)) throw new Error(`invalid env name: ${name}`);
  if (SECRET_NAME_PATTERN.test(name)) {
    throw new Error(`env "${name}" must be stored as secrets`);
  }
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new Error(`env "${name}" must be a string, number, or boolean`);
  }
  return value;
}

function normalizeEnv(env = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(env)) {
    normalized[name] = normalizeEnvValue(value, name);
  }
  return normalized;
}

function normalizeEnvProfile(record) {
  return {
    envProfileId: record.envProfileId,
    machineId: record.machineId,
    name: record.name,
    version: record.version,
    env: { ...record.env },
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
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

function normalizeConfig(record) {
  return {
    configId: record.configId,
    machineId: record.machineId,
    name: record.name,
    version: record.version,
    config: structuredClone(record.config),
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeEvent(record) {
  return {
    id: record.id,
    machineId: record.machineId,
    jobId: record.jobId,
    severity: record.severity,
    type: record.type,
    message: record.message,
    data: { ...record.data },
    createdAt: record.createdAt,
  };
}

function normalizeCommand(record) {
  return {
    id: record.id,
    machineId: record.machineId,
    commandType: record.commandType,
    payload: { ...record.payload },
    status: record.status,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    claimedAt: record.claimedAt,
    completedAt: record.completedAt,
    error: record.error,
  };
}

export function createDashboardStore({
  now = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  idGenerator = randomUUID,
} = {}) {
  const machines = new Map();
  const configs = new Map();
  const envProfiles = new Map();
  const events = [];
  const commands = new Map();

  return {
    registerMachine(input) {
      const machineId = requireNonEmpty(input.machineId, "machineId");
      const agentInstanceId = requireNonEmpty(input.agentInstanceId, "agentInstanceId");
      const at = now();
      const leaseExpiresAt = iso(addMs(at, leaseMs));
      const existing = machines.get(machineId);

      if (existing) {
        const existingLeaseLive = Date.parse(existing.leaseExpiresAt) > at.getTime();
        if (existing.agentInstanceId !== agentInstanceId && existingLeaseLive) {
          throw new Error(
            `machine id "${machineId}" is already registered by another live agent`
          );
        }

        const status = existing.agentInstanceId === agentInstanceId ? "renewed" : "takeover";
        const next = {
          ...existing,
          agentInstanceId,
          displayName: input.displayName || machineId,
          platform: input.platform || existing.platform || null,
          version: input.version || existing.version || null,
          status: "online",
          disk: Array.isArray(input.disk) ? input.disk : existing.disk,
          lastSeenAt: iso(at),
          leaseExpiresAt,
          updatedAt: iso(at),
        };
        machines.set(machineId, next);
        return { status, machine: normalizeMachine(next, { now: at }) };
      }

      const record = {
        machineId,
        agentInstanceId,
        displayName: input.displayName || machineId,
        status: "online",
        platform: input.platform || null,
        version: input.version || null,
        disk: Array.isArray(input.disk) ? input.disk : [],
        currentJobId: null,
        lastSeenAt: iso(at),
        leaseExpiresAt,
        createdAt: iso(at),
        updatedAt: iso(at),
      };
      machines.set(machineId, record);
      return { status: "registered", machine: normalizeMachine(record, { now: at }) };
    },

    heartbeatMachine(input) {
      const machineId = requireNonEmpty(input.machineId, "machineId");
      const agentInstanceId = requireNonEmpty(input.agentInstanceId, "agentInstanceId");
      const existing = machines.get(machineId);
      if (!existing) throw new Error(`machine id "${machineId}" is not registered`);
      if (existing.agentInstanceId !== agentInstanceId) {
        throw new Error(`machine id "${machineId}" heartbeat came from a different agent`);
      }

      const at = now();
      const next = {
        ...existing,
        status: input.status || "online",
        disk: Array.isArray(input.disk) ? input.disk : existing.disk,
        currentJobId: input.currentJobId ?? existing.currentJobId,
        lastSeenAt: iso(at),
        leaseExpiresAt: iso(addMs(at, leaseMs)),
        updatedAt: iso(at),
      };
      machines.set(machineId, next);
      return normalizeMachine(next, { now: at });
    },

    listMachines() {
      return [...machines.values()]
        .map((record) => normalizeMachine(record, { now: now() }))
        .sort((a, b) => a.machineId.localeCompare(b.machineId));
    },

    getMachine(machineId) {
      const record = machines.get(machineId);
      return record ? normalizeMachine(record, { now: now() }) : null;
    },

    createConfig(input) {
      const machineId = input.machineId ? input.machineId.trim() : null;
      const name = requireNonEmpty(input.name, "name");
      const config = validateConfig(input.config);
      const at = iso(now());
      const id = idGenerator();
      if (input.active) {
        for (const record of configs.values()) {
          if (record.machineId === machineId) record.active = false;
        }
      }
      const record = {
        configId: id,
        machineId,
        name,
        version: 1,
        config,
        active: Boolean(input.active),
        createdAt: at,
        updatedAt: at,
      };
      configs.set(id, record);
      return normalizeConfig(record);
    },

    updateConfig(configId, input) {
      const existing = configs.get(configId);
      if (!existing) throw new Error(`config "${configId}" not found`);
      const next = {
        ...existing,
        configId: `${existing.configId}-v${existing.version + 1}`,
        version: existing.version + 1,
        config: validateConfig(input.config ?? existing.config),
        active: Boolean(input.active),
        updatedAt: iso(now()),
      };
      if (next.active) {
        for (const record of configs.values()) {
          if (record.machineId === next.machineId) record.active = false;
        }
      }
      configs.set(next.configId, next);
      return normalizeConfig(next);
    },

    listConfigs({ machineId } = {}) {
      return [...configs.values()]
        .filter((record) => machineId === undefined || record.machineId === machineId)
        .map(normalizeConfig)
        .sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
    },

    createEnvProfile(input) {
      const machineId = input.machineId ? input.machineId.trim() : null;
      const name = requireNonEmpty(input.name, "name");
      const env = normalizeEnv(input.env);
      const at = iso(now());
      const id = idGenerator();
      if (input.active) {
        for (const profile of envProfiles.values()) {
          if (profile.machineId === machineId) profile.active = false;
        }
      }
      const record = {
        envProfileId: id,
        machineId,
        name,
        version: 1,
        env,
        active: Boolean(input.active),
        createdAt: at,
        updatedAt: at,
      };
      envProfiles.set(id, record);
      return normalizeEnvProfile(record);
    },

    updateEnvProfile(envProfileId, input) {
      const existing = envProfiles.get(envProfileId);
      if (!existing) throw new Error(`env profile "${envProfileId}" not found`);
      const at = iso(now());
      const next = {
        ...existing,
        envProfileId: `${existing.envProfileId}-v${existing.version + 1}`,
        version: existing.version + 1,
        env: normalizeEnv(input.env ?? existing.env),
        active: Boolean(input.active),
        createdAt: existing.createdAt,
        updatedAt: at,
      };
      if (next.active) {
        for (const profile of envProfiles.values()) {
          if (profile.machineId === next.machineId) profile.active = false;
        }
      }
      envProfiles.set(next.envProfileId, next);
      return normalizeEnvProfile(next);
    },

    listEnvProfiles({ machineId } = {}) {
      return [...envProfiles.values()]
        .filter((profile) => machineId === undefined || profile.machineId === machineId)
        .map(normalizeEnvProfile)
        .sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
    },

    recordEvent(input) {
      const machineId = requireNonEmpty(input.machineId, "machineId");
      const severity = input.severity || "info";
      if (!EVENT_SEVERITIES.has(severity)) {
        throw new Error(`invalid event severity: ${severity}`);
      }
      const record = {
        id: idGenerator(),
        machineId,
        jobId: input.jobId || null,
        severity,
        type: requireNonEmpty(input.type, "type"),
        message: requireNonEmpty(input.message, "message"),
        data: input.data && typeof input.data === "object" ? { ...input.data } : {},
        createdAt: iso(now()),
      };
      events.push(record);
      return normalizeEvent(record);
    },

    listEvents({ machineId, limit = 200 } = {}) {
      return events
        .filter((event) => machineId === undefined || event.machineId === machineId)
        .slice(-limit)
        .map(normalizeEvent);
    },

    queueCommand(input) {
      const commandType = requireNonEmpty(input.commandType, "commandType");
      if (!COMMAND_TYPES.has(commandType)) throw new Error(`unsupported command: ${commandType}`);
      const at = iso(now());
      const record = {
        id: idGenerator(),
        machineId: requireNonEmpty(input.machineId, "machineId"),
        commandType,
        payload: input.payload && typeof input.payload === "object" ? { ...input.payload } : {},
        status: "queued",
        requestedBy: input.requestedBy || null,
        requestedAt: at,
        claimedAt: null,
        completedAt: null,
        error: null,
      };
      commands.set(record.id, record);
      return normalizeCommand(record);
    },

    claimCommands({ machineId, limit = 10 }) {
      const at = iso(now());
      const claimed = [];
      for (const record of commands.values()) {
        if (claimed.length >= limit) break;
        if (record.machineId !== machineId || record.status !== "queued") continue;
        record.status = "claimed";
        record.claimedAt = at;
        claimed.push(normalizeCommand(record));
      }
      return claimed;
    },

    completeCommand({ commandId, error = null }) {
      const record = commands.get(commandId);
      if (!record) throw new Error(`command "${commandId}" not found`);
      record.status = error ? "failed" : "completed";
      record.completedAt = iso(now());
      record.error = error;
      return normalizeCommand(record);
    },
  };
}
