import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SECRET_POOL_TARGETS, createPostgresSecretVault, createSecretVault } from "../dashboard/src/server/secrets.js";
import { materializeSecrets } from "../src/agent/secret-materializer.js";

test("secret vault encrypts plaintext and exposes resource values to dashboard admins", () => {
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
  assert.equal(browserSecrets[0].value, "pk.secret-value");
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

test("browser proxy secrets expose endpoint display name and full admin value", () => {
  const vault = createSecretVault({ appSecret: "test-secret" });
  vault.createSecret({
    machineId: "worker-a",
    secretType: "proxy_txt",
    label: "proxy uuid label",
    value: "http://user:pass@65.111.31.179:3129",
  });

  const browserSecrets = vault.listSecretsForBrowser({ machineId: "worker-a" });

  assert.equal(browserSecrets[0].displayName, "65.111.31.179:3129");
  assert.equal(browserSecrets[0].value, "http://user:pass@65.111.31.179:3129");
});

test("credential secrets expose browser metadata without the password", () => {
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => "credential-a",
  });
  const value = JSON.stringify({
    protocolUrl: "https://ap1.storj.io",
    username: "operator@example.com",
    password: "very-secret-password",
  });

  const stored = vault.createSecret({
    secretType: "credential",
    label: "Storj",
    value,
  });
  const browserSecrets = vault.listSecretsForBrowser();
  const agentSecrets = vault.listSecretsForAgent();

  assert.notEqual(stored.encryptedValue, value);
  assert.equal(browserSecrets[0].secretType, "credential");
  assert.deepEqual(browserSecrets[0].credential, {
    protocolUrl: "https://ap1.storj.io",
    protocol: "https",
    host: "ap1.storj.io",
    port: 443,
    username: "operator@example.com",
    hasPassword: true,
  });
  assert.equal(browserSecrets[0].redactedValue, "operator@example.com @ ap1.storj.io");
  assert.equal(JSON.stringify(browserSecrets).includes("very-secret-password"), false);
  assert.equal(agentSecrets[0].value, value);
});

test("server credential secrets support server connection protocols", () => {
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => "credential-rdp",
  });

  vault.createSecret({
    machineId: "server-01",
    secretType: "server_rdp_credential",
    label: "Server 01 RDP",
    value: JSON.stringify({
      protocolUrl: "rdp://203.0.113.10:7777",
      machineId: "server-01",
      username: "root",
      password: "server-password",
    }),
  });

  const [credential] = vault.listSecretsForBrowser({ machineId: "server-01" });

  assert.equal(credential.secretId, "credential-rdp");
  assert.deepEqual(credential.credential, {
    protocolUrl: "rdp://203.0.113.10:7777",
    protocol: "rdp",
    host: "203.0.113.10",
    port: 7777,
    machineId: "server-01",
    username: "root",
    hasPassword: true,
  });
  assert.equal(JSON.stringify(credential).includes("server-password"), false);
});

test("generic credentials are standalone even for remote protocols", () => {
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => "credential-ssh",
  });

  vault.createSecret({
    secretType: "credential",
    label: "PowerVPS",
    value: JSON.stringify({
      protocolUrl: "ssh://203.0.113.10:22",
      username: "root",
      password: "server-password",
    }),
  });

  const [credential] = vault.listSecretsForBrowser();

  assert.equal(credential.secretId, "credential-ssh");
  assert.equal(credential.secretType, "credential");
  assert.equal(credential.targetMachineId, undefined);
  assert.equal(credential.credential.machineId, undefined);
});

test("dashboard can read an encrypted server credential for server validation", () => {
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => "credential-rdp",
  });
  vault.createSecret({
    machineId: "server-01",
    secretType: "server_rdp_credential",
    label: "Server 01 RDP",
    value: JSON.stringify({
      protocolUrl: "rdp://203.0.113.10:7777",
      machineId: "server-01",
      username: "root",
      password: "server-password",
    }),
  });

  const credential = vault.getSecretForDashboard("credential-rdp");

  assert.equal(credential.machineId, "server-01");
  assert.equal(JSON.parse(credential.value).password, "server-password");
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

