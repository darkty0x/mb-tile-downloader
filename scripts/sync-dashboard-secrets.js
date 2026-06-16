#!/usr/bin/env node
import { syncDashboardStateIfConfigured } from "../src/agent/dashboard-state-sync.js";

try {
  await syncDashboardStateIfConfigured({
    projectDir: process.cwd(),
    stateDir: ".tile-state",
    log: (message) => console.log(message),
  });
} catch (err) {
  console.error(`Dashboard state sync failed: ${err.message}`);
  process.exit(1);
}
