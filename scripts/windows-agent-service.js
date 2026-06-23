#!/usr/bin/env node
import {
  DEFAULT_WINDOWS_AGENT_TASK_NAME,
  installWindowsAgentService,
  queryWindowsAgentService,
  startWindowsAgentService,
  uninstallWindowsAgentService,
} from "../src/agent/windows-agent-service.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForParentExit(pid, { timeoutMs = 30_000 } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return;
  const startedAt = Date.now();
  while (processIsAlive(numericPid) && Date.now() - startedAt < timeoutMs) {
    await sleep(500);
  }
}

function usage() {
  console.log(
    [
      "Manage the local Windows dashboard agent startup task.",
      "",
      "Usage:",
      "  node scripts/windows-agent-service.js install",
      "  node scripts/windows-agent-service.js start",
      "  node scripts/windows-agent-service.js status",
      "  node scripts/windows-agent-service.js uninstall",
      "",
      `Default task name: ${DEFAULT_WINDOWS_AGENT_TASK_NAME}`,
      "The task runs npm-independent node src/agent/agent.js from this project after Windows starts.",
    ].join("\n")
  );
}

const action = process.argv[2] || "status";

try {
  let result;
  if (action === "install") {
    result = await installWindowsAgentService();
    console.log(`Windows agent startup task installed: ${result.taskName}`);
    console.log(`Wrapper: ${result.wrapperPath}`);
    console.log(`Log: ${result.logPath}`);
  } else if (action === "start") {
    result = await startWindowsAgentService();
    console.log(`Windows agent startup task started: ${result.taskName}`);
  } else if (action === "status") {
    result = await queryWindowsAgentService();
    console.log(result.stdout || `Windows agent startup task exists: ${result.taskName}`);
    console.log(`\nWrapper: ${result.wrapperPath}`);
    console.log(`Service log: ${result.logPath}`);
    console.log(`Agent log: ${result.agentLogPath}`);
    if (result.serviceLogTail) {
      console.log(`\n--- Service log tail ---\n${result.serviceLogTail}`);
    }
    if (result.agentLogTail) {
      console.log(`\n--- Agent log tail ---\n${result.agentLogTail}`);
    }
    if (result.diagnosis?.length) {
      console.log(`\n--- Diagnosis ---`);
      for (const item of result.diagnosis) console.log(`- ${item}`);
    }
  } else if (action === "uninstall") {
    result = await uninstallWindowsAgentService();
    console.log(`Windows agent startup task removed: ${result.taskName}`);
  } else if (action === "install-after-parent-exit") {
    await waitForParentExit(process.argv[3]);
    result = await installWindowsAgentService();
    console.log(`Windows agent startup task reinstalled: ${result.taskName}`);
  } else if (action === "--help" || action === "-h" || action === "help") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(1);
  }
  if (result?.stderr) console.error(result.stderr);
} catch (err) {
  console.error(`Windows agent service ${action} failed: ${err.message}`);
  process.exit(1);
}
