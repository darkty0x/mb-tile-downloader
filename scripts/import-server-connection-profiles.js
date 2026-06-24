#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createPgDb } from "../dashboard/src/server/db.js";
import { loadServerConfig } from "../dashboard/src/server/config.js";
import { createPostgresSecretVault } from "../dashboard/src/server/secrets.js";

function printUsage(exitCode = 0) {
  console.log([
    "Import real server connection profiles into the encrypted dashboard DB.",
    "",
    "Input format:",
    "  #01 (1TB)",
    "  IP: 95.216.247.19:7777",
    "  Username: root",
    "  Password: ...",
    "",
    "Usage:",
    "  pbpaste | node --env-file-if-exists=.env scripts/import-server-connection-profiles.js --dry-run",
    "  pbpaste | node --env-file-if-exists=.env scripts/import-server-connection-profiles.js",
    "  node --env-file-if-exists=.env scripts/import-server-connection-profiles.js --input servers.txt --protocol ssh",
    "",
    "Options:",
    "  --input PATH              Read from file instead of stdin",
    "  --protocol ssh|rdp|winrm|winrms  Default: ssh",
    "  --label-template TEXT     Default: 봉사기 {n}",
    "  --machine-template TEXT   Default: server-{NN}",
    "  --dry-run                 Print planned rows without writing",
    "",
    "Requires DATABASE_URL and APP_SECRET in .env or the Railway environment.",
  ].join("\n"));
  process.exit(exitCode);
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
    input: "",
    protocol: "ssh",
    labelTemplate: "봉사기 {n}",
    machineTemplate: "server-{NN}",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") printUsage(0);
    if (arg === "--input") opts.input = argv[++index] || "";
    else if (arg.startsWith("--input=")) opts.input = arg.slice("--input=".length);
    else if (arg === "--protocol") opts.protocol = String(argv[++index] || "").trim().toLowerCase();
    else if (arg.startsWith("--protocol=")) opts.protocol = arg.slice("--protocol=".length).trim().toLowerCase();
    else if (arg === "--label-template") opts.labelTemplate = argv[++index] || "";
    else if (arg.startsWith("--label-template=")) opts.labelTemplate = arg.slice("--label-template=".length);
    else if (arg === "--machine-template") opts.machineTemplate = argv[++index] || "";
    else if (arg.startsWith("--machine-template=")) opts.machineTemplate = arg.slice("--machine-template=".length);
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["ssh", "rdp", "winrm", "winrms"].includes(opts.protocol)) {
    throw new Error("--protocol must be one of: ssh, rdp, winrm, winrms");
  }
  if (!String(opts.labelTemplate).trim()) throw new Error("--label-template is required");
  if (!String(opts.machineTemplate).trim()) throw new Error("--machine-template is required");
  return opts;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function parseServerConnectionText(text, {
  protocol = "ssh",
  labelTemplate = "봉사기 {n}",
  machineTemplate = "server-{NN}",
} = {}) {
  const rows = [];
  const blocks = String(text || "").split(/(?=^#\d+)/m).map((block) => block.trim()).filter(Boolean);
  for (const block of blocks) {
    const numberMatch = /^#\s*(\d+)/m.exec(block);
    const ipMatch = /^IP:\s*([^\s:]+):(\d+)\s*$/mi.exec(block);
    const usernameMatch = /^Username:\s*(.+?)\s*$/mi.exec(block);
    const passwordMatch = /^Password:\s*(.+?)\s*$/mi.exec(block);
    if (!numberMatch || !ipMatch || !usernameMatch || !passwordMatch) {
      throw new Error(`invalid server credential block: ${block.split(/\r?\n/)[0] || "unknown"}`);
    }
    const number = Number.parseInt(numberMatch[1], 10);
    const machineId = renderTemplate(machineTemplate, number);
    const host = ipMatch[1];
    const port = Number.parseInt(ipMatch[2], 10);
    rows.push({
      number,
      label: renderTemplate(labelTemplate, number, machineId),
      machineId,
      protocolUrl: `${protocol}://${host}:${port}`,
      host,
      port,
      username: usernameMatch[1].trim(),
      password: passwordMatch[1],
    });
  }
  return rows.sort((a, b) => a.number - b.number);
}

function findExistingProfile(secrets, row) {
  const label = row.label.toLowerCase();
  const machineId = row.machineId.toLowerCase();
  return secrets.find((secret) => (
    secret.secretType === "server_rdp_credential" &&
    (
      String(secret.label || "").toLowerCase() === label ||
      String(secret.credential?.machineId || "").toLowerCase() === machineId ||
      String(secret.targetMachineId || "").toLowerCase() === machineId
    )
  ));
}

export function redactImportRows(rows = []) {
  return rows.map(({ password, ...row }) => ({
    ...row,
    hasPassword: Boolean(password),
  }));
}

async function main() {
  const opts = parseArgs();
  const input = opts.input ? await readFile(opts.input, "utf8") : await readStdin();
  const rows = parseServerConnectionText(input, opts);
  if (opts.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, rows: redactImportRows(rows) }, null, 2));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
