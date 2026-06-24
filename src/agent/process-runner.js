import { spawn } from "node:child_process";

import { mergeRootEnvIntoEnv } from "./root-env.js";

const DEFAULT_STALE_OUTPUT_RESTART_MS = 5 * 60 * 1000;

function parseNonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function resolveStaleOutputRestartMs(env = process.env) {
  const configured = parseNonNegativeInt(env.DASHBOARD_AGENT_STALE_OUTPUT_RESTART_MS);
  return configured ?? DEFAULT_STALE_OUTPUT_RESTART_MS;
}

function normalizeConfigPaths(payload = {}) {
  const rawValues = Array.isArray(payload.configPaths) ? payload.configPaths : [payload.configPath];
  return rawValues
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function requireConfigPath(payload = {}) {
  const [configPath] = normalizeConfigPaths(payload);
  if (!configPath) {
    throw new Error("configPath is required");
  }
  return configPath;
}

function requireConfigPaths(payload = {}) {
  const configPaths = normalizeConfigPaths(payload);
  if (!configPaths.length) {
    throw new Error("configPath is required");
  }
  return configPaths;
}

export function resolveManagedCommand({ commandType, payload = {} }) {
  switch (commandType) {
    case "start_pipeline":
    case "resume_pipeline":
      return {
        command: process.execPath,
        args: ["src/agent/pipeline.js", ...requireConfigPaths(payload)],
      };
    case "run_preflight":
      return {
        command: process.execPath,
        args: ["src/agent/preflight.js", requireConfigPath(payload)],
      };
    case "sync_config":
    case "sync_env":
    case "pause_after_range":
    case "stop_pipeline":
    case "write_env":
    case "write_config":
    case "delete_config":
    case "clear_agent_log":
    case "git_pull_restart":
      return {
        command: "agent-internal",
        args: [commandType],
      };
    default:
      throw new Error(`unsupported command: ${commandType}`);
  }
}

export function createProcessRunner({
  cwd = process.cwd(),
  env = process.env,
  onLine = () => {},
  onStaleRestart = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let active = null;
  let activeSpec = null;
  let activePromise = null;
  let lastOutputAt = 0;
  let staleTimer = null;
  let restartingStaleProcess = false;

  function staleOutputRestartMs() {
    return resolveStaleOutputRestartMs({ ...process.env, ...env });
  }

  function clearStaleTimer() {
    if (!staleTimer) return;
    clearTimer(staleTimer);
    staleTimer = null;
  }

  function armStaleTimer() {
    clearStaleTimer();
    const timeoutMs = staleOutputRestartMs();
    if (!active || !activeSpec || timeoutMs <= 0) return;
    if (!lastOutputAt) return;
    const elapsedMs = now() - lastOutputAt;
    const delayMs = Math.max(1, timeoutMs - elapsedMs);
    staleTimer = setTimer(() => {
      if (!active || !activeSpec || restartingStaleProcess) return;
      const quietMs = now() - lastOutputAt;
      if (quietMs < timeoutMs) {
        armStaleTimer();
        return;
      }
      const spec = { command: activeSpec.command, args: [...activeSpec.args] };
      const staleChild = active;
      restartingStaleProcess = true;
      Promise.resolve(
        onStaleRestart({
          command: spec.command,
          args: [...spec.args],
          quietMs,
          timeoutMs,
        })
      ).catch(() => {});
      clearStaleTimer();
      staleChild.kill();
    }, delayMs);
  }

  function launchProcess({ command, args }, resolve, reject) {
    const childEnv = mergeRootEnvIntoEnv({
      projectDir: cwd,
      env: { ...process.env, ...env },
    });
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    activeSpec = { command, args: [...args] };
    lastOutputAt = 0;
    const emitLine = (line, stream) => {
      lastOutputAt = now();
      armStaleTimer();
      try {
        Promise.resolve(onLine(line, stream)).catch(() => {});
      } catch {
        // Process output forwarding must not crash the managed child process.
      }
    };
    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) emitLine(line, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) emitLine(line, "stderr");
    });
    child.on("error", (err) => {
      clearStaleTimer();
      active = null;
      activeSpec = null;
      if (restartingStaleProcess) {
        restartingStaleProcess = false;
        launchProcess({ command, args }, resolve, reject);
        return;
      }
      activePromise = null;
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearStaleTimer();
      active = null;
      activeSpec = null;
      if (restartingStaleProcess) {
        restartingStaleProcess = false;
        launchProcess({ command, args }, resolve, reject);
        return;
      }
      activePromise = null;
      resolve({ code, signal });
    });
  }

  const runner = {
    get active() {
      return active;
    },
    get activeCommandSpec() {
      return activeSpec;
    },

    async run(commandSpec) {
      if (active) throw new Error("another managed process is already running");
      const { command, args } = commandSpec;
      if (command === "agent-internal") return { code: 0, signal: null };

      const runPromise = new Promise((resolve, reject) => {
        launchProcess({ command, args }, resolve, reject);
      });
      activePromise = runPromise;
      return runPromise;
    },

    stop() {
      if (!active) return false;
      clearStaleTimer();
      active.kill();
      return true;
    },

    restartStaleActive() {
      if (!active || !activeSpec || restartingStaleProcess) return { restarted: false };
      clearStaleTimer();
      restartingStaleProcess = true;
      active.kill();
      return { restarted: true };
    },

    async restartActive() {
      if (!active || !activeSpec) return { restarted: false };
      const spec = { command: activeSpec.command, args: [...activeSpec.args] };
      clearStaleTimer();
      active.kill();
      if (activePromise) {
        await activePromise.catch(() => {});
      }
      this.run(spec).catch(() => {});
      return { restarted: true };
    },

    async restartActiveAfter(task = async () => {}) {
      if (!active || !activeSpec) {
        await task();
        return { restarted: false };
      }
      const spec = { command: activeSpec.command, args: [...activeSpec.args] };
      clearStaleTimer();
      active.kill();
      if (activePromise) {
        await activePromise.catch(() => {});
      }
      await task();
      this.run(spec).catch(() => {});
      return { restarted: true };
    },
  };
  return runner;
}
