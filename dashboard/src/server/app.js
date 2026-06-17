import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPgDb } from "./db.js";
import { loadServerConfig } from "./config.js";
import {
  DEFAULT_CONFIG_TEMPLATES_DIR,
  configJobNameForTemplate,
  configNameForTemplate,
  listConfigTemplates,
  slugifyJobName,
  selectConfigTemplates,
} from "./config-templates.js";
import { createPostgresDashboardStore } from "./postgres-store.js";
import { createPostgresSecretVault, createSecretVault, splitSecretValues } from "./secrets.js";
import { createDashboardStore } from "./store.js";
import { createTelegramNotifier } from "./telegram.js";
import { splitConfigByRows } from "../../../src/config/config-splitter.js";

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
const SERVER_CONNECTION_PROTOCOLS = new Set(["rdp", "ssh", "winrm", "winrms"]);
const SERVER_CONNECTION_SECRET_TYPE = "server_rdp_credential";
const SERVER_CONNECTION_DEFAULT_PORTS = {
  rdp: 3389,
  ssh: 22,
  winrm: 5985,
  winrms: 5986,
};

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

async function handleAgentJobRoute({ req, res, url, store, basePath }) {
  if (req.method === "POST" && url.pathname === `${basePath}/jobs`) {
    const body = await readJson(req);
    json(res, 200, { job: await store.upsertJob(body) });
    return true;
  }

  const agentJobMatch = new RegExp(`^${basePath}/jobs/([^/]+)$`).exec(url.pathname);
  if (req.method === "PUT" && agentJobMatch) {
    const body = await readJson(req);
    const jobId = decodeURIComponent(agentJobMatch[1]);
    json(res, 200, { job: await store.upsertJob({ ...body, jobId }) });
    return true;
  }

  return false;
}

function normalizeServerConnectionInput(body = {}) {
  const protocol = String(body.protocol || "rdp").trim().toLowerCase().replace(/:$/, "");
  if (!SERVER_CONNECTION_PROTOCOLS.has(protocol)) {
    throw new Error("server protocol must be one of: rdp, ssh, winrm, winrms");
  }
  const host = String(body.host || "").trim();
  if (!host) throw new Error("server host is required");
  const port = body.port === undefined || body.port === ""
    ? SERVER_CONNECTION_DEFAULT_PORTS[protocol]
    : Number.parseInt(body.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("server port must be between 1 and 65535");
  }
  const username = String(body.username || "").trim();
  if (!username) throw new Error("server username is required");
  const password = String(body.password || "");
  if (!password.trim()) throw new Error("server password is required");
  const machineId = String(body.machineId || "").trim() || null;
  return {
    machineId,
    label: String(body.label || machineId || `${host}:${port}`).trim(),
    protocol,
    host,
    port,
    username,
    password,
    protocolUrl: `${protocol}://${host}:${port}`,
  };
}

function endpointFromCredentialValue(value) {
  const credential = JSON.parse(value);
  const url = new URL(credential.protocolUrl);
  const protocol = url.protocol.slice(0, -1);
  return {
    protocol,
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : SERVER_CONNECTION_DEFAULT_PORTS[protocol],
    machineId: String(credential.machineId || "").trim() || null,
    username: credential.username,
  };
}

function checkTcpEndpoint({ host, port, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ok,
        host,
        port,
        latencyMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "connection timed out"));
    socket.once("error", (err) => finish(false, err.message));
  });
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

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function resolveMachineTargets(store, body) {
  const requestedIds = uniqueStrings(Array.isArray(body.machineIds) ? body.machineIds : [body.machineId]);
  if (requestedIds.length === 0) return [{ machineId: null, label: "Global", splitName: "global" }];

  const machines = await store.listMachines();
  const byId = new Map(machines.map((machine) => [machine.machineId, machine]));
  return requestedIds.map((machineId) => {
    const machine = byId.get(machineId);
    if (!machine) throw new Error(`unknown machine id: ${machineId}`);
    return {
      machineId,
      label: machine.displayName || machineId,
      splitName: slugifyJobName(machineId),
    };
  });
}

function displayNameForTarget({ baseName, target, multipleTargets }) {
  if (!multipleTargets) return baseName;
  return `${baseName} - ${target.label}`;
}

function jobNameForTarget({ baseJobName, target, multipleTargets }) {
  if (!multipleTargets) return baseJobName;
  return `${baseJobName}-${target.splitName}`;
}

