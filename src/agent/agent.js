import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createControlClient, ControlClientError } from "./control-client.js";
import { materializeConfig } from "./config-sync.js";
import { collectDiskInfo } from "./disk.js";
import { materializeEnvProfile } from "./env-materializer.js";
import { loadAgentIdentity } from "./identity.js";
import { collectLocalSnapshot } from "./local-snapshot.js";
import { DASHBOARD_MANAGED_RUN_ENV } from "./managed-run-guard.js";
import { createProcessRunner, resolveManagedCommand } from "./process-runner.js";
import { createProgressEventForwarder } from "./progress-events.js";
import { writeRootEnvFile } from "./root-env.js";
import { materializeSecrets } from "./secret-materializer.js";

const DEFAULT_HEARTBEAT_MS = 30_000;
export const AGENT_PROTOCOL_VERSION = 1;
const execFileAsync = promisify(execFile);

export function isCliEntrypoint(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return path.resolve(argvPath) === path.resolve(fileURLToPath(metaUrl));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeDiskSnapshot(collectDiskInfoImpl = collectDiskInfo, options = {}) {
  try {
    return await collectDiskInfoImpl(options);
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

async function collectPlatformLabel(platform = process.platform) {
  if (platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).Caption",
      ]);
      const caption = stdout.trim();
      if (caption) return caption;
    } catch {
      // Try the older WMIC path too; Windows Server 2019 commonly has it available.
    }
    try {
      const { stdout } = await execFileAsync("wmic.exe", ["os", "get", "Caption"]);
      const caption = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && line.toLowerCase() !== "caption");
      if (caption) return caption;
    } catch {
      // Fall back below.
    }
    return `Windows ${os.release()}`;
  }
  if (platform === "darwin") return `macOS ${os.release()}`;
  if (platform === "linux") {
    try {
      const { readFile } = await import("node:fs/promises");
      const osRelease = await readFile("/etc/os-release", "utf8");
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(osRelease)?.[1];
      if (pretty) return pretty;
    } catch {
      return `Linux ${os.release()}`;
    }
  }
  return `${os.type()} ${os.release()}`;
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

