import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_WINDOWS_AGENT_TASK_NAME = "PTG Dashboard Agent";

function windowsQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ""));
}

export function servicePaths({ projectDir = process.cwd() } = {}) {
  const pathImpl = isWindowsAbsolute(projectDir) ? path.win32 : path;
  const resolvedProject = isWindowsAbsolute(projectDir) ? path.win32.normalize(projectDir) : path.resolve(projectDir);
  return {
    projectDir: resolvedProject,
    stateDir: pathImpl.join(resolvedProject, ".tile-state"),
    bootstrapEnvPath: pathImpl.join(resolvedProject, ".tile-state", "dashboard-agent-bootstrap.env"),
    wrapperPath: pathImpl.join(resolvedProject, ".tile-state", "run-dashboard-agent.cmd"),
    logPath: pathImpl.join(resolvedProject, ".tile-state", "dashboard-agent-service.log"),
    agentLogPath: pathImpl.join(resolvedProject, ".tile-state", "dashboard-agent.log"),
  };
}

const BOOTSTRAP_ENV_NAMES = ["DASHBOARD_URL", "AGENT_TOKEN", "MACHINE_ID"];
const MASKED_ENV_VALUE_PATTERN = /\*{3,}|\.{3,}/;

function buildBootstrapEnvText(env = process.env) {
  const missing = BOOTSTRAP_ENV_NAMES.filter((name) => !String(env[name] || "").trim());
  if (missing.length) {
    throw new Error(`cannot install dashboard agent service; missing ${missing.join(", ")} in .env`);
  }
  const masked = BOOTSTRAP_ENV_NAMES.filter((name) => MASKED_ENV_VALUE_PATTERN.test(String(env[name] || "")));
  if (masked.length) {
    throw new Error(`cannot install dashboard agent service; masked ${masked.join(", ")} in .env`);
  }
  return `${BOOTSTRAP_ENV_NAMES.map((name) => `${name}=${env[name]}`).join("\r\n")}\r\n`;
}

export function buildWindowsAgentWrapper({
  projectDir = process.cwd(),
  nodePath = process.execPath,
  restartDelaySeconds = 10,
} = {}) {
  const paths = servicePaths({ projectDir });
  const delay = Math.max(1, Number.parseInt(String(restartDelaySeconds), 10) || 10);
  return [
    "@echo off",
    "setlocal",
    "chcp 65001 >nul",
    `cd /d ${windowsQuote(paths.projectDir)}`,
    `if not exist ${windowsQuote(paths.stateDir)} mkdir ${windowsQuote(paths.stateDir)}`,
    ":loop",
    `echo [%date% %time%] starting dashboard agent >> ${windowsQuote(paths.logPath)}`,
    `${windowsQuote(nodePath)} --env-file-if-exists=${windowsQuote(paths.bootstrapEnvPath)} --env-file-if-exists=.env src\\agent\\agent.js >> ${windowsQuote(paths.logPath)} 2>&1`,
    `echo [%date% %time%] dashboard agent exited code %ERRORLEVEL%; restarting in ${delay}s >> ${windowsQuote(paths.logPath)}`,
    `timeout /t ${delay} /nobreak >nul`,
    "goto loop",
    "",
  ].join("\r\n");
}

export function buildSchtasksCreateArgs({
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
  wrapperPath,
  runAs = "SYSTEM",
} = {}) {
  const args = [
    "/Create",
    "/TN",
    taskName,
    "/SC",
    "ONSTART",
    "/TR",
    wrapperPath,
    "/F",
  ];
  if (runAs) {
    args.push("/RU", runAs);
    if (runAs.toUpperCase() === "SYSTEM") args.push("/RL", "HIGHEST");
  }
  return args;
}

function powershellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildUnlimitedExecutionTimeArgs({
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
} = {}) {
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      `$task = Get-ScheduledTask -TaskName ${powershellSingleQuote(taskName)} -ErrorAction Stop`,
      "$task.Settings.ExecutionTimeLimit = 'PT0S'",
      "$task.Settings.DisallowStartIfOnBatteries = $false",
      "$task.Settings.StopIfGoingOnBatteries = $false",
      "$task.Settings.RestartCount = 3",
      "$task.Settings.RestartInterval = 'PT1M'",
      "$task | Set-ScheduledTask | Out-Null",
    ].join("; "),
  ];
}

