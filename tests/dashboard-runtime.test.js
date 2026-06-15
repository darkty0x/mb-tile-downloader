import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardRuntime } from "../dashboard/src/server/app.js";

test("dashboard runtime uses postgres store when DATABASE_URL is configured", async () => {
  const calls = [];
  const fakeDb = { close: async () => calls.push("close") };
  const fakeStore = { listMachines: async () => [] };
  const fakeSecretVault = { listSecretsForBrowser: async () => [] };

  const runtime = await createDashboardRuntime({
    config: {
      port: 0,
      databaseUrl: "postgres://example/db",
      agentToken: "agent",
      adminToken: "admin",
      appSecret: "secret",
    },
    createDb: async ({ databaseUrl }) => {
      calls.push(databaseUrl);
      return fakeDb;
    },
    createStoreFromDb: ({ db }) => {
      assert.equal(db, fakeDb);
      return fakeStore;
    },
    createSecretVaultFromDb: ({ db, appSecret }) => {
      assert.equal(db, fakeDb);
      assert.equal(appSecret, "secret");
      return fakeSecretVault;
    },
  });

  assert.equal(calls[0], "postgres://example/db");
  assert.equal(runtime.store, fakeStore);
  assert.equal(runtime.secretVault, fakeSecretVault);
  await runtime.close();
  assert.deepEqual(calls, ["postgres://example/db", "close"]);
});

test("dashboard runtime defaults to in-memory store without DATABASE_URL", async () => {
  const runtime = await createDashboardRuntime({
    config: {
      port: 0,
      databaseUrl: "",
      agentToken: "agent",
      adminToken: "admin",
      appSecret: "secret",
    },
  });

  assert.deepEqual(await runtime.store.listMachines(), []);
  await runtime.close();
});
