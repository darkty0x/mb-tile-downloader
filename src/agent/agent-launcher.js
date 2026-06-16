import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function hasDashboardAgentConfig(env = process.env) {
  return Boolean(env.DASHBOARD_URL && env.AGENT_TOKEN && env.MACHINE_ID);
}

export function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidPath) {
  try {
    return Number((await readFile(pidPath, "utf8")).trim());
  } catch {
    return null;
  }
}

export async function ensureAgentRunning({
  env = process.env,
  cwd = process.cwd(),
  stateDir = ".tile-state",
  pidPath = path.join(stateDir, "dashboard-agent.pid"),
  logPath = path.join(stateDir, "dashboard-agent.log"),
  spawnImpl = spawn,
  aliveImpl = isProcessAlive,
  log = () => {},
} = {}) {
  if (!hasDashboardAgentConfig(env)) {
    log("dashboard agent not configured; skipping auto-start");
    return { started: false, skipped: true, reason: "missing-config" };
  }

  const resolvedStateDir = path.resolve(cwd, stateDir);
  const resolvedPidPath = path.resolve(cwd, pidPath);
  const resolvedLogPath = path.resolve(cwd, logPath);
  await mkdir(resolvedStateDir, { recursive: true });

  const existingPid = await readPid(resolvedPidPath);
  if (existingPid && aliveImpl(existingPid)) {
    log(`dashboard agent already running pid=${existingPid}`);
    return { started: false, skipped: false, pid: existingPid };
  }

  const out = await open(resolvedLogPath, "a");
  const child = spawnImpl(
    process.execPath,
    ["--env-file-if-exists=.env", "src/agent/agent.js"],
    {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", out.fd, out.fd],
    }
  );
  child.unref?.();
  await writeFile(resolvedPidPath, `${child.pid}\n`, "utf8");
  await out.close();
  log(`dashboard agent started pid=${child.pid}`);
  return { started: true, skipped: false, pid: child.pid };
}
