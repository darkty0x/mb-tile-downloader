#!/usr/bin/env node
import { createPgDb } from "../dashboard/src/server/db.js";
import { loadServerConfig } from "../dashboard/src/server/config.js";
import { createPostgresSecretVault } from "../dashboard/src/server/secrets.js";

function printUsage(exitCode = 0) {
  console.log([
    "Repair one saved server connection credential so it has an Agent ID.",
    "",
    "Usage:",
    "  node --env-file-if-exists=.env scripts/repair-server-credential-agent-id.js [--label \"Server 02\"] [--machine-id SERVER-02]",
    "  node --env-file-if-exists=.env scripts/repair-server-credential-agent-id.js --label \"봉사기 10\" --machine-id server-10 --personal-computer",
    "",
    "Requires DATABASE_URL and APP_SECRET in .env or the Railway environment.",
  ].join("\n"));
  process.exit(exitCode);
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    label: "Server 02",
    machineId: "SERVER-02",
    personalComputer: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") printUsage(0);
    if (arg === "--label") {
      opts.label = argv[++index] || "";
    } else if (arg.startsWith("--label=")) {
      opts.label = arg.slice("--label=".length);
    } else if (arg === "--machine-id") {
      opts.machineId = argv[++index] || "";
    } else if (arg.startsWith("--machine-id=")) {
      opts.machineId = arg.slice("--machine-id=".length);
    } else if (arg === "--personal-computer") {
      opts.personalComputer = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  opts.label = String(opts.label || "").trim();
  opts.machineId = String(opts.machineId || "").trim();
  if (!opts.label) throw new Error("--label is required");
  if (!opts.machineId) throw new Error("--machine-id is required");
  return opts;
}

function matchesCredential(secret, label) {
  const needle = label.toLowerCase();
  return (
    ["credential", "server_rdp_credential"].includes(secret.secretType) &&
    ["agent", "rdp", "ssh", "winrm", "winrms"].includes(secret.credential?.protocol) &&
    (String(secret.label || "").toLowerCase() === needle || String(secret.secretId || "").toLowerCase() === needle)
  );
}

async function main() {
  const opts = parseArgs();
  const config = loadServerConfig();
  const databaseUrl = process.env.DATABASE_PUBLIC_URL || config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!config.appSecret) throw new Error("APP_SECRET is required");

  const db = await createPgDb({ databaseUrl });
  try {
    const vault = createPostgresSecretVault({ db, appSecret: config.appSecret });
    const matches = (await vault.listSecretsForBrowser()).filter((secret) => matchesCredential(secret, opts.label));
    if (matches.length === 0) throw new Error(`No server credential found for label or id: ${opts.label}`);
    if (matches.length > 1) throw new Error(`Multiple server credentials match "${opts.label}"; rerun with --label <secretId>`);

    const current = matches[0];
    const dashboardSecret = await vault.getSecretForDashboard(current.secretId);
    const value = JSON.parse(dashboardSecret.value);
    const currentMachineId = String(value.machineId || "").trim();
    const nextValue = opts.personalComputer
      ? {
        protocolUrl: `agent://${opts.machineId}`,
        machineId: opts.machineId,
        username: "",
        password: "",
      }
      : {
        protocolUrl: value.protocolUrl,
        machineId: opts.machineId,
        username: value.username,
        password: value.password,
      };

    if (
      currentMachineId.toLowerCase() === opts.machineId.toLowerCase() &&
      (!opts.personalComputer || String(value.protocolUrl || "").toLowerCase() === `agent://${opts.machineId}`.toLowerCase())
    ) {
      console.log(JSON.stringify({
        ok: true,
        changed: false,
        secretId: current.secretId,
        label: current.label,
        machineId: opts.machineId,
        protocol: opts.personalComputer ? "agent" : current.credential?.protocol,
      }, null, 2));
      return;
    }

    await vault.updateSecret(current.secretId, {
      value: JSON.stringify(nextValue),
    });

    console.log(JSON.stringify({
      ok: true,
      changed: true,
      secretId: current.secretId,
      label: current.label,
      previousMachineId: currentMachineId || null,
      machineId: opts.machineId,
      protocol: opts.personalComputer ? "agent" : current.credential?.protocol,
    }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
