#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_PROTOCOL_VERSION } from "../src/agent/agent.js";
import { createControlClient } from "../src/agent/control-client.js";
import { dashboardSyncConfig, syncDashboardStateIfConfigured } from "../src/agent/dashboard-state-sync.js";
import { collectDiskInfo } from "../src/agent/disk.js";
import { loadAgentIdentity } from "../src/agent/identity.js";
import { collectLocalSnapshot } from "../src/agent/local-snapshot.js";
import { DASHBOARD_MANAGED_RUN_ENV } from "../src/agent/managed-run-guard.js";

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

function managedScriptName(command) {
  const script = command[scriptIndexFor(command)];
  const name = path.basename(script || "");
  return MANAGED_CONFIG_SCRIPTS.has(name) ? name : null;
}

function hasPartialDashboardEnv(env = {}) {
  return Boolean(env.DASHBOARD_URL || env.AGENT_TOKEN || env.MACHINE_ID);
}

function assertManagedCommandHasCompleteDashboardEnv(command, env = {}) {
  const scriptName = managedScriptName(command);
  if (!scriptName || !hasPartialDashboardEnv(env)) return;
  const config = dashboardSyncConfig(env);
  if (config.configured) return;
  const missing = config.missingKeys?.join(", ") || "DASHBOARD_URL, AGENT_TOKEN, MACHINE_ID";
  throw new Error(
    `Dashboard env is incomplete for ${scriptName}: missing ${missing}. ` +
      "Refusing to fall back to local default config because that can zip the wrong tile set."
  );
}

function isJsonConfigArg(arg) {
  return typeof arg === "string" && /\.json$/i.test(arg) && !arg.startsWith("-");
}

function hasExplicitConfig(command, scriptIndex) {
  return command.slice(scriptIndex + 1).some(isJsonConfigArg);
}

function removeExplicitConfigs(command, scriptIndex) {
  return [
    ...command.slice(0, scriptIndex + 1),
    ...command.slice(scriptIndex + 1).filter((arg) => !isJsonConfigArg(arg)),
  ];
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
  const mode = commandMode(command, scriptIndex);
  if (path.basename(script) === "downloader.js" && (mode === "split" || mode === "clear-token-state")) {
    return command;
  }
  const baseCommand = hasExplicitConfig(command, scriptIndex) ? removeExplicitConfigs(command, scriptIndex) : command;
  return [...baseCommand, configPath];
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
    ...(synced?.synced ? { [DASHBOARD_MANAGED_RUN_ENV]: "1" } : {}),
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

function dashboardLogPath(stateDir = ".tile-state") {
  return path.join(stateDir, "dashboard-agent.log");
}

function createOutputTee({ agentLogPath }) {
  let logWrite = Promise.resolve();
  const buffers = { stdout: "", stderr: "" };

  function appendLogLine(line, stream) {
    logWrite = logWrite
      .then(async () => {
        await mkdir(path.dirname(agentLogPath), { recursive: true });
        await appendFile(agentLogPath, `${new Date().toISOString()} ${stream.toUpperCase()} ${line}\n`, "utf8");
      })
      .catch(() => {});
  }

  function write(chunk, stream) {
    const text = String(chunk);
    const target = stream === "stderr" ? process.stderr : process.stdout;
    target.write(text);
    buffers[stream] += text;
    const lines = buffers[stream].split(/\r?\n/);
    buffers[stream] = lines.pop() || "";
    for (const line of lines) {
      if (line) appendLogLine(line, stream);
    }
  }

  async function flush() {
    for (const stream of ["stdout", "stderr"]) {
      const line = buffers[stream].trimEnd();
      if (line) appendLogLine(line, stream);
      buffers[stream] = "";
    }
    await logWrite;
  }

  return { write, flush };
}

async function safeDiskSnapshot({ projectDir }) {
  try {
    return await collectDiskInfo({ projectDir, platform: process.platform });
  } catch (err) {
    return [
      {
        name: "disk-scan",
        filesystem: "unknown",
        mount: "unknown",
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        percentUsed: 0,
        error: err.message,
      },
    ];
  }
}

export async function publishImmediateDashboardSnapshot({
  client,
  env = process.env,
  projectDir = process.cwd(),
  stateDir = ".tile-state",
  synced,
  agentLogPath = dashboardLogPath(stateDir),
  postEvent = true,
} = {}) {
  if (!client || !synced?.synced) return { published: false, reason: "dashboard state was not synced" };
  const identity = await loadAgentIdentity({ stateDir, machineId: env.MACHINE_ID });
  const [disk, agentSnapshot] = await Promise.all([
    safeDiskSnapshot({ projectDir }),
    collectLocalSnapshot({ projectDir, stateDir, synced, agentLogPath }),
  ]);
  await client.register({
    ...identity,
    displayName: env.MACHINE_DISPLAY_NAME || identity.machineId,
    platform: process.platform,
    version: env.npm_package_version || "unknown",
    disk,
    agentSnapshot,
    agentProtocolVersion: AGENT_PROTOCOL_VERSION,
  });
  if (postEvent) {
    await client.postEvent({
      machineId: identity.machineId,
      severity: "info",
      type: "dashboard-run.synced",
      message: "Local command loaded dashboard-managed config, env, and secrets.",
      data: {
        configPath: synced.configPath || null,
        envPath: synced.envPath || null,
        secretsEnvPath: synced.secretsEnvPath || null,
        proxyPath: synced.proxyPath || null,
      },
    });
  }
  return { published: true, machineId: identity.machineId };
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
  let controlClient = null;
  const clientFactory = (...args) => {
    controlClient = (createClient || createControlClient)(...args);
    return controlClient;
  };
  const synced = await syncDashboardStateIfConfigured({
    env,
    projectDir,
    stateDir,
    createClient: clientFactory,
    log,
  });
  if (!synced.synced) log(`Dashboard state sync skipped: ${synced.reason}`);
  if (synced.synced) {
    await publishImmediateDashboardSnapshot({
      client: controlClient,
      env,
      projectDir,
      stateDir,
      synced,
    });
  }

  assertManagedCommandHasCompleteDashboardEnv(opts.command, env);
  const command = withDashboardConfig(opts.command, synced.configPath);
  const [runner, runnerArgs] = opts.watchdog ? watchdogCommand(command) : plainCommand(command);
  const outputTee = createOutputTee({ agentLogPath: dashboardLogPath(stateDir) });
  const result = await new Promise((resolve) => {
    const child = spawn(runner, runnerArgs, {
      cwd: projectDir,
      env: buildManagedEnv(env, synced),
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => outputTee.write(chunk, "stdout"));
    child.stderr.on("data", (chunk) => outputTee.write(chunk, "stderr"));
    child.on("error", (error) => resolve({ code: 1, error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await outputTee.flush();
  if (synced.synced) {
    await publishImmediateDashboardSnapshot({
      client: controlClient,
      env,
      projectDir,
      stateDir,
      synced,
      postEvent: false,
    });
  }
  if (result.error) throw result.error;
  return result.signal ? 1 : result.code ?? 0;
}

if (isCliEntrypoint()) {
  runDashboardCommand().then((code) => process.exit(code)).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
