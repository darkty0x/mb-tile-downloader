import { spawn } from "node:child_process";

function requireConfigPath(payload = {}) {
  if (!payload.configPath || typeof payload.configPath !== "string") {
    throw new Error("configPath is required");
  }
  return payload.configPath;
}

export function resolveManagedCommand({ commandType, payload = {} }) {
  switch (commandType) {
    case "start_pipeline":
    case "resume_pipeline":
      return {
        command: process.execPath,
        args: ["src/agent/pipeline.js", requireConfigPath(payload)],
      };
    case "run_preflight":
      return {
        command: process.execPath,
        args: ["downloader.js", "--dry-run", requireConfigPath(payload)],
      };
    case "sync_config":
    case "sync_env":
    case "pause_after_range":
    case "stop_pipeline":
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

  return {
    get active() {
      return active;
    },

    async run(commandSpec) {
      if (active) throw new Error("another managed process is already running");
      const { command, args } = commandSpec;
      if (command === "agent-internal") return { code: 0, signal: null };

      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        active = child;
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
          reject(err);
        });
        child.on("close", (code, signal) => {
          active = null;
          resolve({ code, signal });
        });
      });
    },

    stop() {
      if (!active) return false;
      active.kill();
      return true;
    },
  };
}
