import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const VALID_SECRET_TYPES = new Set(["mapbox_token", "proxy_txt", "storj_access"]);
const VALID_SECRET_STATUSES = new Set(["active", "inactive", "error"]);

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

function normalizeSecret(record, { includeValue = false, appSecret } = {}) {
  const value = includeValue ? decrypt(record.encryptedValue, appSecret) : null;
  return {
    secretId: record.secretId,
    machineId: record.machineId,
    secretType: record.secretType,
    label: record.label,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(includeValue ? { value } : { redactedValue: redact(decrypt(record.encryptedValue, appSecret)) }),
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

export function createSecretVault({ appSecret, idGenerator = randomUUID, now = () => new Date() } = {}) {
  const records = new Map();

  return {
    createSecret(input) {
      if (!VALID_SECRET_TYPES.has(input.secretType)) {
        throw new Error(`invalid secret type: ${input.secretType}`);
      }
      const at = now().toISOString();
      const record = {
        secretId: idGenerator(),
        machineId: input.machineId || null,
        secretType: input.secretType,
        label: input.label || input.secretType,
        encryptedValue: encrypt(input.value, appSecret),
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
      const next = {
        ...existing,
        machineId: input.machineId === undefined ? existing.machineId : input.machineId || null,
        label: input.label === undefined ? existing.label : input.label || existing.secretType,
        encryptedValue: input.value === undefined
          ? existing.encryptedValue
          : encrypt(input.value, appSecret),
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

    listSecretsForBrowser({ machineId } = {}) {
      return [...records.values()]
        .filter((record) => machineId === undefined || record.machineId === machineId)
        .map((record) => normalizeSecret(record, { appSecret }));
    },

    listSecretsForAgent({ machineId } = {}) {
      return [...records.values()]
        .filter((record) => record.status === "active")
        .filter((record) => machineId === undefined || record.machineId === machineId)
        .map((record) => normalizeSecret(record, { includeValue: true, appSecret }));
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

  return {
    async createSecret(input) {
      if (!VALID_SECRET_TYPES.has(input.secretType)) {
        throw new Error(`invalid secret type: ${input.secretType}`);
      }
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
          encrypt(input.value, appSecret),
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
          input.value === undefined ? row.encrypted_value : encrypt(input.value, appSecret),
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

    async listSecretsForBrowser({ machineId } = {}) {
      return (await listRows({ machineId })).map((record) => normalizeSecret(record, { appSecret }));
    },

    async listSecretsForAgent({ machineId } = {}) {
      return (await listRows({ machineId }))
        .filter((record) => record.status === "active")
        .map((record) => normalizeSecret(record, { includeValue: true, appSecret }));
    },
  };
}
