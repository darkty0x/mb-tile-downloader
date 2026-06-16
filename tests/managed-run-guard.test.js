import test from "node:test";
import assert from "node:assert/strict";

import {
  assertDashboardManagedRun,
  hasDashboardRuntimeConfig,
  isDashboardManagedRun,
} from "../src/agent/managed-run-guard.js";

const dashboardEnv = {
  DASHBOARD_URL: "https://dashboard.example.com",
  AGENT_TOKEN: "agent-token",
  MACHINE_ID: "worker-a",
};

test("managed run guard detects dashboard runtime config", () => {
  assert.equal(hasDashboardRuntimeConfig(dashboardEnv), true);
  assert.equal(hasDashboardRuntimeConfig({ DASHBOARD_URL: dashboardEnv.DASHBOARD_URL }), false);
});

test("managed run guard accepts commands launched by dashboard runner or agent", () => {
  assert.equal(isDashboardManagedRun({ DASHBOARD_MANAGED_RUN: "1" }), true);
  assert.doesNotThrow(() => assertDashboardManagedRun({
    env: { ...dashboardEnv, DASHBOARD_MANAGED_RUN: "1" },
    scriptName: "downloader.js",
  }));
});

test("managed run guard rejects direct downloader execution when dashboard env is configured", () => {
  assert.throws(
    () => assertDashboardManagedRun({ env: dashboardEnv, scriptName: "downloader.js" }),
    /outside the managed runner/
  );
});

test("managed run guard allows non-runtime maintenance commands and explicit emergency override", () => {
  assert.doesNotThrow(() => assertDashboardManagedRun({
    env: dashboardEnv,
    scriptName: "downloader.js",
    argv: ["split"],
    allowCommands: ["split", "clear-token-state"],
  }));
  assert.doesNotThrow(() => assertDashboardManagedRun({
    env: { ...dashboardEnv, TILE_DOWNLOADER_ALLOW_UNMANAGED_DASHBOARD_RUN: "1" },
    scriptName: "downloader.js",
  }));
});
