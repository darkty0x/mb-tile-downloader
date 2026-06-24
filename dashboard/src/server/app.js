import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPgDb } from "./db.js";
import { loadServerConfig } from "./config.js";
import {
  clearSessionCookie,
  createMemoryAuthStore,
  createPostgresAuthStore,
  sessionTokenFromRequest,
  setSessionCookie,
} from "./auth.js";
import {
  DEFAULT_CONFIG_TEMPLATES_DIR,
  configJobNameForTemplate,
  configNameForTemplate,
  listConfigTemplates,
  slugifyJobName,
  selectConfigTemplates,
  stripTemplateRanges,
} from "./config-templates.js";
import { createPostgresDashboardStore } from "./postgres-store.js";
import { invertTileYRanges, parseConfigRangeInput, summarizeRanges } from "./range-parser.js";
import { createSecretValidator, isValidatableSecretType } from "./secret-validators.js";
import { createPostgresSecretVault, createSecretVault, splitSecretValues } from "./secrets.js";
import { createDashboardStore } from "./store.js";
import { createTelegramNotifier } from "./telegram.js";
import { splitConfigByRows } from "../../../src/config/config-splitter.js";
import { normalizeMachineId } from "../../../src/runtime/machine-id.js";

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
const SERVER_CONNECTION_PROTOCOLS = new Set(["rdp", "ssh", "winrm", "winrms", "agent"]);
const SERVER_CONNECTION_SECRET_TYPE = "server_rdp_credential";
const SERVER_CONNECTION_DEFAULT_PORTS = {
  rdp: 3389,
  ssh: 22,
  winrm: 5985,
  winrms: 5986,
  agent: null,
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function telegramEnvForBrowser() {
  return {
    botTokenConfigured: Boolean(String(process.env.TELEGRAM_BOT_TOKEN || "").trim()),
    chatId: String(process.env.TELEGRAM_CHAT_ID || "").trim(),
  };
}

function settingsForBrowser(settings) {
  return {
    ...settings,
    telegramEnv: telegramEnvForBrowser(),
  };
}

function tokenFrom(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "";
}

function requireToken(req, expected) {
  return Boolean(expected) && tokenFrom(req) === expected;
}

async function sessionUserFromRequest(req, authStore) {
  if (!authStore) return null;
  return authStore.getSessionUser(sessionTokenFromRequest(req));
}

async function requireDashboardSession(req, res, authStore) {
  if (!authStore) return null;
  const user = await sessionUserFromRequest(req, authStore);
  if (!user) {
    json(res, 401, { error: "login required" });
    return null;
  }
  return user;
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
  if (req.method === "GET" && url.pathname === `${basePath}/jobs`) {
    const machineId = url.searchParams.get("machineId") || undefined;
    json(res, 200, { jobs: await store.listJobs({ machineId }) });
    return true;
  }

  if (req.method === "POST" && url.pathname === `${basePath}/jobs/stop-running`) {
    const body = await readJson(req);
    json(res, 200, { jobs: await store.stopRunningJobs(body) });
    return true;
  }

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
    throw new Error("server protocol must be one of: rdp, ssh, winrm, winrms, agent");
  }
  const machineId = normalizeMachineId(body.machineId) || null;
  if (!machineId) throw new Error("server Agent ID is required");
  if (protocol === "agent") {
    return {
      machineId,
      label: String(body.label || machineId).trim(),
      protocol,
      host: machineId,
      port: null,
      username: "",
      password: "",
      protocolUrl: `agent://${machineId}`,
    };
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
    machineId: normalizeMachineId(credential.machineId) || null,
    username: credential.username,
  };
}

async function findMachineById(store, machineId) {
  const normalizedMachineId = normalizeMachineId(machineId);
  if (!normalizedMachineId) return null;
  const direct = await store.getMachine(normalizedMachineId);
  if (direct) return direct;
  const machines = await store.listMachines();
  return machines.find((machine) => normalizeMachineId(machine.machineId) === normalizedMachineId) || null;
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

function parseRequestUrl(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

async function serveClient(req, res, clientDir, url = parseRequestUrl(req)) {
  if (!url) {
    json(res, 400, { error: "invalid request url" });
    return true;
  }
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
    if (path.extname(requested)) return false;
    const indexPath = path.resolve(clientDir, "./index.html");
    const body = await readFile(indexPath);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
    });
    res.end(body);
    return true;
  }
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function importDiscoveredAgentSecrets({ secretVault, machine } = {}) {
  if (!secretVault?.createSecret || !machine?.machineId) return { imported: 0, assigned: 0 };
  const machineId = normalizeMachineId(machine.machineId);
  const snapshot = machine.agentSnapshot || {};
  const discovered = [
    ...uniqueStrings(snapshot.secrets?.mapboxTokens || []).map((value, index) => ({
      secretType: "mapbox_token",
      value,
      label: `${machineId} MAPBOX_ACCESS_TOKENS ${index + 1}`,
    })),
    ...uniqueStrings(snapshot.secrets?.proxy?.values || []).map((value, index) => ({
      secretType: "proxy_txt",
      value,
      label: `${machineId} proxy.txt ${index + 1}`,
    })),
  ];
  let imported = 0;
  let assigned = 0;
  for (const item of discovered) {
    const secret = await secretVault.createSecret({
      machineId,
      secretType: item.secretType,
      label: item.label,
      status: "active",
      value: item.value,
    });
    imported += 1;
    if (!secret.machineId && secretVault.updateSecret) {
      await secretVault.updateSecret(secret.secretId, { machineId });
      assigned += 1;
    } else if (normalizeMachineId(secret.machineId) === machineId) {
      assigned += 1;
    }
  }
  return { imported, assigned };
}

