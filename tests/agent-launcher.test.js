import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureAgentRunning, hasDashboardAgentConfig } from "../src/agent/agent-launcher.js";

test("dashboard agent auto-start is skipped unless env has dashboard identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-"));
  const calls = [];
  const result = await ensureAgentRunning({
    env: {},
    cwd: dir,
    spawnImpl: () => {
      calls.push("spawn");
    },
  });

  assert.equal(hasDashboardAgentConfig({ DASHBOARD_URL: "x", AGENT_TOKEN: "y" }), false);
  assert.deepEqual(result, { started: false, skipped: true, reason: "missing-config" });
  assert.deepEqual(calls, []);
});

test("dashboard agent auto-start launches a detached agent once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-"));
  const spawned = [];
  const child = { pid: 12345, unref() {} };
  const env = {
    DASHBOARD_URL: "https://dashboard.example.com",
    AGENT_TOKEN: "agent-token",
    MACHINE_ID: "server-01",
  };

  const first = await ensureAgentRunning({
    env,
    cwd: dir,
    spawnImpl(command, args, options) {
      spawned.push({ command, args, detached: options.detached });
      return child;
    },
    aliveImpl: () => false,
  });
  const second = await ensureAgentRunning({
    env,
    cwd: dir,
    spawnImpl() {
      throw new Error("agent should already be running");
    },
    aliveImpl: (pid) => pid === child.pid,
  });

  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.pid, child.pid);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].detached, true);
  assert.deepEqual(spawned[0].args, ["--env-file-if-exists=.env", "src/agent/agent.js"]);
  assert.equal((await readFile(path.join(dir, ".tile-state", "dashboard-agent.pid"), "utf8")).trim(), String(child.pid));
});