async function execSchtasksIgnoreFailure(execFileImpl, args) {
  try {
    const result = await execFileImpl("schtasks.exe", args, { windowsHide: true });
    return {
      ok: true,
      stdout: String(result?.stdout || "").trim(),
      stderr: String(result?.stderr || "").trim(),
    };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || "").trim(),
      stderr: String(err?.stderr || err?.message || "").trim(),
    };
  }
}

async function stopDetachedAgentFromPidFile({ projectDir, execFileImpl }) {
  const pidPath = path.join(projectDir, ".tile-state", "dashboard-agent.pid");
  let pid = "";
  try {
    pid = (await readFile(pidPath, "utf8")).trim();
  } catch (err) {
    if (err.code !== "ENOENT") {
      return {
        ok: false,
        stdout: "",
        stderr: err.message,
      };
    }
    return { ok: true, stdout: "", stderr: "", skipped: true };
  }
  if (!/^\d+$/.test(pid)) return { ok: false, stdout: "", stderr: `invalid pid file: ${pidPath}` };
  try {
    const result = await execFileImpl("taskkill.exe", ["/PID", pid, "/T", "/F"], { windowsHide: true });
    await rm(pidPath, { force: true });
    return {
      ok: true,
      pid,
      stdout: String(result?.stdout || "").trim(),
      stderr: String(result?.stderr || "").trim(),
    };
  } catch (err) {
    await rm(pidPath, { force: true });
    return {
      ok: false,
      pid,
      stdout: String(err?.stdout || "").trim(),
      stderr: String(err?.stderr || err?.message || "").trim(),
    };
  }
}

export function buildStopProjectAgentProcessesArgs({ projectDir } = {}) {
  const normalizedProject = String(projectDir || "").replaceAll("/", "\\").replaceAll("'", "''").toLowerCase();
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      `$project = ${powershellSingleQuote(normalizedProject)}`,
      "$currentPid = $PID",
      "$matches = Get-CimInstance Win32_Process | Where-Object {",
      "  $_.ProcessId -ne $currentPid -and",
      "  $_.CommandLine -and",
      "  $_.CommandLine.ToLowerInvariant().Replace('/', '\\').Contains($project) -and",
      "  $_.CommandLine -match 'src\\\\agent\\\\agent\\.js'",
      "}",
      "foreach ($process in $matches) {",
      "  try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop } catch {}",
      "}",
      "$matches.Count",
    ].join("; "),
  ];
}

async function stopProjectAgentProcesses({ projectDir, execFileImpl }) {
  try {
    const result = await execFileImpl("powershell.exe", buildStopProjectAgentProcessesArgs({ projectDir }), {
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: String(result?.stdout || "").trim(),
      stderr: String(result?.stderr || "").trim(),
    };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || "").trim(),
      stderr: String(err?.stderr || err?.message || "").trim(),
    };
  }
}

async function readTail(filePath, maxLines = 80) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    return `Unable to read ${filePath}: ${err.message}`;
  }
}

function diagnoseWindowsAgentStatus({ serviceLogTail = "", agentLogTail = "" } = {}) {
  const text = `${serviceLogTail}\n${agentLogTail}`;
  const findings = [];

  if (/dashboard machine id conflict|already registered by another live agent/i.test(text)) {
    findings.push(
      "Machine ID conflict: the dashboard still sees another live agent lease for this MACHINE_ID, or another agent process is running with the same MACHINE_ID."
    );
  }
  if (/DASHBOARD_URL.*required|AGENT_TOKEN.*required|MACHINE_ID.*required|dashboard env/i.test(text)) {
    findings.push("Local .env is incomplete or not being read by the scheduled task.");
  }
  if (/401|403|unauthorized|forbidden/i.test(text)) {
    findings.push("Dashboard authentication failed; AGENT_TOKEN or dashboard-side token configuration does not match.");
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(text)) {
    findings.push("The agent cannot reach DASHBOARD_URL from this Windows server.");
  }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(text)) {
    findings.push("The scheduled task is running against an incomplete install; run dependency install and reinstall the service.");
  }

  return findings;
}

