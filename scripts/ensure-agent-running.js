#!/usr/bin/env node
import { ensureAgentRunning } from "../src/agent/agent-launcher.js";
import { enableWindowsUtf8Console } from "../src/runtime/windows-console.js";

enableWindowsUtf8Console();
await ensureAgentRunning({ log: console.log }).catch((err) => {
  console.error(`failed to ensure dashboard agent: ${err.message}`);
  process.exit(1);
});
