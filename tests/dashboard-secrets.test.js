import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPostgresSecretVault, createSecretVault } from "../dashboard/src/server/secrets.js";
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
      if (/SELECT \* FROM secrets WHERE machine_id=\$1/.test(sql)) {
        return {
          rows: [...rows.values()].filter((row) => row.machine_id === params[0]),
        };
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
    ],
  });

  const envFile = await readFile(result.envPath, "utf8");
  const proxyFile = await readFile(path.join(dir, "proxy.txt"), "utf8");

  assert.match(envFile, /MAPBOX_ACCESS_TOKENS=pk\.token-a/);
  assert.equal(
    proxyFile,
    "http://a.example:8080\nhttp://b.example:8080\nhttp://c.example:8080\n"
  );
});
