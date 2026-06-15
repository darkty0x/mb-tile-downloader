import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPgDb } from "./db.js";
import { loadServerConfig } from "./config.js";
import { createPostgresDashboardStore } from "./postgres-store.js";
import { createPostgresSecretVault, createSecretVault } from "./secrets.js";
import { createDashboardStore } from "./store.js";
import { createTelegramNotifier } from "./telegram.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(SERVER_DIR, "../..");
const DEFAULT_CLIENT_DIR = path.join(DASHBOARD_DIR, "src/client/dist");
const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tokenFrom(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "";
}

function requireToken(req, expected) {
  return Boolean(expected) && tokenFrom(req) === expected;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function handleError(res, err) {
  if (/already registered by another live agent/.test(err.message)) {
    json(res, 409, { error: err.message });
    return;
  }
  json(res, 400, { error: err.message });
}

async function serveClient(req, res, clientDir) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(clientDir, `.${requested}`);
  if (!filePath.startsWith(clientDir)) {
    json(res, 403, { error: "forbidden" });
    return true;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME.get(path.extname(filePath)) || "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return false;
  }
}

export function createDashboardApp({
  store = createDashboardStore(),
  secretVault = null,
  telegramNotifier = null,
  agentToken = "",
  adminToken = "",
  clientDir = DEFAULT_CLIENT_DIR,
} = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname.startsWith("/api/agents/")) {
        if (!requireToken(req, agentToken)) {
          json(res, 401, { error: "unauthorized" });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/agents/register") {
          const body = await readJson(req);
          json(res, 200, await store.registerMachine(body));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/agents/heartbeat") {
          const body = await readJson(req);
          json(res, 200, { machine: await store.heartbeatMachine(body) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/agents/events") {
          const body = await readJson(req);
          const event = await store.recordEvent(body);
          const telegram = telegramNotifier ? await telegramNotifier.notifyEvent(event) : null;
          json(res, 200, { event, telegram });
          return;
        }

        const commandPollMatch = /^\/api\/agents\/([^/]+)\/commands\/poll$/.exec(url.pathname);
        if (req.method === "GET" && commandPollMatch) {
          const machineId = decodeURIComponent(commandPollMatch[1]);
          json(res, 200, { commands: await store.claimCommands({ machineId }) });
          return;
        }

        const commandAckMatch = /^\/api\/agents\/commands\/([^/]+)\/ack$/.exec(url.pathname);
        if (req.method === "POST" && commandAckMatch) {
          const body = await readJson(req);
          const commandId = decodeURIComponent(commandAckMatch[1]);
          json(res, 200, {
            command: await store.completeCommand({ commandId, error: body.error || null }),
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/agents/secrets") {
          if (!secretVault) {
            json(res, 200, { secrets: [] });
            return;
          }
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { secrets: await secretVault.listSecretsForAgent({ machineId }) });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/agents/configs") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { configs: await store.listConfigs({ machineId }) });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/agents/env-profiles") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { envProfiles: await store.listEnvProfiles({ machineId }) });
          return;
        }

        json(res, 404, { error: "not found" });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!requireToken(req, adminToken)) {
          json(res, 401, { error: "unauthorized" });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/machines") {
          json(res, 200, { machines: await store.listMachines() });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/events") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { events: await store.listEvents({ machineId }) });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/env-profiles") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { envProfiles: await store.listEnvProfiles({ machineId }) });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/configs") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { configs: await store.listConfigs({ machineId }) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/configs") {
          const body = await readJson(req);
          json(res, 200, { config: await store.createConfig(body) });
          return;
        }

        const configMatch = /^\/api\/configs\/([^/]+)$/.exec(url.pathname);
        if (req.method === "PUT" && configMatch) {
          const body = await readJson(req);
          const configId = decodeURIComponent(configMatch[1]);
          json(res, 200, { config: await store.updateConfig(configId, body) });
          return;
        }
        if (req.method === "DELETE" && configMatch) {
          const configId = decodeURIComponent(configMatch[1]);
          json(res, 200, { config: await store.deleteConfig(configId) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/env-profiles") {
          const body = await readJson(req);
          json(res, 200, { envProfile: await store.createEnvProfile(body) });
          return;
        }

        const envProfileMatch = /^\/api\/env-profiles\/([^/]+)$/.exec(url.pathname);
        if (req.method === "PUT" && envProfileMatch) {
          const body = await readJson(req);
          const envProfileId = decodeURIComponent(envProfileMatch[1]);
          json(res, 200, { envProfile: await store.updateEnvProfile(envProfileId, body) });
          return;
        }
        if (req.method === "DELETE" && envProfileMatch) {
          const envProfileId = decodeURIComponent(envProfileMatch[1]);
          json(res, 200, { envProfile: await store.deleteEnvProfile(envProfileId) });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/secrets") {
          if (!secretVault) {
            json(res, 200, { secrets: [] });
            return;
          }
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { secrets: await secretVault.listSecretsForBrowser({ machineId }) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/secrets") {
          if (!secretVault) throw new Error("secret vault is not configured");
          const body = await readJson(req);
          const secret = await secretVault.createSecret(body);
          json(res, 200, {
            secret: (await secretVault
              .listSecretsForBrowser({ machineId: secret.machineId || undefined }))
              .find((item) => item.secretId === secret.secretId),
          });
          return;
        }

        const secretMatch = /^\/api\/secrets\/([^/]+)$/.exec(url.pathname);
        if (secretMatch) {
          if (!secretVault) throw new Error("secret vault is not configured");
          const secretId = decodeURIComponent(secretMatch[1]);
          if (req.method === "PUT") {
            const body = await readJson(req);
            const secret = await secretVault.updateSecret(secretId, body);
            json(res, 200, {
              secret: (await secretVault
                .listSecretsForBrowser({ machineId: secret.machineId || undefined }))
                .find((item) => item.secretId === secret.secretId),
            });
            return;
          }
          if (req.method === "DELETE") {
            const secret = await secretVault.deleteSecret(secretId);
            json(res, 200, { secretId: secret.secretId });
            return;
          }
        }

        const machineMatch = /^\/api\/machines\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && machineMatch) {
          const machine = await store.getMachine(decodeURIComponent(machineMatch[1]));
          if (!machine) {
            json(res, 404, { error: "not found" });
            return;
          }
          json(res, 200, { machine });
          return;
        }

        const commandMatch = /^\/api\/machines\/([^/]+)\/commands$/.exec(url.pathname);
        if (req.method === "POST" && commandMatch) {
          const body = await readJson(req);
          const machineId = decodeURIComponent(commandMatch[1]);
          json(res, 200, {
            command: await store.queueCommand({
              machineId,
              commandType: body.commandType,
              payload: body.payload || {},
              requestedBy: body.requestedBy || null,
            }),
          });
          return;
        }

        json(res, 404, { error: "not found" });
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        if (await serveClient(req, res, clientDir)) return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      handleError(res, err);
    }
  });
}

