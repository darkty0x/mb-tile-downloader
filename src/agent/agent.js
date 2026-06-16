import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createControlClient, ControlClientError } from "./control-client.js";
import { materializeConfig } from "./config-sync.js";
import { collectDiskInfo } from "./disk.js";
import { materializeEnvProfile } from "./env-materializer.js";
import { loadAgentIdentity } from "./identity.js";
import { createProcessRunner, resolveManagedCommand } from "./process-runner.js";
import { createProgressEventForwarder } from "./progress-events.js";
import { materializeSecrets } from "./secret-materializer.js";

const DEFAULT_HEARTBEAT_MS = 30_000;
export const AGENT_PROTOCOL_VERSION = 1;

export function isCliEntrypoint(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return path.resolve(argvPath) === path.resolve(fileURLToPath(metaUrl));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeDiskSnapshot(collectDiskInfoImpl = collectDiskInfo) {
  try {
    return await collectDiskInfoImpl();
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

function commandExitError(commandType, result = {}) {
  if (result.code === 0) return null;
  if (result.signal) return new Error(`${commandType} exited with signal ${result.signal}`);
  return new Error(`${commandType} exited with code ${result.code ?? "unknown"}`);
}

async function postCommandFailure({ client, machineId, command, err }) {
  await client.postEvent({
    machineId,
    severity: "error",
    type: "command.failed",
    message: err.message,
    data: { commandId: command.id, commandType: command.commandType },
  });
}

function isBackgroundCommand(commandType) {
  return commandType === "start_pipeline" || commandType === "resume_pipeline";
}

function createAgentControlFiles({ stateDir }) {
  const controlDir = path.join(stateDir, "dashboard", "control");
  const pauseAfterRangeFile = path.join(controlDir, "pause-after-range");
  return {
    pauseAfterRangeFile,
    async prepare() {
      await mkdir(controlDir, { recursive: true });
    },
    async clearPauseAfterRange() {
      await rm(pauseAfterRangeFile, { force: true });
    },
    async requestPauseAfterRange() {
      await mkdir(controlDir, { recursive: true });
      await writeFile(pauseAfterRangeFile, new Date().toISOString(), "utf8");
    },
  };
}

export async function runCommand(command, { client, runner, machineId, control = null }) {
  try {
    if (command.commandType === "pause_after_range") {
      await control?.requestPauseAfterRange?.();
      await client.postEvent({
        machineId,
        severity: "info",
        type: "command.accepted",
        message: "Pipeline will pause after the current range completes.",
        data: { commandId: command.id, commandType: command.commandType },
      });
      await client.ackCommand(command.id, { claimedAt: command.claimedAt });
      return;
    }

    const commandSpec = resolveManagedCommand(command);
    if (command.commandType === "stop_pipeline") {
      const stopped = runner.stop();
      await client.postEvent({
        machineId,
        severity: stopped ? "warn" : "info",
        type: "command.accepted",
        message: stopped ? "Stop signal sent to the active managed process." : "No active managed process was running.",
        data: { commandId: command.id, commandType: command.commandType },
      });
      await client.ackCommand(command.id, { claimedAt: command.claimedAt });
      return;
    }

    if (isBackgroundCommand(command.commandType)) {
      await control?.clearPauseAfterRange?.();
      const runPromise = runner.run(commandSpec);
      await client.ackCommand(command.id, { claimedAt: command.claimedAt });
      runPromise
        .then((result) => {
          const err = commandExitError(command.commandType, result);
          if (!err) return null;
          return postCommandFailure({ client, machineId, command, err });
        })
        .catch((err) => postCommandFailure({ client, machineId, command, err }))
        .catch(() => {});
      return;
    }

    if (command.commandType === "run_preflight") {
      await control?.clearPauseAfterRange?.();
    }

    if (commandSpec.command === "agent-internal") {
      await client.ackCommand(command.id, { claimedAt: command.claimedAt });
      return;
    } else {
      const result = await runner.run(commandSpec);
      const err = commandExitError(command.commandType, result);
      if (err) throw err;
    }
    await client.ackCommand(command.id, { claimedAt: command.claimedAt });
  } catch (err) {
    await postCommandFailure({ client, machineId, command, err });
    await client.ackCommand(command.id, { error: err.message, claimedAt: command.claimedAt });
  }
}

export async function syncManagedState({ client, machineId, stateDir, projectDir }) {
  const [{ configs = [] }, { envProfiles = [] }, { secrets = [] }] = await Promise.all([
    client.listConfigs(machineId),
    client.listEnvProfiles(machineId),
    client.listSecrets(machineId),
  ]);
  const activeConfig = configs.find((config) => config.active) || null;
  const activeEnv = envProfiles.find((profile) => profile.active) || null;
  const result = {
    configPath: null,
    envPath: null,
    secretsEnvPath: null,
    proxyPath: null,
  };
  if (activeConfig) {
    result.configPath = (await materializeConfig({ stateDir, configRecord: activeConfig })).configPath;
  }
  if (activeEnv) {
    const envResult = await materializeEnvProfile({ stateDir, profile: activeEnv });
    result.envPath = envResult.envPath;
    result.env = envResult.env;
  }
  const secretResult = await materializeSecrets({ projectDir, stateDir, secrets });
  result.secretsEnvPath = secretResult.envPath;
  result.proxyPath = secretResult.proxyPath;
  result.secretEnv = secretResult.env;
  return result;
}

export async function runAgent({
  env = process.env,
  argv = process.argv.slice(2),
  stateDir = ".tile-state",
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  createClient = createControlClient,
  createRunner = createProcessRunner,
  collectDiskInfoImpl = collectDiskInfo,
  projectDir = process.cwd(),
  log = () => {},
} = {}) {
  const identity = await loadAgentIdentity({ stateDir, machineId: env.MACHINE_ID });
  const client = createClient({
    baseUrl: env.DASHBOARD_URL,
    agentToken: env.AGENT_TOKEN,
  });
  const control = createAgentControlFiles({ stateDir });
  await control.prepare();
  const forwarder = createProgressEventForwarder({ machineId: identity.machineId, client });
  const agentControlEnv = {
    DASHBOARD_AGENT_PAUSE_AFTER_RANGE_FILE: control.pauseAfterRangeFile,
  };
  const managedEnv = {};
  const runner = createRunner({
    env: managedEnv,
    onLine: async (line, stream) => {
      if (await forwarder.handleLine(line, stream)) return;
      await client.postEvent({
        machineId: identity.machineId,
        severity: stream === "stderr" ? "warn" : "info",
        type: "process.output",
        message: line,
      });
    },
  });

  await client.register({
    ...identity,
    displayName: env.MACHINE_DISPLAY_NAME || identity.machineId,
    platform: process.platform,
    version: env.npm_package_version || "unknown",
    agentProtocolVersion: AGENT_PROTOCOL_VERSION,
  });
  log(`dashboard agent registered machineId=${identity.machineId} dashboard=${env.DASHBOARD_URL}`);

  async function tick() {
    const disk = await safeDiskSnapshot(collectDiskInfoImpl);
    await client.heartbeat({
      ...identity,
      status: "online",
      platform: process.platform,
      hostname: os.hostname(),
      disk,
      agentProtocolVersion: AGENT_PROTOCOL_VERSION,
    });
    const synced = await syncManagedState({
      client,
      machineId: identity.machineId,
      stateDir,
      projectDir,
    });
    for (const key of Object.keys(managedEnv)) delete managedEnv[key];
    Object.assign(managedEnv, synced.env || {}, synced.secretEnv || {}, agentControlEnv);
    const { commands = [] } = await client.pollCommands(identity.machineId);
    for (const command of commands) {
      await runCommand(command, { client, runner, machineId: identity.machineId, control });
    }
  }

  await tick();
  log(`dashboard agent heartbeat sent machineId=${identity.machineId}`);
  if (argv.includes("--once")) return;

  for (;;) {
    await sleep(heartbeatMs);
    await tick();
  }
}

if (isCliEntrypoint()) {
  runAgent({ log: console.log }).catch((err) => {
    if (err instanceof ControlClientError && err.status === 409) {
      console.error(`dashboard machine id conflict: ${err.message}`);
      process.exit(2);
    }
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