export function createDashboardApp({
  store = createDashboardStore(),
  secretVault = null,
  telegramNotifier = null,
  agentToken = "",
  clientDir = DEFAULT_CLIENT_DIR,
  configTemplatesDir = DEFAULT_CONFIG_TEMPLATES_DIR,
  healthCheck = null,
} = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const health = healthCheck ? await healthCheck() : { ok: true };
        json(res, health.ok === false ? 503 : 200, health);
        return;
      }

      if (url.pathname.startsWith("/api/agent/")) {
        if (!requireToken(req, agentToken)) {
          json(res, 401, { error: "unauthorized" });
          return;
        }

        if (await handleAgentJobRoute({ req, res, url, store, basePath: "/api/agent" })) {
          return;
        }

        json(res, 404, { error: "not found" });
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
          let secret = null;
          if (
            secretVault?.updateAssignedSecretStatusByValueHash &&
            body.type === "proxy.blocked" &&
            body.machineId &&
            body.data?.proxyHash
          ) {
            secret = await secretVault.updateAssignedSecretStatusByValueHash({
              machineId: body.machineId,
              secretType: "proxy_txt",
              valueHash: body.data.proxyHash,
              status: body.data.status === "disabled" ? "disabled" : "error",
            });
          }
          const telegram = telegramNotifier ? await telegramNotifier.notifyEvent(event, await store.getSettings()) : null;
          json(res, 200, { event, telegram, ...(secret ? { secret } : {}) });
          return;
        }

        if (await handleAgentJobRoute({ req, res, url, store, basePath: "/api/agents" })) {
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
            command: await store.completeCommand({
              commandId,
              error: body.error || null,
              claimedAt: body.claimedAt || null,
            }),
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
        if (req.method === "GET" && url.pathname === "/api/machines") {
          json(res, 200, { machines: await store.listMachines() });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/snapshot") {
          const snapshot = await store.getSnapshot();
          json(res, 200, {
            snapshot: {
              ...snapshot,
              secretPool: secretVault ? await secretVault.listSecretsForBrowser() : [],
            },
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/settings") {
          json(res, 200, { settings: await store.getSettings() });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/agent-setup") {
          json(res, 200, {
            agentTokenConfigured: Boolean(agentToken),
            agentToken,
          });
          return;
        }

        if (req.method === "PUT" && url.pathname === "/api/settings") {
          const body = await readJson(req);
          json(res, 200, { settings: await store.updateSettings(body) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/server-connections") {
          if (!secretVault) throw new Error("secret vault is not configured");
          const connection = normalizeServerConnectionInput(await readJson(req));
          const secret = await secretVault.createSecret({
            machineId: null,
            secretType: SERVER_CONNECTION_SECRET_TYPE,
            label: connection.label,
            status: "active",
            value: JSON.stringify({
              protocolUrl: connection.protocolUrl,
              machineId: connection.machineId,
              username: connection.username,
              password: connection.password,
            }),
          });
          const browserConnection = (await secretVault.listSecretsForBrowser())
            .find((item) => item.secretId === secret.secretId);
          json(res, 200, { connection: browserConnection });
          return;
        }

        const serverConnectionValidateMatch = /^\/api\/server-connections\/([^/]+)\/validate$/.exec(url.pathname);
        if (req.method === "POST" && serverConnectionValidateMatch) {
          if (!secretVault?.getSecretForDashboard) throw new Error("secret vault is not configured");
          const secretId = decodeURIComponent(serverConnectionValidateMatch[1]);
          const connection = await secretVault.getSecretForDashboard(secretId);
          if (!["credential", SERVER_CONNECTION_SECRET_TYPE].includes(connection.secretType)) throw new Error("server connection must be a server credential secret");
          const endpoint = endpointFromCredentialValue(connection.value);
          const network = await checkTcpEndpoint(endpoint);
          const targetMachineId = endpoint.machineId || connection.machineId;
          const machine = targetMachineId ? await store.getMachine(targetMachineId) : null;
          const agent = {
            ok: Boolean(machine && machine.status !== "offline"),
            machineId: targetMachineId || null,
            status: machine?.status || "missing",
            lastSeenAt: machine?.lastSeenAt || null,
          };
          const valid = Boolean(network.ok && agent.ok);
          json(res, 200, {
            valid,
            controlPath: "agent",
            network,
            agent,
            message: valid
              ? "Endpoint is reachable and the downloader agent is online."
              : "Endpoint was checked, but dashboard operation requires the downloader agent to be online for this machine id.",
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/events") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { events: await store.listEvents({ machineId }) });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/jobs") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { jobs: await store.listJobs({ machineId }) });
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

        if (req.method === "GET" && url.pathname === "/api/config-templates") {
          json(res, 200, {
            templates: await listConfigTemplates({ templatesDir: configTemplatesDir }),
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/configs") {
          const body = await readJson(req);
          json(res, 200, { config: await store.createConfig(body) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/configs/batch") {
          const body = await readJson(req);
          const templates = await selectConfigTemplates(body.templateIds, {
            templatesDir: configTemplatesDir,
          });
          const targets = await resolveMachineTargets(store, body);
          if (body.splitAcrossMachines && targets.length < 2) {
            throw new Error("splitAcrossMachines requires at least two machineIds");
          }
          const multipleTemplates = templates.length > 1;
          const multipleTargets = targets.length > 1;
          const splitAcrossMachines = Boolean(body.splitAcrossMachines) && multipleTargets;
          const configs = [];
          for (const [index, template] of templates.entries()) {
            const sourceName = configNameForTemplate({
              baseName: body.name,
              template,
              multiple: multipleTemplates,
            });
            const sourceConfig = structuredClone(template.config);
            sourceConfig.jobName = configJobNameForTemplate({ name: sourceName, template });
            if (splitAcrossMachines) {
              const split = splitConfigByRows(sourceConfig, {
                names: targets.map((target) => target.splitName),
              });
              for (const [targetIndex, target] of targets.entries()) {
                configs.push(
                  await store.createConfig({
                    machineId: target.machineId,
                    name: displayNameForTarget({ baseName: sourceName, target, multipleTargets }),
                    active: Boolean(body.active) && index === 0,
                    config: split[targetIndex].config,
                  })
                );
              }
              continue;
            }

            const baseJobName = sourceConfig.jobName;
            for (const target of targets) {
              const name = displayNameForTarget({ baseName: sourceName, target, multipleTargets });
              const config = structuredClone(sourceConfig);
              config.jobName = jobNameForTarget({ baseJobName, target, multipleTargets });
              configs.push(
                await store.createConfig({
                  machineId: target.machineId,
                  name,
                  active: Boolean(body.active) && index === 0,
                  config,
                })
              );
            }
          }
          json(res, 200, { configs });
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
          const values = splitSecretValues(body.secretType, body.value);
          if (!values.length) throw new Error("secret value is required");
          const created = [];
          for (const [index, value] of values.entries()) {
            created.push(await secretVault.createSecret({
              ...body,
              value,
              label: values.length > 1
                ? `${body.label || body.secretType} ${index + 1}`
                : body.label,
            }));
          }
          const secret = created[0];
          json(res, 200, {
            secret: (await secretVault
              .listSecretsForBrowser({ machineId: secret.machineId || undefined }))
              .find((item) => item.secretId === secret.secretId),
            secrets: await secretVault.listSecretsForBrowser({ machineId: body.machineId || undefined }),
          });
          return;
        }

        const secretMatch = /^\/api\/secrets\/([^/]+)$/.exec(url.pathname);
        if (secretMatch) {
          if (!secretVault) throw new Error("secret vault is not configured");
          const secretId = decodeURIComponent(secretMatch[1]);
          if (req.method === "GET") {
            if (!secretVault.getSecretForDashboard) throw new Error("secret vault cannot decrypt dashboard secrets");
            const secret = await secretVault.getSecretForDashboard(secretId);
            if (["credential", SERVER_CONNECTION_SECRET_TYPE].includes(secret.secretType)) {
              json(res, 200, { secret });
              return;
            }
            const browserSecret = (await secretVault.listSecretsForBrowser({ machineId: secret.machineId || undefined }))
              .find((item) => item.secretId === secret.secretId);
            json(res, 200, { secret: browserSecret });
            return;
          }
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
        if (req.method === "DELETE" && machineMatch) {
          const machineId = decodeURIComponent(machineMatch[1]);
          if (secretVault) {
            const assignedSecrets = await secretVault.listSecretsForBrowser({ machineId });
            await Promise.all(
              assignedSecrets.map((secret) => secretVault.updateSecret(secret.secretId, { machineId: null }))
            );
          }
          json(res, 200, { machine: await store.deleteMachine(machineId) });
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
  const dashboardStore = config.dashboardStore || "postgres";
  if (!["postgres", "memory"].includes(dashboardStore)) {
    throw new Error("DASHBOARD_STORE must be one of: postgres, memory");
  }

  if (dashboardStore === "postgres" && !config.databaseUrl) {
    throw new Error("DATABASE_URL is required unless DASHBOARD_STORE=memory");
  }

  const db = dashboardStore === "postgres"
    ? await createDb({ databaseUrl: config.databaseUrl })
    : null;
  const store = db ? createStoreFromDb({ db }) : createDashboardStore();
  const secretVault = config.appSecret
    ? db
      ? createSecretVaultFromDb({ db, appSecret: config.appSecret })
      : createSecretVault({ appSecret: config.appSecret })
    : null;
  const app = createDashboardApp({
    store,
    agentToken: config.agentToken,
    secretVault,
    telegramNotifier: createTelegramNotifier(),
    healthCheck: db
      ? async () => {
          await db.query("SELECT 1");
          return { ok: true, store: "postgres", database: "ok" };
        }
      : () => ({ ok: true, store: "memory", database: "disabled" }),
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
