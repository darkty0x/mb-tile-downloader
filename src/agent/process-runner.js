import { spawn } from "node:child_process";

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

export function createProcessRunner({ cwd = process.cwd(), env = process.env, onLine = () => {} } = {}) {
  let active = null;
  let activeSpec = null;
  let activePromise = null;

  return {
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
        const child = spawn(command, args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        active = child;
        activeSpec = { command, args: [...args] };
        const emitLine = (line, stream) => {
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
          active = null;
          activeSpec = null;
          activePromise = null;
          reject(err);
        });
        child.on("close", (code, signal) => {
          active = null;
          activeSpec = null;
          activePromise = null;
          resolve({ code, signal });
        });
      });
      activePromise = runPromise;
      return runPromise;
    },

    stop() {
      if (!active) return false;
      active.kill();
      return true;
    },

    async restartActive() {
      if (!active || !activeSpec) return { restarted: false };
      const spec = { command: activeSpec.command, args: [...activeSpec.args] };
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
      active.kill();
      if (activePromise) {
        await activePromise.catch(() => {});
      }
      await task();
      this.run(spec).catch(() => {});
      return { restarted: true };
    },
  };
}