export async function installWindowsAgentService({
  projectDir = process.cwd(),
  nodePath = process.execPath,
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
  runAs = "SYSTEM",
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const paths = servicePaths({ projectDir });
  const stopResult = await execSchtasksIgnoreFailure(execFileImpl, ["/End", "/TN", taskName]);
  const detachedStopResult = await stopDetachedAgentFromPidFile({ projectDir: paths.projectDir, execFileImpl });
  const staleProcessStopResult = await stopProjectAgentProcesses({ projectDir: paths.projectDir, execFileImpl });
  const deleteResult = await execSchtasksIgnoreFailure(execFileImpl, ["/Delete", "/TN", taskName, "/F"]);
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(paths.bootstrapEnvPath, buildBootstrapEnvText(env), "utf8");
  await writeFile(paths.wrapperPath, buildWindowsAgentWrapper({ projectDir, nodePath }), "utf8");
  const args = buildSchtasksCreateArgs({ taskName, wrapperPath: paths.wrapperPath, runAs });
  const result = await execFileImpl("schtasks.exe", args, { windowsHide: true });
  const settingsResult = await execFileImpl("powershell.exe", buildUnlimitedExecutionTimeArgs({ taskName }), { windowsHide: true });
  const startResult = await execFileImpl("schtasks.exe", ["/Run", "/TN", taskName], { windowsHide: true });
  return {
    taskName,
    ...paths,
    bootstrapEnvPath: paths.bootstrapEnvPath,
    stdout: String(result?.stdout || "").trim(),
    stderr: String(result?.stderr || "").trim(),
    stoppedPrevious: stopResult.ok,
    stoppedDetachedAgent: detachedStopResult.ok,
    stoppedStaleAgentProcesses: staleProcessStopResult.ok,
    removedPrevious: deleteResult.ok,
    stopStdout: stopResult.stdout,
    stopStderr: stopResult.stderr,
    detachedStopStdout: detachedStopResult.stdout,
    detachedStopStderr: detachedStopResult.stderr,
    staleProcessStopStdout: staleProcessStopResult.stdout,
    staleProcessStopStderr: staleProcessStopResult.stderr,
    deleteStdout: deleteResult.stdout,
    deleteStderr: deleteResult.stderr,
    settingsStdout: String(settingsResult?.stdout || "").trim(),
    settingsStderr: String(settingsResult?.stderr || "").trim(),
    started: true,
    startStdout: String(startResult?.stdout || "").trim(),
    startStderr: String(startResult?.stderr || "").trim(),
  };
}

export async function uninstallWindowsAgentService({
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
  execFileImpl = execFileAsync,
} = {}) {
  const result = await execFileImpl("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], { windowsHide: true });
  return { taskName, stdout: String(result?.stdout || "").trim(), stderr: String(result?.stderr || "").trim() };
}

export async function startWindowsAgentService({
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
  execFileImpl = execFileAsync,
} = {}) {
  const result = await execFileImpl("schtasks.exe", ["/Run", "/TN", taskName], { windowsHide: true });
  return { taskName, stdout: String(result?.stdout || "").trim(), stderr: String(result?.stderr || "").trim() };
}

export async function queryWindowsAgentService({
  projectDir = process.cwd(),
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
  execFileImpl = execFileAsync,
} = {}) {
  const paths = servicePaths({ projectDir });
  const result = await execFileImpl("schtasks.exe", ["/Query", "/TN", taskName, "/V", "/FO", "LIST"], { windowsHide: true });
  const serviceLogTail = await readTail(paths.logPath);
  const agentLogTail = await readTail(paths.agentLogPath);
  return {
    taskName,
    ...paths,
    stdout: String(result?.stdout || "").trim(),
    stderr: String(result?.stderr || "").trim(),
    serviceLogTail,
    agentLogTail,
    diagnosis: diagnoseWindowsAgentStatus({ serviceLogTail, agentLogTail }),
  };
}
