import os from "node:os";

import { createControlClient, ControlClientError } from "./control-client.js";
import { materializeConfig } from "./config-sync.js";
import { collectDiskInfo } from "./disk.js";
import { materializeEnvProfile } from "./env-materializer.js";
import { loadAgentIdentity } from "./identity.js";
import { createProcessRunner, resolveManagedCommand } from "./process-runner.js";
import { createProgressEventForwarder } from "./progress-events.js";
import { materializeSecrets } from "./secret-materializer.js";

const DEFAULT_HEARTBEAT_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeDiskSnapshot() {
  try {
    return await collectDiskInfo();
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

async function runCommand(command, { client, runner, machineId }) {
  try {
    const commandSpec = resolveManagedCommand(command);
    if (command.commandType === "stop_pipeline") {
      runner.stop();
    } else {
      await runner.run(commandSpec);
    }
    await client.ackCommand(command.id);
  } catch (err) {
    await client.postEvent({
      machineId,
      severity: "error",
      type: "command.failed",
      message: err.message,
      data: { commandId: command.id, commandType: command.commandType },
    });
    await client.ackCommand(command.id, { error: err.message });
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
} = {}) {
  const identity = await loadAgentIdentity({ stateDir, machineId: env.MACHINE_ID });
  const client = createControlClient({
    baseUrl: env.DASHBOARD_URL,
    agentToken: env.AGENT_TOKEN,
  });
  const forwarder = createProgressEventForwarder({ machineId: identity.machineId, client });
  const managedEnv = {};
  const runner = createProcessRunner({
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
  });

  async function tick() {
    const disk = await safeDiskSnapshot();
    await client.heartbeat({
      ...identity,
      status: "online",
      platform: process.platform,
      hostname: os.hostname(),
      disk,
    });
    const synced = await syncManagedState({
      client,
      machineId: identity.machineId,
      stateDir,
      projectDir: process.cwd(),
    });
    for (const key of Object.keys(managedEnv)) delete managedEnv[key];
    Object.assign(managedEnv, synced.env || {}, synced.secretEnv || {});
    const { commands = [] } = await client.pollCommands(identity.machineId);
    for (const command of commands) {
      await runCommand(command, { client, runner, machineId: identity.machineId });
    }
  }

  await tick();
  if (argv.includes("--once")) return;

  for (;;) {
    await sleep(heartbeatMs);
    await tick();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgent().catch((err) => {
    if (err instanceof ControlClientError && err.status === 409) {
      console.error(`dashboard machine id conflict: ${err.message}`);
      process.exit(2);
    }
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
