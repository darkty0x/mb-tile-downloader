#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createPgDb } from "../dashboard/src/server/db.js";
import { loadServerConfig } from "../dashboard/src/server/config.js";
import { createPostgresSecretVault } from "../dashboard/src/server/secrets.js";

function printUsage(exitCode = 0) {
  console.log([
    "Repair saved server connection profiles in the encrypted dashboard DB.",
    "",
    "By default this converts 봉사기 1..10 / server-01..server-10 profiles to PC agent-only credentials.",
    "",
    "Usage:",
    "  node --env-file-if-exists=.env scripts/repair-server-connection-profiles.js --dry-run",
    "  node --env-file-if-exists=.env scripts/repair-server-connection-profiles.js",
    "  node --env-file-if-exists=.env scripts/repair-server-connection-profiles.js --from 1 --to 9",
    "",
    "Options:",
    "  --from N                 First server number. Default: 1",
    "  --to N                   Last server number. Default: 10",
    "  --label-template TEXT    Default: 봉사기 {n}",
    "  --machine-template TEXT  Default: server-{NN}",
    "  --dry-run                Print planned changes without writing",
    "",
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
    to: 10,
    labelTemplate: "봉사기 {n}",
    machineTemplate: "server-{NN}",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") printUsage(0);
    if (arg === "--from") opts.from = parseInteger(argv[++index], "--from");
    else if (arg.startsWith("--from=")) opts.from = parseInteger(arg.slice("--from=".length), "--from");
    else if (arg === "--to") opts.to = parseInteger(argv[++index], "--to");
    else if (arg.startsWith("--to=")) opts.to = parseInteger(arg.slice("--to=".length), "--to");
    else if (arg === "--label-template") opts.labelTemplate = argv[++index] || "";
    else if (arg.startsWith("--label-template=")) opts.labelTemplate = arg.slice("--label-template=".length);
    else if (arg === "--machine-template") opts.machineTemplate = argv[++index] || "";
    else if (arg.startsWith("--machine-template=")) opts.machineTemplate = arg.slice("--machine-template=".length);
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (opts.from > opts.to) throw new Error("--from must be less than or equal to --to");
  if (!String(opts.labelTemplate).trim()) throw new Error("--label-template is required");
  if (!String(opts.machineTemplate).trim()) throw new Error("--machine-template is required");
  return opts;
}

function plannedProfiles(opts) {
  const rows = [];
  for (let number = opts.from; number <= opts.to; number += 1) {
    const machineId = renderTemplate(opts.machineTemplate, number);
    rows.push({
      number,
      label: renderTemplate(opts.labelTemplate, number, machineId),
      machineId,
      protocolUrl: `agent://${machineId}`,
      username: "",
      password: "",
    });
  }
  return rows;
}

function matchesProfile(secret, row) {
  const label = String(row.label || "").toLowerCase();
  const machineId = String(row.machineId || "").toLowerCase();
  return (
    secret.secretType === "server_rdp_credential" &&
    (
      String(secret.label || "").toLowerCase() === label ||
      String(secret.credential?.machineId || "").toLowerCase() === machineId ||
      String(secret.targetMachineId || "").toLowerCase() === machineId
    )
  );
}

function needsRepair(secret, row) {
  return (
    String(secret.credential?.protocolUrl || "") !== row.protocolUrl ||
    String(secret.credential?.username || "") !== "" ||
    String(secret.credential?.protocol || "") !== "agent"
  );
}

export function planServerConnectionProfileRepairs(secrets = [], rows = []) {
  return rows.map((row) => {
    const matches = secrets.filter((secret) => matchesProfile(secret, row));
    if (matches.length === 0) return { action: "missing", ...row };
    if (matches.length > 1) {
      return {
        action: "ambiguous",
        ...row,
        secretIds: matches.map((secret) => secret.secretId),
      };
    }
    const [secret] = matches;
    return {
      action: needsRepair(secret, row) ? "repair" : "ok",
      secretId: secret.secretId,
      label: secret.label || row.label,
      machineId: row.machineId,
      previousProtocolUrl: secret.credential?.protocolUrl || "",
      previousUsername: secret.credential?.username || "",
      protocolUrl: row.protocolUrl,
    };
  });
}

async function main() {
  const opts = parseArgs();
  const rows = plannedProfiles(opts);
  const config = loadServerConfig();
  const databaseUrl = process.env.DATABASE_PUBLIC_URL || config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!config.appSecret) throw new Error("APP_SECRET is required");

  const db = await createPgDb({ databaseUrl });
  try {
    const vault = createPostgresSecretVault({ db, appSecret: config.appSecret });
    const secrets = await vault.listSecretsForBrowser();
    const plan = planServerConnectionProfileRepairs(secrets, rows);
    const blocking = plan.filter((item) => item.action === "ambiguous");
    if (blocking.length) {
      throw new Error(`ambiguous server profiles: ${blocking.map((item) => item.machineId).join(", ")}`);
    }
    const repairs = plan.filter((item) => item.action === "repair");
    if (!opts.dryRun) {
      for (const item of repairs) {
        await vault.updateSecret(item.secretId, {
          label: item.label,
          value: JSON.stringify({
            protocolUrl: item.protocolUrl,
            machineId: item.machineId,
            username: "",
            password: "",
          }),
        });
      }
    }
    console.log(JSON.stringify({
      ok: true,
      dryRun: opts.dryRun,
      repaired: opts.dryRun ? 0 : repairs.length,
      repairable: repairs.length,
      missing: plan.filter((item) => item.action === "missing").length,
      unchanged: plan.filter((item) => item.action === "ok").length,
      plan,
    }, null, 2));
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