export async function createDashboardRuntime({
  config = loadServerConfig(),
  createDb = createPgDb,
  createStoreFromDb = ({ db }) => createPostgresDashboardStore({ db }),
  createSecretVaultFromDb = ({ db, appSecret }) => createPostgresSecretVault({ db, appSecret }),
} = {}) {
  const db = config.databaseUrl ? await createDb({ databaseUrl: config.databaseUrl }) : null;
  const store = db ? createStoreFromDb({ db }) : createDashboardStore();
  const secretVault = config.appSecret
    ? db
      ? createSecretVaultFromDb({ db, appSecret: config.appSecret })
      : createSecretVault({ appSecret: config.appSecret })
    : null;
  const app = createDashboardApp({
    store,
    agentToken: config.agentToken,
    adminToken: config.adminToken,
    secretVault,
    telegramNotifier: createTelegramNotifier(),
  });

  return {
    app,
    store,
    secretVault,
    db,
    async close() {
      if (app.listening) {
        await new Promise((resolve, reject) => {
          app.close((err) => (err ? reject(err) : resolve()));
        });
      }
      if (db?.close) await db.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadServerConfig();
  const { app } = await createDashboardRuntime({ config });
  app.listen(config.port, () => {
    console.log(`dashboard listening on http://127.0.0.1:${config.port}`);
  });
}