function rootEnvTextFromMachine(machine) {
  const envFile = (machine?.agentSnapshot?.envFiles || []).find((file) => file.path === ".env");
  if (!envFile || envFile.exists === false) return null;
  if (typeof envFile.content === "string") return envFile.content;
  if (Array.isArray(envFile.variables)) {
    return envFile.variables
      .filter((item) => item?.name)
      .map((item) => `${item.name}=${item.value ?? ""}`)
      .join("\n");
  }
  return "";
}

function envTextHasMaskedOrAbbreviatedValue(envText) {
  return String(envText || "")
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      const index = trimmed.indexOf("=");
      if (index === -1) return false;
      const value = trimmed.slice(index + 1).trim();
      return /\*{3,}/.test(value) || /\.{3,}/.test(value);
    });
}

function isUsableRootEnvTemplate(envText) {
  const text = String(envText || "").trim();
  if (!text) return false;
  if (envTextHasMaskedOrAbbreviatedValue(text)) return false;
  return [
    "DASHBOARD_URL",
    "AGENT_TOKEN",
    "STORJ_BUCKET",
    "TILE_DOWNLOADER_OUTPUT_MODE",
    "TILE_DOWNLOADER_OUTPUT_FOLDER",
  ].every((name) => new RegExp(`^${name}=.+$`, "m").test(text));
}

function parseRootEnvTemplate(envText) {
  const text = String(envText || "").trim();
  if (!isUsableRootEnvTemplate(text)) {
    throw new Error("global .env template is missing required values or contains masked values");
  }
  return `${text}\n`;
}

async function rootEnvTemplateFromSettings({ store }) {
  const settings = await store.getSettings();
  if (isUsableRootEnvTemplate(settings.rootEnvTemplate?.envText)) {
    return settings.rootEnvTemplate.envText;
  }
  return null;
}

async function mapboxTokensForMachine({ secretVault, machineId }) {
  if (!secretVault) return [];
  const secrets = await secretVault.listSecretsForAgent({ machineId });
  return uniqueStrings(
    secrets
      .filter((secret) => secret.secretType === "mapbox_token" && secret.status === "active")
      .map((secret) => secret.value)
  );
}

async function rootEnvTextForMachine({ templateText, secretVault, machineId, updates = {} }) {
  const mapboxTokens = await mapboxTokensForMachine({ secretVault, machineId });
  return upsertEnvText(templateText, {
    MACHINE_ID: normalizeMachineId(machineId),
    ...(mapboxTokens.length ? { MAPBOX_ACCESS_TOKENS: mapboxTokens.join(",") } : {}),
    ...updates,
  });
}

async function queueRootEnvWriteCommand({ store, secretVault, machineId, requestedBy, updates = {} }) {
  const templateText = await rootEnvTemplateFromSettings({ store });
  if (!templateText) {
    throw new Error("global .env template is missing or contains masked values");
  }
  const envText = await rootEnvTextForMachine({
    templateText,
    secretVault,
    machineId,
    updates,
  });
  return store.queueCommand({
    machineId,
    commandType: "write_env",
    payload: { envText },
    requestedBy,
  });
}

function quoteEnvValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function upsertEnvText(envText, updates) {
  const remaining = new Map(Object.entries(updates).filter(([, value]) => value !== undefined && value !== null));
  const lines = String(envText || "").split(/\r?\n/);
  const nextLines = lines.map((line) => {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const key = match[1];
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${quoteEnvValue(value)}`;
  });
  for (const [key, value] of remaining.entries()) {
    nextLines.push(`${key}=${quoteEnvValue(value)}`);
  }
  return nextLines.join("\n").replace(/\n{3,}$/g, "\n\n");
}

const ENV_SYNC_JOB_STAGES = new Set(["download", "validate"]);
const ENV_SYNC_JOB_STATUSES = new Set(["queued", "running"]);

async function queueEnvSyncForActiveDownloaders({ store, secretVault, machineIds = [], requestedBy = "secrets.rebalance" } = {}) {
  if (!store?.listJobs || !store?.queueCommand) return { queued: 0, machineIds: [] };
  const targetMachineIds = new Set(uniqueStrings(machineIds).map((machineId) => normalizeMachineId(machineId)));
  const templateText = await rootEnvTemplateFromSettings({ store });
  const jobs = await store.listJobs();
  const queuedMachineIds = [];
  const skipped = [];
  const seen = new Set();
  for (const job of jobs) {
    const machineId = normalizeMachineId(job.machineId);
    if (!machineId || seen.has(machineId)) continue;
    if (targetMachineIds.size && !targetMachineIds.has(machineId)) continue;
    if (!ENV_SYNC_JOB_STATUSES.has(job.status)) continue;
    if (!ENV_SYNC_JOB_STAGES.has(job.stage)) continue;
    if (!templateText) {
      skipped.push({ machineId, reason: "global .env template missing or masked" });
      seen.add(machineId);
      continue;
    }
    const envText = await rootEnvTextForMachine({
      templateText,
      secretVault,
      machineId,
    });
    await store.queueCommand({
      machineId,
      commandType: "write_env",
      payload: { envText, reason: requestedBy },
      requestedBy,
    });
    queuedMachineIds.push(machineId);
    seen.add(machineId);
  }
  return { queued: queuedMachineIds.length, machineIds: queuedMachineIds, skipped };
}

async function rebalanceSecretAssignments({ store, secretVault, machineIds } = {}) {
  if (!secretVault?.rebalanceAssignments) return null;
  const [machines, settings] = await Promise.all([
    store.listMachines(),
    store.getSettings(),
  ]);
  const targetMachineIds = uniqueStrings(machineIds || []);
  return secretVault.rebalanceAssignments({
    machineIds: targetMachineIds.length ? targetMachineIds : machines.map((machine) => machine.machineId),
    targets: {
      mapbox_token: settings.alertThresholds?.mapboxTokensPerServer,
      proxy_txt: settings.alertThresholds?.proxiesPerServer,
    },
  });
}

async function validateExistingPoolSecrets({ secretVault, secretValidator, machineIds = [], secretTypes = ["mapbox_token"], secretIds = [] } = {}) {
  if (!secretVault?.listSecretsForBrowser || !secretVault?.getSecretForDashboard || !secretVault?.updateSecret) {
    return { checked: 0, changed: 0, invalid: 0, invalidSecretIds: [], results: [] };
  }
  const targetMachines = new Set(uniqueStrings(machineIds).map((machineId) => normalizeMachineId(machineId)));
  const targetTypes = new Set(uniqueStrings(secretTypes));
  const targetSecretIds = new Set(uniqueStrings(secretIds));
  const browserSecrets = await secretVault.listSecretsForBrowser();
  let checked = 0;
  let changed = 0;
  let invalid = 0;
  const invalidSecretIds = [];
  const results = [];
  for (const item of browserSecrets) {
    if (!targetTypes.has(item.secretType)) continue;
    if (targetSecretIds.size && !targetSecretIds.has(item.secretId)) continue;
    if (targetMachines.size && !targetMachines.has(normalizeMachineId(item.machineId))) continue;
    const existing = await secretVault.getSecretForDashboard(item.secretId);
    const validation = await validatePoolSecret({
      secretValidator,
      secretType: existing.secretType,
      value: existing.value,
    });
    if (!validation) continue;
    checked += 1;
    if (!validation.ok) {
      invalid += 1;
      invalidSecretIds.push(item.secretId);
    }
    if (validation.status !== item.status) {
      await secretVault.updateSecret(item.secretId, { status: validation.status });
      changed += 1;
    }
    results.push({
      secretId: item.secretId,
      secretType: item.secretType,
      machineId: item.machineId || null,
      ok: validation.ok,
      status: validation.status,
      message: validation.message,
      checkedAt: validation.checkedAt,
    });
  }
  return { checked, changed, invalid, invalidSecretIds, results };
}

async function validatePoolSecret({ secretValidator, secretType, value } = {}) {
  if (!isValidatableSecretType(secretType)) return null;
  if (!secretValidator?.validateSecret) return null;
  const validation = await secretValidator.validateSecret({ secretType, value });
  return {
    ok: Boolean(validation?.ok),
    status: validation?.status || (validation?.ok ? "active" : "invalid"),
    message: validation?.message || (validation?.ok ? "validated" : "validation failed"),
    checkedAt: validation?.checkedAt || new Date().toISOString(),
    ...(validation?.details ? { details: validation.details } : {}),
  };
}

function statusAfterValidation({ requestedStatus, validation } = {}) {
  if (!validation) return requestedStatus;
  if (!validation.ok) return validation.status;
  return requestedStatus || validation.status;
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
  return `${baseName}-${target.label}`;
}

function jobNameForTarget({ baseJobName, target, multipleTargets }) {
  if (!multipleTargets) return baseJobName;
  return `${baseJobName}-${target.splitName}`;
}

function coordinateAreaName(area = {}) {
  const center = area.center || {};
  const latitude = Number(center.latitude);
  const longitude = Number(center.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "Selected Area";
  const latSuffix = latitude < 0 ? "S" : "N";
  const lonSuffix = longitude < 0 ? "W" : "E";
  return `Area ${Math.abs(latitude).toFixed(3)}${latSuffix} ${Math.abs(longitude).toFixed(3)}${lonSuffix}`;
}

function placeNameFromNamedetails(namedetails = {}) {
  return namedetails["_place_name:en"]
    || namedetails["name:en"]
    || namedetails.name
    || "";
}

function placeNameFromAddress(address = {}) {
  return address.city
    || address.city_district
    || address.town
    || address.village
    || address.municipality
    || address.county
    || address.state_district
    || address.state
    || address.region
    || address.island
    || address.country
    || "";
}

export async function defaultLocationResolver({ center } = {}) {
  const latitude = Number(center?.latitude);
  const longitude = Number(center?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || typeof fetch !== "function") return "";
  for (const zoom of [6, 8, 10]) {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("zoom", String(zoom));
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("namedetails", "1");
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "accept-language": "en",
          "user-agent": "mb-tile-downloader-dashboard/1.0",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const name = String(
        placeNameFromNamedetails(payload.namedetails)
        || placeNameFromAddress(payload.address)
        || payload.name
        || payload.display_name
        || ""
      ).trim();
      if (name) return name;
    } catch {
      continue;
    }
  }
  return "";
}

async function inferBaseConfigName({ requestedName, rangeSummary, locationResolver } = {}) {
  const cleanName = String(requestedName || "").trim();
  if (cleanName) return { name: cleanName, inferred: false };
  const area = rangeSummary?.area || null;
  if (!area) return { name: "Selected Area", inferred: false };
  const resolvedName = area && locationResolver
    ? String(await locationResolver(area) || "").trim()
    : "";
  const fallbackName = coordinateAreaName(area);
  return { name: resolvedName || fallbackName, inferred: true };
}

async function resolveMapboxTileRangeName({ parsedInput, locationResolver }) {
  const rangeSummary = summarizeRanges(parsedInput.ranges, { includeArea: true });
  const name = rangeSummary.area && locationResolver
    ? String(await locationResolver(rangeSummary.area) || "").trim()
    : "";
  if (name) {
    return {
      ranges: parsedInput.ranges,
      rangeSummary: {
        ...rangeSummary,
        area: rangeSummary.area ? { ...rangeSummary.area, label: name } : null,
      },
      baseName: { name, inferred: true },
    };
  }

  const repairedRanges = invertTileYRanges(parsedInput.ranges);
  const repairedSummary = summarizeRanges(repairedRanges, { includeArea: true });
  const repairedName = repairedSummary.area && locationResolver
    ? String(await locationResolver(repairedSummary.area) || "").trim()
    : "";
  if (!repairedName) {
    throw new Error("Could not resolve a location name from this Mapbox tile range; enter a name manually.");
  }

  return {
    ranges: repairedRanges,
    rangeSummary: {
      ...repairedSummary,
      area: repairedSummary.area ? { ...repairedSummary.area, label: repairedName } : null,
    },
    baseName: { name: repairedName, inferred: true },
  };
}

async function resolveRangeInputForBatch({ parsedInput, requestedName, locationResolver }) {
  const cleanName = String(requestedName || "").trim();

  if (parsedInput.source !== "tile-ranges") {
    return {
      ranges: parsedInput.ranges,
      rangeSummary: summarizeRanges(parsedInput.ranges, { includeArea: parsedInput.canInferArea }),
      baseName: null,
    };
  }

  if (cleanName) {
    return {
      ranges: parsedInput.ranges,
      rangeSummary: summarizeRanges(parsedInput.ranges, { includeArea: false }),
      baseName: { name: cleanName, inferred: false },
    };
  }

  return resolveMapboxTileRangeName({ parsedInput, locationResolver });
}

function splitStrategyForBatch(body, { templateCount, targetCount } = {}) {
  if (!body.splitAcrossMachines || targetCount < 2) return "none";
  const requested = String(body.splitStrategy || body.splitMode || "").trim();
  if (["ranges", "range"].includes(requested)) return "ranges";
  if (["configTypes", "config-types", "types", "templates"].includes(requested)) return "configTypes";
  return templateCount > 1 ? "configTypes" : "ranges";
}

async function buildConfigDrafts({ store, body, configTemplatesDir, locationResolver = defaultLocationResolver }) {
  const parsedInput = parseConfigRangeInput({
    input: body.rangeInput || body.ranges,
    zoom: body.zoom,
    zoomStart: body.zoomStart,
    zoomEnd: body.zoomEnd,
  });
  const templates = await selectConfigTemplates(body.templateIds, {
    templatesDir: configTemplatesDir,
  });
  const targets = await resolveMachineTargets(store, body);
  if (body.splitAcrossMachines && targets.length < 2) {
    throw new Error("splitAcrossMachines requires at least two machineIds");
  }

  const multipleTemplates = templates.length > 1;
  const multipleTargets = targets.length > 1;
  const splitStrategy = splitStrategyForBatch(body, {
    templateCount: templates.length,
    targetCount: targets.length,
  });
  const rangeResolution = await resolveRangeInputForBatch({
    parsedInput,
    requestedName: body.name,
    locationResolver,
  });
  const parsedRanges = rangeResolution.ranges;
  const rangeSummary = rangeResolution.rangeSummary;
  const baseName = rangeResolution.baseName || await inferBaseConfigName({
    requestedName: body.name,
    rangeSummary,
    locationResolver,
  });
  const drafts = [];

  for (const [templateIndex, template] of templates.entries()) {
    const sourceName = configNameForTemplate({
      baseName: baseName.name,
      template,
      multiple: multipleTemplates,
    });
    const sourceConfig = {
      ...stripTemplateRanges(template.config),
      ranges: structuredClone(parsedRanges),
    };
    sourceConfig.jobName = configJobNameForTemplate({ name: sourceName, template });

    if (splitStrategy === "configTypes") {
      const target = targets[templateIndex % targets.length];
      const name = displayNameForTarget({ baseName: sourceName, target, multipleTargets });
      const config = structuredClone(sourceConfig);
      config.jobName = jobNameForTarget({ baseJobName: sourceConfig.jobName, target, multipleTargets });
      drafts.push({
        machineId: target.machineId,
        machineLabel: target.label,
        templateId: template.id,
        templateLabel: template.label,
        name,
        active: true,
        config,
      });
      continue;
    }

    if (splitStrategy === "ranges") {
      const split = splitConfigByRows(sourceConfig, {
        names: targets.map((target) => target.splitName),
      });
      for (const [targetIndex, target] of targets.entries()) {
        const name = displayNameForTarget({ baseName: sourceName, target, multipleTargets });
        drafts.push({
          machineId: target.machineId,
          machineLabel: target.label,
          templateId: template.id,
          templateLabel: template.label,
          name,
          active: true,
          config: split[targetIndex].config,
        });
      }
      continue;
    }

    const baseJobName = sourceConfig.jobName;
    for (const target of targets) {
      const name = displayNameForTarget({ baseName: sourceName, target, multipleTargets });
      const config = structuredClone(sourceConfig);
      config.jobName = jobNameForTarget({ baseJobName, target, multipleTargets });
      drafts.push({
        machineId: target.machineId,
        machineLabel: target.label,
        templateId: template.id,
        templateLabel: template.label,
        name,
        active: true,
        config,
      });
    }
  }

  return { drafts, rangeSummary, suggestedName: baseName.inferred ? baseName.name : "" };
}

async function createConfigsFromDrafts({ store, drafts }) {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    throw new Error("drafts must include at least one config");
  }
  const machines = await store.listMachines();
  const machineIds = new Set(machines.map((machine) => machine.machineId));
  const configs = [];
  for (const [index, draft] of drafts.entries()) {
    const machineId = draft.machineId || null;
    if (machineId && !machineIds.has(machineId)) throw new Error(`unknown machine id: ${machineId}`);
    if (!draft.config || typeof draft.config !== "object" || Array.isArray(draft.config)) {
      throw new Error(`draft ${index + 1}: config must be an object`);
    }
    configs.push(
      await store.createConfig({
        machineId,
        name: String(draft.name || draft.config.jobName || `dashboard-config-${index + 1}`).trim(),
        active: true,
        config: draft.config,
      })
    );
  }
  return configs;
}

export function createDashboardApp({
  store = createDashboardStore(),
  authStore = null,
  secretVault = null,
  secretValidator = createSecretValidator(),
  telegramNotifier = null,
  locationResolver = defaultLocationResolver,
  agentToken = "",
  clientDir = DEFAULT_CLIENT_DIR,
  configTemplatesDir = DEFAULT_CONFIG_TEMPLATES_DIR,
  healthCheck = null,
  secureCookies = false,
} = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = parseRequestUrl(req);
      if (!url) {
        json(res, 400, { error: "invalid request url" });
        return;
      }

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
          const result = await store.registerMachine(body);
          const discoveredSecrets = await importDiscoveredAgentSecrets({ secretVault, machine: result.machine });
          json(res, 200, { ...result, discoveredSecrets });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/agents/heartbeat") {
          const body = await readJson(req);
          const machine = await store.heartbeatMachine(body);
          const discoveredSecrets = await importDiscoveredAgentSecrets({ secretVault, machine });
          json(res, 200, { machine, discoveredSecrets });
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
          if (
            secretVault?.updateAssignedSecretStatusByValueHash &&
            body.type === "mapbox.token_unusable" &&
            body.machineId &&
            body.data?.tokenHash
          ) {
            secret = await secretVault.updateAssignedSecretStatusByValueHash({
              machineId: body.machineId,
              secretType: "mapbox_token",
              valueHash: body.data.tokenHash,
              status: body.data.status === "exhausted" ? "exhausted" : "invalid",
            });
          }
          if (secret) await rebalanceSecretAssignments({ store, secretVault });
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
          await rebalanceSecretAssignments({ store, secretVault });
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
        if (url.pathname.startsWith("/api/auth/")) {
          if (req.method === "GET" && url.pathname === "/api/auth/me") {
            const user = await sessionUserFromRequest(req, authStore);
            if (!user) {
              json(res, 401, { error: "login required" });
              return;
            }
            json(res, 200, { user });
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/auth/login") {
            if (!authStore) throw new Error("auth store is not configured");
            const body = await readJson(req);
            const user = await authStore.authenticate({
              login: body.login || body.email || body.username,
              password: body.password,
            });
            if (!user) {
              json(res, 401, { error: "invalid login or password" });
              return;
            }
            const session = await authStore.createSession(user.userId);
            setSessionCookie(res, session.token, { secure: secureCookies });
            json(res, 200, { user: session.user });
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/auth/logout") {
            if (authStore) await authStore.deleteSession(sessionTokenFromRequest(req));
            clearSessionCookie(res);
            json(res, 200, { ok: true });
            return;
          }

          if (req.method === "PUT" && url.pathname === "/api/auth/account") {
            if (!authStore) throw new Error("auth store is not configured");
            const user = await requireDashboardSession(req, res, authStore);
            if (!user) return;
            const updated = await authStore.updateUser(user.userId, await readJson(req));
            json(res, 200, { user: updated });
            return;
          }

          json(res, 404, { error: "not found" });
          return;
        }

        const dashboardUser = await requireDashboardSession(req, res, authStore);
        if (authStore && !dashboardUser) return;

        if (req.method === "GET" && url.pathname === "/api/machines") {
          json(res, 200, { machines: await store.listMachines() });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/snapshot") {
          const snapshot = await store.getSnapshot();
          json(res, 200, {
            snapshot: {
              ...snapshot,
              settings: settingsForBrowser(snapshot.settings),
              secretPool: secretVault ? await secretVault.listSecretsForBrowser() : [],
            },
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/settings") {
          json(res, 200, { settings: settingsForBrowser(await store.getSettings()) });
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
          json(res, 200, { settings: settingsForBrowser(await store.updateSettings(body)) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/env/telegram") {
          const body = await readJson(req);
          const botToken = String(body.botToken || "").trim();
          const chatId = String(body.chatId || "").trim();
          if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
          const machines = await store.listMachines();
          const currentSettings = await store.getSettings();
          const templateUpdates = {
            TELEGRAM_BOT_TOKEN: botToken,
            ...(chatId ? { TELEGRAM_CHAT_ID: chatId } : {}),
          };
          const templateText = isUsableRootEnvTemplate(currentSettings.rootEnvTemplate?.envText)
            ? parseRootEnvTemplate(upsertEnvText(currentSettings.rootEnvTemplate.envText, templateUpdates))
            : null;
          if (templateText) {
            await store.updateSettings({
              rootEnvTemplate: {
                ...currentSettings.rootEnvTemplate,
                envText: templateText,
                updatedAt: new Date().toISOString(),
              },
            });
          }
          const queued = [];
          const skipped = [];
          for (const machine of machines) {
            if (!templateText) {
              skipped.push({ machineId: machine.machineId, reason: "canonical .env template missing or masked" });
              continue;
            }
            const nextEnvText = await rootEnvTextForMachine({
              templateText,
              secretVault,
              machineId: machine.machineId,
              updates: templateUpdates,
            });
            const command = await store.queueCommand({
              machineId: machine.machineId,
              commandType: "write_env",
              payload: { envText: nextEnvText },
              requestedBy: "dashboard.telegram-env",
            });
            queued.push({ machineId: machine.machineId, commandId: command.id });
          }
          json(res, 200, { queued, skipped });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/env/global") {
          const body = await readJson(req);
          const templateText = parseRootEnvTemplate(body.envText);
          await store.updateSettings({
            rootEnvTemplate: {
              envText: templateText,
              sourceMachineId: "global",
              updatedAt: new Date().toISOString(),
            },
          });
          const machines = await store.listMachines();
          const queued = [];
          for (const machine of machines) {
            const nextEnvText = await rootEnvTextForMachine({
              templateText,
              secretVault,
              machineId: machine.machineId,
            });
            const command = await store.queueCommand({
              machineId: machine.machineId,
              commandType: "write_env",
              payload: { envText: nextEnvText },
              requestedBy: "dashboard.global-env",
            });
            queued.push({ machineId: machine.machineId, commandId: command.id });
          }
          json(res, 200, { queued, rootEnvTemplate: { updatedAt: new Date().toISOString() } });
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
          if (connection.secretType !== SERVER_CONNECTION_SECRET_TYPE) throw new Error("server connection must be a server credential secret");
          const endpoint = endpointFromCredentialValue(connection.value);
          const targetMachineId = endpoint.machineId || normalizeMachineId(connection.machineId);
          const machine = targetMachineId ? await findMachineById(store, targetMachineId) : null;
          const agent = {
            ok: Boolean(machine && machine.status !== "offline"),
            machineId: machine?.machineId || targetMachineId || null,
            status: machine?.status || "missing",
            lastSeenAt: machine?.lastSeenAt || null,
          };
          const network = endpoint.protocol === "agent"
            ? {
              skipped: true,
              protocol: "agent",
              reason: "agent-only connection profile does not require an inbound public endpoint",
            }
            : await checkTcpEndpoint(endpoint);
          const valid = Boolean((endpoint.protocol === "agent" || network.ok) && agent.ok);
          json(res, 200, {
            valid,
            controlPath: "agent",
            network,
            agent,
            message: valid
              ? "Downloader agent is online for this machine id."
              : endpoint.protocol === "agent"
                ? "Dashboard operation requires the downloader agent to be online for this machine id."
                : "Endpoint was checked, but dashboard operation requires the downloader agent to be online for this machine id.",
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/events") {
          const machineId = url.searchParams.get("machineId") || undefined;
          json(res, 200, { events: await store.listEvents({ machineId }) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/events/read") {
          if (!store.markEventsRead) throw new Error("event read state is not supported");
          const body = await readJson(req);
          const events = await store.markEventsRead({
            machineId: body.machineId || undefined,
            eventIds: Array.isArray(body.eventIds) ? body.eventIds : undefined,
          });
          json(res, 200, { events, count: events.length });
          return;
        }

        if (req.method === "DELETE" && url.pathname === "/api/events") {
          if (!store.deleteEvents) throw new Error("event deletion is not supported");
          const body = await readJson(req);
          const events = await store.deleteEvents({
            machineId: body.machineId || undefined,
            eventIds: Array.isArray(body.eventIds) ? body.eventIds : undefined,
            readState: ["read", "unread"].includes(body.readState) ? body.readState : undefined,
          });
          json(res, 200, { events, count: events.length });
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

        if (req.method === "POST" && url.pathname === "/api/ranges/parse") {
          const body = await readJson(req);
          const parsedInput = parseConfigRangeInput({
            input: body.input,
            zoom: body.zoom,
            zoomStart: body.zoomStart,
            zoomEnd: body.zoomEnd,
          });
          const summary = summarizeRanges(parsedInput.ranges, { includeArea: parsedInput.canInferArea });
          json(res, 200, summary);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/configs") {
          const body = await readJson(req);
          json(res, 200, { config: await store.createConfig(body) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/configs/batch") {
          const body = await readJson(req);
          if (Array.isArray(body.drafts)) {
            const configs = await createConfigsFromDrafts({ store, drafts: body.drafts });
            json(res, 200, { configs });
            return;
          }

          const { drafts, rangeSummary, suggestedName } = await buildConfigDrafts({ store, body, configTemplatesDir, locationResolver });
          if (body.preview) {
            json(res, 200, { drafts, rangeSummary, suggestedName });
            return;
          }
          const configs = await createConfigsFromDrafts({ store, drafts });
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
          const config = await store.deleteConfig(configId);
          let stoppedJobs = [];
          let command = null;
          if (config.machineId) {
            stoppedJobs = await store.stopRunningJobs({
              machineId: config.machineId,
              configId: config.configId,
              error: "config deleted",
            });
            if (stoppedJobs.length) {
              command = await store.queueCommand({
                machineId: config.machineId,
                commandType: "stop_pipeline",
                payload: {
                  configId: config.configId,
                  reason: "config_deleted",
                },
                requestedBy: "config.delete",
              });
            }
          }
          json(res, 200, { config, stoppedJobs, command });
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

        if (req.method === "DELETE" && url.pathname === "/api/secrets") {
          if (!secretVault) throw new Error("secret vault is not configured");
          const body = await readJson(req);
          const secretIds = [...new Set(Array.isArray(body.secretIds) ? body.secretIds : [])].filter(Boolean);
          if (!secretIds.length) throw new Error("secretIds must include at least one secret id");
          const deleted = [];
          for (const secretId of secretIds) {
            const secret = await secretVault.deleteSecret(secretId);
            deleted.push(secret.secretId);
          }
          json(res, 200, { secretIds: deleted });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/secrets/validate") {
          if (!secretVault) throw new Error("secret vault is not configured");
          const body = await readJson(req);
          const secretTypes = body.secretTypes || (body.secretType ? [body.secretType] : ["mapbox_token", "proxy_txt"]);
          const validation = await validateExistingPoolSecrets({
            secretVault,
            secretValidator,
            machineIds: body.machineIds,
            secretTypes,
            secretIds: body.secretIds,
          });
          const result = validation.changed
            ? await rebalanceSecretAssignments({ store, secretVault, machineIds: body.machineIds })
            : null;
          const syncEnv = validation.changed
            ? await queueEnvSyncForActiveDownloaders({
              store,
              secretVault,
              machineIds: body.machineIds,
              requestedBy: "secrets.validate",
            })
            : { queued: 0, skipped: [] };
          json(res, 200, {
            ...(result || { changed: 0, secrets: await secretVault.listSecretsForBrowser() }),
            validation,
            syncEnv,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/secrets/rebalance") {
          if (!secretVault) throw new Error("secret vault is not configured");
          const body = await readJson(req);
          const validation = body.validateExisting
            ? await validateExistingPoolSecrets({
              secretVault,
              secretValidator,
              machineIds: body.machineIds,
              secretTypes: body.secretTypes || ["mapbox_token"],
            })
            : { checked: 0, changed: 0 };
          const result = await rebalanceSecretAssignments({ store, secretVault, machineIds: body.machineIds });
          const syncEnv = await queueEnvSyncForActiveDownloaders({
            store,
            secretVault,
            machineIds: body.machineIds,
            requestedBy: "secrets.rebalance",
          });
          json(res, 200, {
            ...(result || { changed: 0, secrets: await secretVault.listSecretsForBrowser() }),
            validation,
            syncEnv,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/secrets") {
          if (!secretVault) throw new Error("secret vault is not configured");
          const body = await readJson(req);
          const values = splitSecretValues(body.secretType, body.value);
          if (!values.length) throw new Error("secret value is required");
          const created = [];
          const validations = [];
          for (const [index, value] of values.entries()) {
            const validation = await validatePoolSecret({
              secretValidator,
              secretType: body.secretType,
              value,
            });
            if (validation) validations.push({ valueIndex: index, ...validation });
            created.push(await secretVault.createSecret({
              ...body,
              value,
              label: values.length > 1
                ? `${body.label || body.secretType} ${index + 1}`
                : body.label,
              status: statusAfterValidation({ requestedStatus: body.status, validation }),
            }));
          }
          if (["mapbox_token", "proxy_txt"].includes(body.secretType)) {
            const targetMachineIds = uniqueStrings(body.machineIds || []);
            const shouldValidateExisting = body.validateExisting !== false && body.secretType === "mapbox_token";
            if (shouldValidateExisting) {
              await validateExistingPoolSecrets({
                secretVault,
                secretValidator,
                machineIds: targetMachineIds,
                secretTypes: [body.secretType],
              });
            }
            await rebalanceSecretAssignments({ store, secretVault, machineIds: targetMachineIds });
            await queueEnvSyncForActiveDownloaders({
              store,
              secretVault,
              machineIds: targetMachineIds,
              requestedBy: "secrets.create",
            });
          }
          const secret = created[0];
          json(res, 200, {
            secret: (await secretVault
              .listSecretsForBrowser({ machineId: secret.machineId || undefined }))
              .find((item) => item.secretId === secret.secretId),
            secrets: await secretVault.listSecretsForBrowser({ machineId: body.machineId || undefined }),
            validations,
          });
          return;
        }

        const secretValidateMatch = /^\/api\/secrets\/([^/]+)\/validate$/.exec(url.pathname);
        if (req.method === "POST" && secretValidateMatch) {
          if (!secretVault?.getSecretForDashboard) throw new Error("secret vault cannot decrypt dashboard secrets");
          const secretId = decodeURIComponent(secretValidateMatch[1]);
          const existing = await secretVault.getSecretForDashboard(secretId);
          const validation = await validatePoolSecret({
            secretValidator,
            secretType: existing.secretType,
            value: existing.value,
          });
          if (!validation) throw new Error(`${existing.secretType} secrets do not support validation`);
          const updated = await secretVault.updateSecret(secretId, { status: validation.status });
          if (isValidatableSecretType(existing.secretType)) {
            await rebalanceSecretAssignments({ store, secretVault });
          }
          const [secret] = (await secretVault.listSecretsForBrowser({ machineId: updated.machineId || undefined }))
            .filter((item) => item.secretId === updated.secretId);
          json(res, 200, { validation, secret });
          return;
        }

        const secretMatch = /^\/api\/secrets\/([^/]+)$/.exec(url.pathname);
        if (secretMatch) {
          if (!secretVault) throw new Error("secret vault is not configured");
          const secretId = decodeURIComponent(secretMatch[1]);
          if (req.method === "GET") {
            if (!secretVault.getSecretForDashboard) throw new Error("secret vault cannot decrypt dashboard secrets");
            const secret = await secretVault.getSecretForDashboard(secretId);
            if (["credential", SERVER_CONNECTION_SECRET_TYPE, "mapbox_token", "proxy_txt"].includes(secret.secretType)) {
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
            if (body.value !== undefined) {
              const current = await secretVault.getSecretForDashboard(secretId);
              const validation = await validatePoolSecret({
                secretValidator,
                secretType: current.secretType,
                value: body.value,
              });
              if (validation) {
                body.status = statusAfterValidation({
                  requestedStatus: body.status,
                  validation,
                });
              }
            }
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

        const machineJobsMatch = /^\/api\/machines\/([^/]+)\/jobs(?:\/([^/]+))?$/.exec(url.pathname);
        if (req.method === "DELETE" && machineJobsMatch) {
          if (!store.deleteMachineJobs) throw new Error("job deletion is not supported");
          const machineId = decodeURIComponent(machineJobsMatch[1]);
          const jobId = machineJobsMatch[2] ? decodeURIComponent(machineJobsMatch[2]) : null;
          const jobs = await store.deleteMachineJobs({ machineId, jobId });
          json(res, 200, { jobs, count: jobs.length });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/machines/commands") {
          const body = await readJson(req);
          if (body.commandType !== "git_pull_restart") {
            throw new Error("unsupported global command");
          }
          const machines = await store.listMachines();
          const targets = machines.filter((machine) => machine.status !== "offline");
          if (!targets.length) {
            throw new Error("no connected machines are available");
          }
          const commands = await Promise.all(targets.map((machine) => store.queueCommand({
            machineId: machine.machineId,
            commandType: body.commandType,
            payload: body.payload && typeof body.payload === "object" ? body.payload : {},
            requestedBy: body.requestedBy || "dashboard.bulk",
          })));
          json(res, 200, {
            commands,
            count: commands.length,
            machineIds: commands.map((command) => command.machineId),
          });
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
          if (body.commandType === "write_env" && envTextHasMaskedOrAbbreviatedValue(body.payload?.envText)) {
            throw new Error("refusing to queue masked .env values; update the global env template and sync again");
          }
          if (body.commandType === "sync_env") {
            const command = await queueRootEnvWriteCommand({
              store,
              secretVault,
              machineId,
              requestedBy: body.requestedBy || "dashboard.sync-env",
            });
            json(res, 200, { command });
            return;
          }
          let stoppedJobs = [];
          let canceledCommands = [];
          if (body.commandType === "stop_pipeline") {
            const configId = body.payload?.configId || null;
            if (store.stopRunningJobs) {
              stoppedJobs = await store.stopRunningJobs({
                machineId,
                configId,
                error: body.payload?.reason || "dashboard stop requested",
              });
            }
            if (store.cancelPendingRuntimeCommands) {
              canceledCommands = await store.cancelPendingRuntimeCommands({
                machineId,
                reason: "dashboard stop requested",
              });
            }
          }
          const command = await store.queueCommand({
            machineId,
            commandType: body.commandType,
            payload: body.payload || {},
            requestedBy: body.requestedBy || null,
          });
          const machine = body.commandType === "clear_agent_log" && store.clearMachineConsole
            ? await store.clearMachineConsole(machineId)
            : null;
          json(res, 200, {
            command,
            ...(stoppedJobs.length ? { stoppedJobs } : {}),
            ...(canceledCommands.length ? { canceledCommands } : {}),
            ...(machine ? { machine } : {}),
          });
          return;
        }

        json(res, 404, { error: "not found" });
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        if (await serveClient(req, res, clientDir, url)) return;
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
  createAuthStoreFromDb = ({ db }) => createPostgresAuthStore({ db }),
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
  const authStore = db ? createAuthStoreFromDb({ db }) : createMemoryAuthStore();
  await authStore.seedDefaultAdmin();
  const secretVault = config.appSecret
    ? db
      ? createSecretVaultFromDb({ db, appSecret: config.appSecret })
      : createSecretVault({ appSecret: config.appSecret })
    : null;
  const app = createDashboardApp({
    store,
    authStore,
    agentToken: config.agentToken,
    secretVault,
    telegramNotifier: createTelegramNotifier(),
    secureCookies: config.nodeEnv === "production",
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
    authStore,
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