async function gitPullProject(projectDir) {
  const { stdout = "", stderr = "" } = await execFileAsync("git", ["pull", "--ff-only"], {
    cwd: projectDir,
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function createAgentControlFiles({ stateDir }) {
  const controlDir = path.join(stateDir, "dashboard", "control");
  const pauseAfterRangeFile = path.join(controlDir, "pause-after-range");
  const stopPipelineFile = path.join(controlDir, "stop-pipeline");
  return {
    pauseAfterRangeFile,
    stopPipelineFile,
    async prepare() {
      await mkdir(controlDir, { recursive: true });
    },
    async clearPauseAfterRange() {
      await rm(pauseAfterRangeFile, { force: true });
    },
    async clearStopPipeline() {
      await rm(stopPipelineFile, { force: true });
    },
    async requestPauseAfterRange() {
      await mkdir(controlDir, { recursive: true });
      await writeFile(pauseAfterRangeFile, new Date().toISOString(), "utf8");
    },
    async requestStopPipeline() {
      await mkdir(controlDir, { recursive: true });
      await writeFile(stopPipelineFile, new Date().toISOString(), "utf8");
    },
  };
}

export async function runCommand(command, { client, runner, machineId, control = null, syncNow = null, projectDir = process.cwd() }) {
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
    if (command.commandType === "git_pull_restart") {
      let pullResult = null;
      const restartResult = await runner.restartActiveAfter(async () => {
        pullResult = await gitPullProject(projectDir);
      });
      await client.postEvent({
        machineId,
        severity: "success",
        type: "command.accepted",
        message: restartResult.restarted
          ? "Git pull completed and active command restarted."
          : "Git pull completed; no active command was running.",
        data: {
          commandId: command.id,
          commandType: command.commandType,
          restarted: restartResult.restarted,
          stdout: pullResult?.stdout || "",
          stderr: pullResult?.stderr || "",
        },
      });
      await client.ackCommand(command.id, { claimedAt: command.claimedAt });
      return;
    }

    if (command.commandType === "stop_pipeline") {
      await control?.requestStopPipeline?.();
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

    if (command.commandType === "sync_config" || command.commandType === "sync_env") {
      await syncNow?.({ reason: command.commandType });
      await client.postEvent({
        machineId,
        severity: "success",
        type: "command.accepted",
        message: `${command.commandType === "sync_config" ? "Sync config" : "Sync env"} completed.`,
        data: { commandId: command.id, commandType: command.commandType },
      });
      await client.ackCommand(command.id, { claimedAt: command.claimedAt });
      return;
    }

    if (command.commandType === "write_env") {
      const result = await writeRootEnvFile({ projectDir, envText: command.payload?.envText || "" });
      await syncNow?.({ reason: command.commandType });
      await client.postEvent({
        machineId,
        severity: "success",
        type: "command.accepted",
        message: `.env updated (${result.variableCount} variables).`,
        data: { commandId: command.id, commandType: command.commandType, variableCount: result.variableCount },
      });
      await client.ackCommand(command.id, { claimedAt: command.claimedAt });
      return;
    }

    if (isBackgroundCommand(command.commandType)) {
      await control?.clearPauseAfterRange?.();
      await control?.clearStopPipeline?.();
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
      await control?.clearStopPipeline?.();
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
  const secretResult = await materializeSecrets({
    projectDir,
    stateDir,
    secrets,
    preserveLocalProxyWhenUnassigned: true,
  });
  result.secretsEnvPath = secretResult.envPath;
  result.proxyPath = secretResult.proxyPath;
  result.secretEnv = secretResult.env;
  result.mapboxTokenCount = secretResult.mapboxTokenCount || 0;
  result.proxyCount = secretResult.proxyCount || 0;
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
  collectLocalSnapshotImpl = collectLocalSnapshot,
  projectDir = process.cwd(),
  log = () => {},
} = {}) {
  const identity = await loadAgentIdentity({ stateDir, machineId: env.MACHINE_ID });
  const platformLabel = await collectPlatformLabel(process.platform);
  const client = createClient({
    baseUrl: env.DASHBOARD_URL,
    agentToken: env.AGENT_TOKEN,
  });
  const control = createAgentControlFiles({ stateDir });
  await control.prepare();
  const forwarder = createProgressEventForwarder({ machineId: identity.machineId, client });
  const agentLogPath = path.join(stateDir, "dashboard-agent.log");
  const agentControlEnv = {
    DASHBOARD_AGENT_PAUSE_AFTER_RANGE_FILE: control.pauseAfterRangeFile,
    DASHBOARD_AGENT_STOP_FILE: control.stopPipelineFile,
    DASHBOARD_AGENT_LOG_PATH: agentLogPath,
    [DASHBOARD_MANAGED_RUN_ENV]: "1",
  };
  const managedEnv = {};
  const runner = createRunner({
    env: managedEnv,
    onLine: async (line, stream) => {
      await mkdir(path.dirname(agentLogPath), { recursive: true });
      await appendFile(agentLogPath, `${new Date().toISOString()} ${stream.toUpperCase()} ${line}\n`, "utf8");
      if (await forwarder.handleLine(line, stream)) return;
      await client.postEvent({
        machineId: identity.machineId,
        severity: stream === "stderr" ? "warn" : "info",
        type: "process.output",
        message: line,
      });
    },
  });

  async function syncAndPublishSnapshot({ reason = "heartbeat" } = {}) {
    const synced = await syncManagedState({
      client,
      machineId: identity.machineId,
      stateDir,
      projectDir,
    });
    for (const key of Object.keys(managedEnv)) delete managedEnv[key];
    Object.assign(managedEnv, synced.env || {}, synced.secretEnv || {}, agentControlEnv);
    const [disk, agentSnapshot] = await Promise.all([
      safeDiskSnapshot(collectDiskInfoImpl, { projectDir, platform: process.platform }),
      collectLocalSnapshotImpl({ projectDir, stateDir, synced, agentLogPath }),
    ]);
    await client.heartbeat({
      ...identity,
      status: "online",
      platform: platformLabel,
      hostname: os.hostname(),
      disk,
      agentSnapshot,
      agentProtocolVersion: AGENT_PROTOCOL_VERSION,
      syncReason: reason,
    });
    return synced;
  }

  await client.register({
    ...identity,
    displayName: env.MACHINE_DISPLAY_NAME || identity.machineId,
    platform: platformLabel,
    version: env.npm_package_version || "unknown",
    agentProtocolVersion: AGENT_PROTOCOL_VERSION,
  });
  log(`dashboard agent registered machineId=${identity.machineId} dashboard=${env.DASHBOARD_URL}`);

  async function tick() {
    await syncAndPublishSnapshot({ reason: "heartbeat" });
    const { commands = [] } = await client.pollCommands(identity.machineId);
    for (const command of commands) {
      await runCommand(command, {
        client,
        runner,
        machineId: identity.machineId,
        control,
        syncNow: syncAndPublishSnapshot,
        projectDir,
      });
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
