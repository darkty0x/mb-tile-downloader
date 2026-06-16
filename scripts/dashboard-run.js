#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncDashboardStateIfConfigured } from "../src/agent/dashboard-state-sync.js";

const __filename = fileURLToPath(import.meta.url);

const MANAGED_CONFIG_SCRIPTS = new Set(["downloader.js", "zip-maker.js", "storj-uploader.js"]);
const OPTION_VALUE_FLAGS = new Set([
  "--max-concurrent-requests",
  "--state-db",
  "--range-index",
  "--row-recovery-passes",
  "--recovery-backoff-ms",
  "--max-rows-in-flight",
  "--archive-dir",
  "--bucket",
  "--prefix",
  "--access",
  "--uplink-config-dir",
  "--layer",
  "--tiles-dir",
  "--max-archive-size",
]);
const LOCAL_SECRET_ENV_KEYS = new Set([
  "MAPBOX_ACCESS_TOKENS",
  "MAPBOX_ACCESS_TOKEN",
  "TILE_DOWNLOADER_PROXY_LIST",
  "PROXY_LIST",
  "TILE_DOWNLOADER_HTTP_PROXY_LIST",
  "HTTP_PROXY_LIST",
  "TILE_DOWNLOADER_HTTPS_PROXY_LIST",
  "HTTPS_PROXY_LIST",
  "TILE_DOWNLOADER_PROXY_LIST_FILE",
  "PROXY_LIST_FILE",
  "TILE_DOWNLOADER_HTTP_PROXY_LIST_FILE",
  "HTTP_PROXY_LIST_FILE",
  "TILE_DOWNLOADER_HTTPS_PROXY_LIST_FILE",
  "HTTPS_PROXY_LIST_FILE",
  "TILE_DOWNLOADER_PROXY_USERNAME",
  "PROXY_USERNAME",
  "PROXYSCRAPE_PROXY_USERNAME",
  "TILE_DOWNLOADER_PROXY_PASSWORD",
  "PROXY_PASSWORD",
  "PROXYSCRAPE_PROXY_PASSWORD",
]);

function isCliEntrypoint(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return path.resolve(argvPath) === path.resolve(fileURLToPath(metaUrl));
}

function printUsage(exitCode = 0) {
  console.log(
    [
      "Run a local downloader command with dashboard-managed config/env/secrets.",
      "",
      "Usage:",
      "  node scripts/dashboard-run.js [--watchdog] -- command [args...]",
      "",
      "When DASHBOARD_URL, AGENT_TOKEN, and MACHINE_ID are present, the command uses",
      "the active dashboard config, env profile, Mapbox tokens, and proxy pool.",
    ].join("\n")
  );
  process.exit(exitCode);
}

export function parseDashboardRunArgs(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) printUsage(0);
  const separator = argv.indexOf("--");
  if (separator === -1) throw new Error("dashboard-run requires -- before the command");
  const opts = {
    watchdog: false,
    command: argv.slice(separator + 1),
  };
  for (const arg of argv.slice(0, separator)) {
    if (arg === "--watchdog") opts.watchdog = true;
    else throw new Error(`Unknown dashboard-run option: ${arg}`);
  }
  if (opts.command.length === 0) throw new Error("dashboard-run command is empty");
  return opts;
}

function isNodeCommand(command) {
  const first = path.basename(command[0] || "").toLowerCase();
  return first === "node" || first === "node.exe" || path.resolve(command[0] || "") === process.execPath;
}

function scriptIndexFor(command) {
  if (isNodeCommand(command)) return 1;
  return 0;
}

function isJsonConfigArg(arg) {
  return typeof arg === "string" && /\.json$/i.test(arg) && !arg.startsWith("-");
}

function hasExplicitConfig(command, scriptIndex) {
  return command.slice(scriptIndex + 1).some(isJsonConfigArg);
}

function isOptionWithInlineValue(arg) {
  return /^--[^=]+=/.test(arg);
}

function commandMode(command, scriptIndex) {
  const args = command.slice(scriptIndex + 1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (isOptionWithInlineValue(arg)) continue;
    if (OPTION_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function withDashboardConfig(command, configPath) {
  if (!configPath) return command;
  const scriptIndex = scriptIndexFor(command);
  const script = command[scriptIndex];
  if (!script || !MANAGED_CONFIG_SCRIPTS.has(path.basename(script))) return command;
  if (hasExplicitConfig(command, scriptIndex)) return command;
  const mode = commandMode(command, scriptIndex);
  if (path.basename(script) === "downloader.js" && (mode === "split" || mode === "clear-token-state")) {
    return command;
  }
  return [...command, configPath];
}

export function buildManagedEnv(baseEnv, synced) {
  const nextEnv = { ...baseEnv };
  if (synced?.synced) {
    for (const key of Object.keys(nextEnv)) {
      if (LOCAL_SECRET_ENV_KEYS.has(key) || /^MAPBOX_ACCESS_TOKEN_\d+$/.test(key)) delete nextEnv[key];
    }
  }
  return {
    ...nextEnv,
    ...(synced?.env || {}),
    ...(synced?.secretEnv || {}),
  };
}

function watchdogCommand(command) {
  return [
    process.execPath,
    [path.join(path.dirname(__filename), "watchdog.js"), "--", ...command],
  ];
}

function plainCommand(command) {
  return [command[0], command.slice(1)];
}

export async function runDashboardCommand({
  argv = process.argv.slice(2),
  env = process.env,
  projectDir = process.cwd(),
  stateDir = ".tile-state",
  createClient,
  log = console.log,
} = {}) {
  const opts = parseDashboardRunArgs(argv);
  const synced = await syncDashboardStateIfConfigured({
    env,
    projectDir,
    stateDir,
    createClient,
    log,
  });
  if (!synced.synced) log(`Dashboard state sync skipped: ${synced.reason}`);

  const command = withDashboardConfig(opts.command, synced.configPath);
  const [runner, runnerArgs] = opts.watchdog ? watchdogCommand(command) : plainCommand(command);
  const result = await new Promise((resolve) => {
    const child = spawn(runner, runnerArgs, {
      cwd: projectDir,
      env: buildManagedEnv(env, synced),
      shell: false,
      stdio: "inherit",
    });
    child.on("error", (error) => resolve({ code: 1, error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.error) throw result.error;
  return result.signal ? 1 : result.code ?? 0;
}

if (isCliEntrypoint()) {
  runDashboardCommand().then((code) => process.exit(code)).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
