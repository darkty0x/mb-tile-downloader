import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const CREDENTIAL_SECRET_TYPES = new Set(["credential", "server_rdp_credential"]);
const VALID_SECRET_TYPES = new Set(["mapbox_token", "proxy_txt", "storj_access", ...CREDENTIAL_SECRET_TYPES]);
const VALID_SECRET_STATUSES = new Set(["active", "inactive", "disabled", "error"]);
const VALID_CREDENTIAL_PROTOCOLS = new Set(["http:", "https:", "rdp:", "ssh:", "winrm:", "winrms:"]);
const DEFAULT_CREDENTIAL_PORTS = {
  "http:": 80,
  "https:": 443,
  "rdp:": 3389,
  "ssh:": 22,
  "winrm:": 5985,
  "winrms:": 5986,
};
export const SECRET_POOL_TARGETS = {
  mapbox_token: 1,
  proxy_txt: 50,
};

function keyFromSecret(appSecret) {
  if (!appSecret) throw new Error("APP_SECRET is required for secret encryption");
  return createHash("sha256").update(appSecret).digest();
}

function encrypt(value, appSecret) {
  const key = keyFromSecret(appSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(payload, appSecret) {
  const [version, iv, tag, encrypted] = String(payload).split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("unsupported encrypted secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(appSecret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function redact(value) {
  const text = String(value);
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function parseCredentialValue(value) {
  const payload = typeof value === "string" ? JSON.parse(value) : value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("credential value must be a JSON object");
  }
  const protocolUrl = String(payload.protocolUrl || "").trim();
  const username = String(payload.username || "").trim();
  const password = String(payload.password ?? "");
  const machineId = String(payload.machineId || "").trim() || null;
  if (!protocolUrl) throw new Error("credential protocol URL is required");
  if (!username) throw new Error("credential username is required");
  if (!password.trim()) throw new Error("credential password is required");
  const parsedUrl = new URL(protocolUrl);
  if (!VALID_CREDENTIAL_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error("credential protocol URL must use http, https, rdp, ssh, winrm, or winrms");
  }
  return {
    protocolUrl,
    protocol: parsedUrl.protocol.slice(0, -1),
    host: parsedUrl.hostname,
    port: parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : DEFAULT_CREDENTIAL_PORTS[parsedUrl.protocol],
    machineId,
    username,
    password,
  };
}

function normalizeCredentialValue(value) {
  const credential = parseCredentialValue(value);
  return JSON.stringify({
    protocolUrl: credential.protocolUrl,
    ...(credential.machineId ? { machineId: credential.machineId } : {}),
    username: credential.username,
    password: credential.password,
  });
}

function credentialBrowserMetadata(value) {
  const credential = parseCredentialValue(value);
  return {
    protocolUrl: credential.protocolUrl,
    protocol: credential.protocol,
    host: credential.host,
    port: credential.port,
    ...(credential.machineId ? { machineId: credential.machineId } : {}),
    username: credential.username,
    hasPassword: Boolean(credential.password),
  };
}

function credentialRedactedValue(metadata) {
  const host = new URL(metadata.protocolUrl).host;
  return `${metadata.username} @ ${host}`;
}

function normalizeSecretValue(secretType, value) {
  if (CREDENTIAL_SECRET_TYPES.has(secretType)) return normalizeCredentialValue(value);
  const text = String(value || "").trim();
  if (!text) throw new Error("secret value is required");
  if (secretType === "proxy_txt") return text.replace(/\s+/g, "");
  return text;
}

function duplicateKeyForSecret(secretType, value) {
  const normalized = normalizeSecretValue(secretType, value);
  if (!CREDENTIAL_SECRET_TYPES.has(secretType)) return normalized.toLowerCase();
  const credential = parseCredentialValue(normalized);
  return `${new URL(credential.protocolUrl).href}\n${credential.username}`.toLowerCase();
}

function normalizeProxyForRuntime(value) {
  const raw = String(value || "").trim().replace(/\s+/g, "");
  if (!raw) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

export function secretValueHash(value) {
  return createHash("sha256").update(String(value || "").trim()).digest("hex");
}

function candidateSecretValueHashes(secretType, value) {
  const normalized = normalizeSecretValue(secretType, value);
  const hashes = new Set([secretValueHash(normalized)]);
  if (secretType === "proxy_txt") hashes.add(secretValueHash(normalizeProxyForRuntime(normalized)));
  return hashes;
}

function secretUsage(record) {
  if (record.status !== "active") return "disabled";
  return record.machineId ? "assigned" : "available";
}

function normalizeSecret(record, { includeValue = false, appSecret } = {}) {
  const value = decrypt(record.encryptedValue, appSecret);
  const credential = CREDENTIAL_SECRET_TYPES.has(record.secretType) ? credentialBrowserMetadata(value) : null;
  return {
    secretId: record.secretId,
    machineId: record.machineId,
    assignedMachineId: record.machineId,
    secretType: record.secretType,
    label: record.label,
    status: record.status,
    usage: secretUsage(record),
    ...(credential?.machineId ? { targetMachineId: credential.machineId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(includeValue ? { value } : {
      redactedValue: credential ? credentialRedactedValue(credential) : redact(value),
      ...(credential ? { credential } : {}),
    }),
  };
}

function validateStatus(status = "active") {
  if (!VALID_SECRET_STATUSES.has(status)) throw new Error(`invalid secret status: ${status}`);
  return status;
}

function normalizeSecretRow(row) {
  return {
    secretId: row.secret_id,
    machineId: row.machine_id,
    secretType: row.secret_type,
    label: row.label,
    encryptedValue: row.encrypted_value,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export function splitSecretValues(secretType, value) {
  if (CREDENTIAL_SECRET_TYPES.has(secretType)) return [normalizeSecretValue(secretType, value)];
  if (secretType === "mapbox_token" || secretType === "proxy_txt") {
    const seen = new Set();
    return String(value || "")
      .split(/[,\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => {
        const key = normalizeSecretValue(secretType, item).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  return [String(value || "").trim()].filter(Boolean);
}

export function createSecretVault({ appSecret, idGenerator = randomUUID, now = () => new Date() } = {}) {
  const records = new Map();

  function findDuplicate(secretType, value, ignoreSecretId = null) {
    const nextKey = duplicateKeyForSecret(secretType, value);
    for (const record of records.values()) {
      if (record.secretId === ignoreSecretId || record.secretType !== secretType) continue;
      const existingKey = duplicateKeyForSecret(secretType, decrypt(record.encryptedValue, appSecret));
      if (existingKey === nextKey) return record;
    }
    return null;
  }

  function assignAvailable({ machineId, secretType, targetCount }) {
    if (!machineId || !targetCount) return;
    const assignedCount = [...records.values()].filter(
      (record) => record.secretType === secretType && record.machineId === machineId && record.status === "active"
    ).length;
    let needed = Math.max(0, targetCount - assignedCount);
    if (!needed) return;
    for (const record of records.values()) {
      if (!needed) break;
      if (record.secretType !== secretType || record.machineId || record.status !== "active") continue;
      record.machineId = machineId;
      record.updatedAt = now().toISOString();
      needed -= 1;
    }
  }

  return {
    createSecret(input) {
      if (!VALID_SECRET_TYPES.has(input.secretType)) {
        throw new Error(`invalid secret type: ${input.secretType}`);
      }
      const normalizedValue = normalizeSecretValue(input.secretType, input.value);
      const duplicate = findDuplicate(input.secretType, normalizedValue);
      if (duplicate) return { ...duplicate };
      const at = now().toISOString();
      const record = {
        secretId: idGenerator(),
        machineId: input.machineId || null,
        secretType: input.secretType,
        label: input.label || input.secretType,
        encryptedValue: encrypt(normalizedValue, appSecret),
        status: validateStatus(input.status || "active"),
        createdAt: at,
        updatedAt: at,
      };
      records.set(record.secretId, record);
      return { ...record };
    },

    updateSecret(secretId, input = {}) {
      const existing = records.get(secretId);
      if (!existing) throw new Error(`secret "${secretId}" not found`);
      const at = now().toISOString();
      const nextValue = input.value === undefined
        ? null
        : normalizeSecretValue(existing.secretType, input.value);
      const duplicate = nextValue ? findDuplicate(existing.secretType, nextValue, secretId) : null;
      if (duplicate) throw new Error(`duplicate ${existing.secretType} secret value`);
      const next = {
        ...existing,
        machineId: input.machineId === undefined ? existing.machineId : input.machineId || null,
        label: input.label === undefined ? existing.label : input.label || existing.secretType,
        encryptedValue: input.value === undefined
          ? existing.encryptedValue
          : encrypt(nextValue, appSecret),
        status: input.status === undefined ? existing.status : validateStatus(input.status),
        updatedAt: at,
      };
      records.set(secretId, next);
      return { ...next };
    },

    deleteSecret(secretId) {
      const existing = records.get(secretId);
      if (!existing) throw new Error(`secret "${secretId}" not found`);
      records.delete(secretId);
      return { ...existing };
    },

    getSecretForDashboard(secretId) {
      const existing = records.get(secretId);
      if (!existing) throw new Error(`secret "${secretId}" not found`);
      return normalizeSecret(existing, { includeValue: true, appSecret });
    },

    listSecretsForBrowser({ machineId } = {}) {
      return [...records.values()]
        .filter((record) => machineId === undefined || record.machineId === machineId)
        .map((record) => normalizeSecret(record, { appSecret }));
    },

    listSecretsForAgent({ machineId } = {}) {
      if (machineId) {
        for (const [secretType, targetCount] of Object.entries(SECRET_POOL_TARGETS)) {
          assignAvailable({ machineId, secretType, targetCount });
        }
      }
      return [...records.values()]
        .filter((record) => record.status === "active")
        .filter((record) => machineId === undefined || record.machineId === machineId)
        .map((record) => normalizeSecret(record, { includeValue: true, appSecret }));
    },

    updateAssignedSecretStatusByValueHash({ machineId, secretType, valueHash, status = "error" } = {}) {
      validateStatus(status);
      if (!machineId) throw new Error("machineId is required");
      if (!VALID_SECRET_TYPES.has(secretType)) throw new Error(`invalid secret type: ${secretType}`);
      if (!valueHash) throw new Error("valueHash is required");
      for (const record of records.values()) {
        if (record.machineId !== machineId || record.secretType !== secretType) continue;
        const value = decrypt(record.encryptedValue, appSecret);
        if (!candidateSecretValueHashes(secretType, value).has(valueHash)) continue;
        const next = { ...record, status, updatedAt: now().toISOString() };
        records.set(record.secretId, next);
        return normalizeSecret(next, { appSecret });
      }
      return null;
    },
  };
}

export function createPostgresSecretVault({
  db,
  appSecret,
  idGenerator = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!db?.query) throw new Error("db.query is required");

  async function listRows({ machineId } = {}) {
    const result = machineId === undefined
      ? await db.query("SELECT * FROM secrets ORDER BY created_at ASC", [])
      : await db.query("SELECT * FROM secrets WHERE machine_id=$1 ORDER BY created_at ASC", [machineId]);
    return result.rows.map(normalizeSecretRow);
  }

  async function findDuplicate(secretType, value, ignoreSecretId = null) {
    const nextKey = duplicateKeyForSecret(secretType, value);
    const result = await db.query("SELECT * FROM secrets WHERE secret_type=$1 ORDER BY created_at ASC", [secretType]);
    for (const row of result.rows.map(normalizeSecretRow)) {
      if (row.secretId === ignoreSecretId) continue;
      const existingKey = duplicateKeyForSecret(secretType, decrypt(row.encryptedValue, appSecret));
      if (existingKey === nextKey) return row;
    }
    return null;
  }

  async function assignAvailable({ machineId, secretType, targetCount }) {
    if (!machineId || !targetCount) return;
    const assigned = await db.query(
      "SELECT secret_id FROM secrets WHERE secret_type=$1 AND machine_id=$2 AND status='active'",
      [secretType, machineId]
    );
    let needed = Math.max(0, targetCount - assigned.rows.length);
    while (needed > 0) {
      const candidates = await db.query(
        "SELECT secret_id FROM secrets WHERE secret_type=$1 AND machine_id IS NULL AND status='active' ORDER BY created_at ASC LIMIT $2",
        [secretType, needed]
      );
      if (!candidates.rows.length) return;
      let claimed = 0;
      for (const row of candidates.rows) {
        const result = await db.query(
          "UPDATE secrets SET machine_id=$1, updated_at=$2 WHERE secret_id=$3 AND machine_id IS NULL AND status='active' RETURNING secret_id",
          [machineId, now().toISOString(), row.secret_id]
        );
        if (result.rows[0]) claimed += 1;
      }
      if (claimed === 0) return;
      needed -= claimed;
    }
  }

  return {
    async createSecret(input) {
      if (!VALID_SECRET_TYPES.has(input.secretType)) {
        throw new Error(`invalid secret type: ${input.secretType}`);
      }
      const normalizedValue = normalizeSecretValue(input.secretType, input.value);
      const duplicate = await findDuplicate(input.secretType, normalizedValue);
      if (duplicate) return duplicate;
      const at = now().toISOString();
      const result = await db.query(
        `INSERT INTO secrets (
          secret_id, machine_id, secret_type, label, encrypted_value, status, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [
          idGenerator(),
          input.machineId || null,
          input.secretType,
          input.label || input.secretType,
          encrypt(normalizedValue, appSecret),
          validateStatus(input.status || "active"),
          at,
          at,
        ]
      );
      return normalizeSecretRow(result.rows[0]);
    },

    async updateSecret(secretId, input = {}) {
      const existing = await db.query("SELECT * FROM secrets WHERE secret_id=$1", [secretId]);
      const row = existing.rows[0];
      if (!row) throw new Error(`secret "${secretId}" not found`);
      const at = now().toISOString();
      const nextValue = input.value === undefined
        ? null
        : normalizeSecretValue(row.secret_type, input.value);
      const duplicate = nextValue ? await findDuplicate(row.secret_type, nextValue, secretId) : null;
      if (duplicate) throw new Error(`duplicate ${row.secret_type} secret value`);
      const result = await db.query(
        `UPDATE secrets SET
          machine_id=$1,
          label=$2,
          encrypted_value=$3,
          status=$4,
          updated_at=$5
        WHERE secret_id=$6
        RETURNING *`,
        [
          input.machineId === undefined ? row.machine_id : input.machineId || null,
          input.label === undefined ? row.label : input.label || row.secret_type,
          input.value === undefined ? row.encrypted_value : encrypt(nextValue, appSecret),
          input.status === undefined ? row.status : validateStatus(input.status),
          at,
          secretId,
        ]
      );
      return normalizeSecretRow(result.rows[0]);
    },

    async deleteSecret(secretId) {
      const result = await db.query("DELETE FROM secrets WHERE secret_id=$1 RETURNING *", [secretId]);
      if (!result.rows[0]) throw new Error(`secret "${secretId}" not found`);
      return normalizeSecretRow(result.rows[0]);
    },

    async getSecretForDashboard(secretId) {
      const result = await db.query("SELECT * FROM secrets WHERE secret_id=$1", [secretId]);
      if (!result.rows[0]) throw new Error(`secret "${secretId}" not found`);
      return normalizeSecret(normalizeSecretRow(result.rows[0]), { includeValue: true, appSecret });
    },

    async listSecretsForBrowser({ machineId } = {}) {
      return (await listRows({ machineId })).map((record) => normalizeSecret(record, { appSecret }));
    },

    async listSecretsForAgent({ machineId } = {}) {
      if (machineId) {
        for (const [secretType, targetCount] of Object.entries(SECRET_POOL_TARGETS)) {
          await assignAvailable({ machineId, secretType, targetCount });
        }
      }
      return (await listRows({ machineId }))
        .filter((record) => record.status === "active")
        .map((record) => normalizeSecret(record, { includeValue: true, appSecret }));
    },

    async updateAssignedSecretStatusByValueHash({ machineId, secretType, valueHash, status = "error" } = {}) {
      validateStatus(status);
      if (!machineId) throw new Error("machineId is required");
      if (!VALID_SECRET_TYPES.has(secretType)) throw new Error(`invalid secret type: ${secretType}`);
      if (!valueHash) throw new Error("valueHash is required");
      const rows = await listRows({ machineId });
      for (const record of rows) {
        if (record.secretType !== secretType) continue;
        const value = decrypt(record.encryptedValue, appSecret);
        if (!candidateSecretValueHashes(secretType, value).has(valueHash)) continue;
        const result = await db.query(
          "UPDATE secrets SET status=$1, updated_at=$2 WHERE secret_id=$3 AND machine_id=$4 RETURNING *",
          [status, now().toISOString(), record.secretId, machineId]
        );
        return result.rows[0]
          ? normalizeSecret(normalizeSecretRow(result.rows[0]), { appSecret })
          : null;
      }
      return null;
    },
  };
}
