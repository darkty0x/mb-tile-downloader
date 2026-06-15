import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SECRET_POOL_TARGETS, createPostgresSecretVault, createSecretVault } from "../dashboard/src/server/secrets.js";
import { materializeSecrets } from "../src/agent/secret-materializer.js";

test("secret vault encrypts plaintext and redacts browser results", () => {
  const vault = createSecretVault({ appSecret: "test-secret" });

  const stored = vault.createSecret({
    machineId: "worker-a",
    secretType: "mapbox_token",
    label: "primary",
    value: "pk.secret-value",
  });
  const browserSecrets = vault.listSecretsForBrowser({ machineId: "worker-a" });

  assert.notEqual(stored.encryptedValue, "pk.secret-value");
  assert.match(stored.encryptedValue, /^v1:/);
  assert.equal(browserSecrets[0].redactedValue, "pk.s...alue");
  assert.equal(browserSecrets[0].value, undefined);
});

test("agent sync receives decrypted secret values", () => {
  const vault = createSecretVault({ appSecret: "test-secret" });
  vault.createSecret({
    machineId: "worker-a",
    secretType: "proxy_txt",
    label: "paid proxies",
    value: "http://u:p@1.2.3.4:8080",
  });

  const agentSecrets = vault.listSecretsForAgent({ machineId: "worker-a" });

  assert.equal(agentSecrets[0].value, "http://u:p@1.2.3.4:8080");
});

test("secret pool assigns mapbox keys and proxy items to only one machine", () => {
  let id = 0;
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
  });
  for (let index = 1; index <= 3; index++) {
    vault.createSecret({
      secretType: "mapbox_token",
      label: `mapbox-${index}`,
      value: `pk.token-${index}`,
    });
  }
  for (let index = 1; index <= SECRET_POOL_TARGETS.proxy_txt * 2; index++) {
    vault.createSecret({
      secretType: "proxy_txt",
      label: `proxy-${index}`,
      value: `http://proxy-${index}.example:8080`,
    });
  }
  vault.createSecret({
    secretType: "proxy_txt",
    label: "expired",
    value: "http://expired.example:8080",
    status: "disabled",
  });

  const workerA = vault.listSecretsForAgent({ machineId: "worker-a" });
  const workerB = vault.listSecretsForAgent({ machineId: "worker-b" });
  const mapboxA = workerA.find((secret) => secret.secretType === "mapbox_token");
  const mapboxB = workerB.find((secret) => secret.secretType === "mapbox_token");
  const proxiesA = workerA.filter((secret) => secret.secretType === "proxy_txt");
  const proxiesB = workerB.filter((secret) => secret.secretType === "proxy_txt");
  const overlap = proxiesA.filter((a) => proxiesB.some((b) => b.secretId === a.secretId));

  assert.ok(mapboxA);
  assert.ok(mapboxB);
  assert.notEqual(mapboxA.secretId, mapboxB.secretId);
  assert.equal(proxiesA.length, SECRET_POOL_TARGETS.proxy_txt);
  assert.equal(proxiesB.length, SECRET_POOL_TARGETS.proxy_txt);
  assert.equal(overlap.length, 0);
  assert.equal(proxiesA.some((secret) => /expired/.test(secret.value)), false);
  assert.equal(vault.listSecretsForBrowser().filter((secret) => secret.usage === "available" && secret.secretType === "mapbox_token").length, 1);
});

test("secret vault supports update status and delete", () => {
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => "secret-a",
  });
  vault.createSecret({
    machineId: "worker-a",
    secretType: "mapbox_token",
    label: "primary",
    value: "pk.secret-value",
  });

  vault.updateSecret("secret-a", {
    label: "backup",
    value: "pk.next-value",
    status: "inactive",
  });

  assert.equal(vault.listSecretsForBrowser({ machineId: "worker-a" })[0].label, "backup");
  assert.equal(vault.listSecretsForBrowser({ machineId: "worker-a" })[0].status, "inactive");
  assert.deepEqual(vault.listSecretsForAgent({ machineId: "worker-a" }), []);
  assert.equal(vault.deleteSecret("secret-a").secretId, "secret-a");
  assert.deepEqual(vault.listSecretsForBrowser({ machineId: "worker-a" }), []);
});

