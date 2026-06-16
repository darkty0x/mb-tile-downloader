#!/usr/bin/env node
import { syncDashboardSecretsIfConfigured } from "../src/agent/dashboard-secrets-sync.js";

try {
  await syncDashboardSecretsIfConfigured({
    projectDir: process.cwd(),
    stateDir: ".tile-state",
    log: (message) => console.log(message),
  });
} catch (err) {
  console.error(`Dashboard secret sync failed: ${err.message}`);
  process.exit(1);
}
