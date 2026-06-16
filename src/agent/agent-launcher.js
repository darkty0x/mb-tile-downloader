import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LAUNCHER_VERSION = 2;

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

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function agentSignature(cwd) {
  const scriptPath = path.resolve(cwd, "src/agent/agent.js");
  let scriptMtimeMs = 0;
  try {
    scriptMtimeMs = Math.trunc((await stat(scriptPath)).mtimeMs);
  } catch {
    scriptMtimeMs = 0;
  }
  return {
    launcherVersion: LAUNCHER_VERSION,
    scriptPath,
    scriptMtimeMs,
    node: process.execPath,
  };
}

function signatureMatches(meta, signature) {
  return Boolean(
    meta &&
      meta.launcherVersion === signature.launcherVersion &&
      meta.scriptPath === signature.scriptPath &&
      meta.scriptMtimeMs === signature.scriptMtimeMs &&
      meta.node === signature.node
  );
}

export async function ensureAgentRunning({
  env = process.env,
  cwd = process.cwd(),
  stateDir = ".tile-state",
  pidPath = path.join(stateDir, "dashboard-agent.pid"),
  metaPath = path.join(stateDir, "dashboard-agent.meta.json"),
  logPath = path.join(stateDir, "dashboard-agent.log"),
  spawnImpl = spawn,
  aliveImpl = isProcessAlive,
  killImpl = (pid) => process.kill(pid),
  log = () => {},
} = {}) {
  if (!hasDashboardAgentConfig(env)) {
    log("dashboard agent not configured; skipping auto-start");
    return { started: false, skipped: true, reason: "missing-config" };
  }

  const resolvedStateDir = path.resolve(cwd, stateDir);
  const resolvedPidPath = path.resolve(cwd, pidPath);
  const resolvedMetaPath = path.resolve(cwd, metaPath);
  const resolvedLogPath = path.resolve(cwd, logPath);
  await mkdir(resolvedStateDir, { recursive: true });
  const signature = await agentSignature(cwd);

  const existingPid = await readPid(resolvedPidPath);
  if (existingPid && aliveImpl(existingPid)) {
    const meta = await readJson(resolvedMetaPath);
    if (signatureMatches(meta, signature)) {
      log(`dashboard agent already running pid=${existingPid}`);
      return { started: false, skipped: false, pid: existingPid };
    }
    try {
      killImpl(existingPid);
      log(`dashboard agent stale pid=${existingPid}; restarting`);
    } catch (err) {
      log(`dashboard agent stale pid=${existingPid}; failed to stop: ${err.message}`);
      return { started: false, skipped: false, pid: existingPid, stale: true };
    }
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
  await writeFile(resolvedMetaPath, `${JSON.stringify({ ...signature, pid: child.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await out.close();
  log(`dashboard agent started pid=${child.pid}`);
  return { started: true, skipped: false, pid: child.pid };
}
