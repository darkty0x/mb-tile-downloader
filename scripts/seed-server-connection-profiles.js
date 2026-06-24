#!/usr/bin/env node
import { createPgDb } from "../dashboard/src/server/db.js";
import { loadServerConfig } from "../dashboard/src/server/config.js";
import { createPostgresSecretVault } from "../dashboard/src/server/secrets.js";

const DEFAULT_PORTS = {
  agent: null,
  rdp: 3389,
  ssh: 22,
  winrm: 5985,
  winrms: 5986,
};

function printUsage(exitCode = 0) {
  console.log([
    "Seed saved server connection profiles into the encrypted dashboard DB.",
    "",
    "Usage:",
    "  node scripts/seed-server-connection-profiles.js --from 1 --to 9",
    "  node scripts/seed-server-connection-profiles.js --from 1 --to 9 --protocol rdp --host-template \"10.0.0.{n}\" --username USER --password PASSWORD",
    "",
    "Options:",
    "  --from N                 First server number. Default: 1",
    "  --to N                   Last server number. Default: 9",
    "  --protocol agent|rdp|ssh|winrm|winrms  Default: agent",
    "  --port N                 Default comes from protocol; ignored for agent",
    "  --label-template TEXT    Default: 봉사기 {n}",
    "  --machine-template TEXT  Default: server-{NN}",
    "  --host-template TEXT     Required for non-agent protocols. Default: {machineId}",
    "  --username USER          Required for non-agent protocols",
    "  --password PASSWORD      Required for non-agent protocols, or set SERVER_CONNECTION_PASSWORD",
    "  --dry-run                Print planned rows without writing",
    "",
    "Template tokens: {n}, {N}, {NN}, {machineId}",
    "Requires DATABASE_URL and APP_SECRET in .env or the Railway environment.",
  ].join("\n"));
  process.exit(exitCode);
}

function parseInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function renderTemplate(template, number, machineId = "") {
  const n = String(number);
  const nn = n.padStart(2, "0");
  return String(template)
    .replaceAll("{machineId}", machineId)
    .replaceAll("{NN}", nn)
    .replaceAll("{N}", n)
    .replaceAll("{n}", n);
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    from: 1,
    to: 9,
    protocol: "agent",
    port: null,
    labelTemplate: "봉사기 {n}",
    machineTemplate: "server-{NN}",
    hostTemplate: "{machineId}",
    username: "",
    password: process.env.SERVER_CONNECTION_PASSWORD || "",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") printUsage(0);
    if (arg === "--from") opts.from = parseInteger(argv[++index], "--from");
    else if (arg.startsWith("--from=")) opts.from = parseInteger(arg.slice("--from=".length), "--from");
    else if (arg === "--to") opts.to = parseInteger(argv[++index], "--to");
    else if (arg.startsWith("--to=")) opts.to = parseInteger(arg.slice("--to=".length), "--to");
    else if (arg === "--protocol") opts.protocol = String(argv[++index] || "").trim().toLowerCase();
    else if (arg.startsWith("--protocol=")) opts.protocol = arg.slice("--protocol=".length).trim().toLowerCase();
    else if (arg === "--port") opts.port = parseInteger(argv[++index], "--port");
    else if (arg.startsWith("--port=")) opts.port = parseInteger(arg.slice("--port=".length), "--port");
    else if (arg === "--label-template") opts.labelTemplate = argv[++index] || "";
    else if (arg.startsWith("--label-template=")) opts.labelTemplate = arg.slice("--label-template=".length);
    else if (arg === "--machine-template") opts.machineTemplate = argv[++index] || "";
    else if (arg.startsWith("--machine-template=")) opts.machineTemplate = arg.slice("--machine-template=".length);
    else if (arg === "--host-template") opts.hostTemplate = argv[++index] || "";
    else if (arg.startsWith("--host-template=")) opts.hostTemplate = arg.slice("--host-template=".length);
    else if (arg === "--username") opts.username = argv[++index] || "";
    else if (arg.startsWith("--username=")) opts.username = arg.slice("--username=".length);
    else if (arg === "--password") opts.password = argv[++index] || "";
    else if (arg.startsWith("--password=")) opts.password = arg.slice("--password=".length);
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Object.hasOwn(DEFAULT_PORTS, opts.protocol)) throw new Error("--protocol must be one of: agent, rdp, ssh, winrm, winrms");
  if (!opts.port && opts.protocol !== "agent") opts.port = DEFAULT_PORTS[opts.protocol];
  if (opts.from > opts.to) throw new Error("--from must be less than or equal to --to");
  if (!String(opts.labelTemplate).trim()) throw new Error("--label-template is required");
  if (!String(opts.machineTemplate).trim()) throw new Error("--machine-template is required");
  if (opts.protocol !== "agent") {
    if (!String(opts.hostTemplate).trim()) throw new Error("--host-template is required");
    if (!String(opts.username).trim()) throw new Error("--username is required");
    if (!String(opts.password).trim()) throw new Error("--password is required or SERVER_CONNECTION_PASSWORD must be set");
  }
  return opts;
}

function buildRows(opts) {
  const rows = [];
  for (let number = opts.from; number <= opts.to; number += 1) {
    const machineId = renderTemplate(opts.machineTemplate, number);
    const label = renderTemplate(opts.labelTemplate, number, machineId);
    const host = renderTemplate(opts.hostTemplate, number, machineId);
    const isAgentProfile = opts.protocol === "agent";
    rows.push({
      label,
      machineId,
      protocolUrl: isAgentProfile ? `agent://${machineId}` : `${opts.protocol}://${host}:${opts.port}`,
      username: isAgentProfile ? "" : opts.username,
      password: isAgentProfile ? "" : opts.password,
    });
  }
  return rows;
}

function findExistingProfile(secrets, row) {
  const label = row.label.toLowerCase();
  const machineId = row.machineId.toLowerCase();
  return secrets.find((secret) => (
    secret.secretType === "server_rdp_credential" &&
    (
      String(secret.label || "").toLowerCase() === label ||
      String(secret.credential?.machineId || "").toLowerCase() === machineId
    )
  ));
}

async function main() {
  const opts = parseArgs();
  const rows = buildRows(opts);
  if (opts.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      rows: rows.map(({ password, ...row }) => ({ ...row, hasPassword: Boolean(password) })),
    }, null, 2));
    return;
  }

  const config = loadServerConfig();
  const databaseUrl = process.env.DATABASE_PUBLIC_URL || config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!config.appSecret) throw new Error("APP_SECRET is required");

  const db = await createPgDb({ databaseUrl });
  try {
    const vault = createPostgresSecretVault({ db, appSecret: config.appSecret });
    const existing = await vault.listSecretsForBrowser();
    const results = [];
    for (const row of rows) {
      const current = findExistingProfile(existing, row);
      const value = JSON.stringify({
        protocolUrl: row.protocolUrl,
        machineId: row.machineId,
        username: row.username,
        password: row.password,
      });
      if (current) {
        await vault.updateSecret(current.secretId, {
          machineId: null,
          label: row.label,
          status: "active",
          value,
        });
        results.push({ action: "updated", secretId: current.secretId, label: row.label, machineId: row.machineId, protocolUrl: row.protocolUrl });
      } else {
        const created = await vault.createSecret({
          machineId: null,
          secretType: "server_rdp_credential",
          label: row.label,
          status: "active",
          value,
        });
        results.push({ action: "created", secretId: created.secretId, label: row.label, machineId: row.machineId, protocolUrl: row.protocolUrl });
      }
    }
    console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
