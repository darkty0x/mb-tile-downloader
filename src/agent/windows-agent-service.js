import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
    wrapperPath: pathImpl.join(resolvedProject, ".tile-state", "run-dashboard-agent.cmd"),
    logPath: pathImpl.join(resolvedProject, ".tile-state", "dashboard-agent-service.log"),
  };
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
    `${windowsQuote(nodePath)} --env-file-if-exists=.env src\\agent\\agent.js >> ${windowsQuote(paths.logPath)} 2>&1`,
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

export async function installWindowsAgentService({
  projectDir = process.cwd(),
  nodePath = process.execPath,
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
  runAs = "SYSTEM",
  execFileImpl = execFileAsync,
} = {}) {
  const paths = servicePaths({ projectDir });
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(paths.wrapperPath, buildWindowsAgentWrapper({ projectDir, nodePath }), "utf8");
  const args = buildSchtasksCreateArgs({ taskName, wrapperPath: paths.wrapperPath, runAs });
  const result = await execFileImpl("schtasks.exe", args, { windowsHide: true });
  return {
    taskName,
    ...paths,
    stdout: String(result?.stdout || "").trim(),
    stderr: String(result?.stderr || "").trim(),
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
  taskName = DEFAULT_WINDOWS_AGENT_TASK_NAME,
  execFileImpl = execFileAsync,
} = {}) {
  const result = await execFileImpl("schtasks.exe", ["/Query", "/TN", taskName, "/V", "/FO", "LIST"], { windowsHide: true });
  return { taskName, stdout: String(result?.stdout || "").trim(), stderr: String(result?.stderr || "").trim() };
}