test("secret pool rebalance assigns new resources to the least-filled machines", () => {
  let id = 0;
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
  });
  for (let index = 1; index <= 5; index++) {
    vault.createSecret({
      secretType: "proxy_txt",
      label: `proxy-${index}`,
      value: `http://proxy-${index}.example:8080`,
    });
  }
  for (let index = 1; index <= 2; index++) {
    vault.createSecret({
      secretType: "mapbox_token",
      label: `mapbox-${index}`,
      value: `pk.token-${index}`,
    });
  }

  const result = vault.rebalanceAssignments({
    machineIds: ["worker-a", "worker-b", "worker-c"],
    targets: { proxy_txt: 2, mapbox_token: 1 },
  });
  const browserSecrets = vault.listSecretsForBrowser();
  const proxyCounts = Object.fromEntries(["worker-a", "worker-b", "worker-c"].map((machineId) => [
    machineId,
    browserSecrets.filter((secret) => secret.secretType === "proxy_txt" && secret.machineId === machineId).length,
  ]));
  const mapboxCounts = Object.fromEntries(["worker-a", "worker-b", "worker-c"].map((machineId) => [
    machineId,
    browserSecrets.filter((secret) => secret.secretType === "mapbox_token" && secret.machineId === machineId).length,
  ]));

  assert.equal(result.changed, 7);
  assert.deepEqual(proxyCounts, { "worker-a": 2, "worker-b": 2, "worker-c": 1 });
  assert.deepEqual(mapboxCounts, { "worker-a": 1, "worker-b": 1, "worker-c": 0 });
});

test("secret pool rebalance distributes all active pool items fairly", () => {
  let id = 0;
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => `secret-${++id}`,
  });
  for (let index = 1; index <= 10; index++) {
    vault.createSecret({
      secretType: "proxy_txt",
      label: `proxy-${index}`,
      value: `http://proxy-${index}.example:8080`,
    });
  }

  const result = vault.rebalanceAssignments({
    machineIds: ["worker-a", "worker-b", "worker-c"],
    targets: { proxy_txt: 2, mapbox_token: 1 },
  });
  const browserSecrets = vault.listSecretsForBrowser();
  const counts = ["worker-a", "worker-b", "worker-c"].map((machineId) =>
    browserSecrets.filter((secret) => secret.secretType === "proxy_txt" && secret.machineId === machineId).length
  );

  assert.equal(result.changed, 10);
  assert.deepEqual(counts.sort((a, b) => a - b), [3, 3, 4]);
  assert.equal(browserSecrets.filter((secret) => secret.secretType === "proxy_txt" && secret.usage === "available").length, 0);
});

test("secret vault marks an assigned proxy unavailable by runtime-normalized value hash", () => {
  const vault = createSecretVault({
    appSecret: "test-secret",
    idGenerator: () => "proxy-a",
    now: () => new Date("2026-06-16T00:00:00.000Z"),
  });
  vault.createSecret({
    machineId: "worker-a",
    secretType: "proxy_txt",
    label: "proxy-a",
    value: "proxy-a.example:8080",
  });

  const proxyHash = createHash("sha256").update("http://proxy-a.example:8080").digest("hex");
  const updated = vault.updateAssignedSecretStatusByValueHash({
    machineId: "worker-a",
    secretType: "proxy_txt",
    valueHash: proxyHash,
    status: "error",
  });

  assert.equal(updated.secretId, "proxy-a");
  assert.equal(updated.status, "error");
  assert.deepEqual(vault.listSecretsForAgent({ machineId: "worker-a" }), []);
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

test("postgres secret vault persists encrypted rows and exposes admin resource values", async () => {
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
  assert.equal(browserSecrets[0].value, "pk.secret-value");
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

test("secret materializer clears stale proxy.txt when server assigns no proxies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-secrets-clear-"));
  await writeFile(path.join(dir, "proxy.txt"), "http://stale.example:8080\n", "utf8");

  const result = await materializeSecrets({
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    secrets: [],
  });

  assert.equal(result.proxyPath, path.join(dir, "proxy.txt"));
  assert.equal(await readFile(path.join(dir, "proxy.txt"), "utf8"), "");
});

test("secret materializer preserves local proxy.txt when dashboard assigns no proxies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-secrets-preserve-"));
  await writeFile(path.join(dir, "proxy.txt"), "http://local.example:8080\n", "utf8");

  const result = await materializeSecrets({
    projectDir: dir,
    stateDir: path.join(dir, ".tile-state"),
    secrets: [],
    preserveLocalProxyWhenUnassigned: true,
  });

  assert.equal(result.proxyPath, null);
  assert.equal(result.proxyCount, 0);
  assert.equal(await readFile(path.join(dir, "proxy.txt"), "utf8"), "http://local.example:8080\n");
});