test("postgres secret vault persists encrypted rows and returns redacted browser values", async () => {
  const rows = new Map();
  const db = {
    async query(sql, params = []) {
      if (/INSERT INTO secrets/.test(sql)) {
        const [secret_id, machine_id, secret_type, label, encrypted_value, status, created_at, updated_at] = params;
        const row = {
          secret_id,
          machine_id,
          secret_type,
          label,
          encrypted_value,
          status,
          created_at,
          updated_at,
        };
        rows.set(secret_id, row);
        return { rows: [{ ...row }] };
      }
      if (/SELECT \* FROM secrets WHERE secret_type=\$1/.test(sql)) {
        return {
          rows: [...rows.values()].filter((row) => row.secret_type === params[0]),
        };
      }
      if (/SELECT \* FROM secrets WHERE machine_id=\$1/.test(sql)) {
        return {
          rows: [...rows.values()].filter((row) => row.machine_id === params[0]),
        };
      }
      if (/SELECT secret_id FROM secrets WHERE secret_type=\$1 AND machine_id=\$2/.test(sql)) {
        return {
          rows: [...rows.values()]
            .filter((row) => row.secret_type === params[0] && row.machine_id === params[1] && row.status === "active")
            .map((row) => ({ secret_id: row.secret_id })),
        };
      }
      if (/SELECT secret_id FROM secrets WHERE secret_type=\$1 AND machine_id IS NULL/.test(sql)) {
        return {
          rows: [...rows.values()]
            .filter((row) => row.secret_type === params[0] && row.machine_id === null && row.status === "active")
            .slice(0, params[1])
            .map((row) => ({ secret_id: row.secret_id })),
        };
      }
      if (/UPDATE secrets SET machine_id=\$1/.test(sql)) {
        const row = rows.get(params[2]);
        if (!row || row.machine_id !== null || row.status !== "active") return { rows: [] };
        row.machine_id = params[0];
        row.updated_at = params[1];
        return { rows: [{ secret_id: row.secret_id }] };
      }
      throw new Error(`unhandled SQL: ${sql}`);
    },
  };
  const vault = createPostgresSecretVault({
    db,
    appSecret: "test-secret",
    idGenerator: () => "secret-a",
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });

  const stored = await vault.createSecret({
    machineId: "worker-a",
    secretType: "mapbox_token",
    label: "primary",
    value: "pk.secret-value",
  });
  const browserSecrets = await vault.listSecretsForBrowser({ machineId: "worker-a" });
  const agentSecrets = await vault.listSecretsForAgent({ machineId: "worker-a" });

  assert.equal(stored.secretId, "secret-a");
  assert.notEqual([...rows.values()][0].encrypted_value, "pk.secret-value");
  assert.equal(browserSecrets[0].redactedValue, "pk.s...alue");
  assert.equal(browserSecrets[0].value, undefined);
  assert.equal(agentSecrets[0].value, "pk.secret-value");
});

test("secret materializer writes env and normalized proxy.txt atomically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-secrets-"));

  const result = await materializeSecrets({
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    secrets: [
      {
        secretType: "mapbox_token",
        label: "primary",
        value: "pk.token-a",
      },
      {
        secretType: "proxy_txt",
        label: "proxy",
        value: "http://a.example:8080, http://b.example:8080\nhttp://c.example:8080",
      },
      {
        secretType: "proxy_txt",
        label: "proxy 2",
        value: "http://d.example:8080",
      },
    ],
  });

  const envFile = await readFile(result.envPath, "utf8");
  const proxyFile = await readFile(path.join(dir, "proxy.txt"), "utf8");

  assert.match(envFile, /MAPBOX_ACCESS_TOKENS=pk\.token-a/);
  assert.equal(
    proxyFile,
    "http://a.example:8080\nhttp://b.example:8080\nhttp://c.example:8080\nhttp://d.example:8080\n"
  );
});
