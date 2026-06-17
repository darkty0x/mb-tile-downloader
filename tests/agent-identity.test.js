import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isCliEntrypoint } from "../src/agent/agent.js";
import { loadAgentIdentity } from "../src/agent/identity.js";

test("agent identity requires a machine id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-id-"));

  await assert.rejects(
    () => loadAgentIdentity({ stateDir: dir, machineId: "" }),
    /MACHINE_ID is required/
  );
});

test("agent identity is created and persisted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-id-"));
  const identity = await loadAgentIdentity({ stateDir: dir, machineId: " worker-a " });
  const persisted = JSON.parse(await readFile(path.join(dir, "agent-id.json"), "utf8"));

  assert.equal(identity.machineId, "worker-a");
  assert.match(identity.agentInstanceId, /^[0-9a-f-]{36}$/i);
  assert.equal(persisted.agentInstanceId, identity.agentInstanceId);
});

test("agent identity canonicalizes machine id casing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-id-"));
  const identity = await loadAgentIdentity({ stateDir: dir, machineId: " SERVER-02 " });

  assert.equal(identity.machineId, "server-02");
});

test("agent identity reuses the same persisted instance id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-id-"));
  const first = await loadAgentIdentity({ stateDir: dir, machineId: "worker-a" });
  const second = await loadAgentIdentity({ stateDir: dir, machineId: "worker-a" });

  assert.equal(second.agentInstanceId, first.agentInstanceId);
});

test("agent CLI entrypoint detects normalized file URL paths", () => {
  const agentPath = path.resolve("src/agent/agent.js");
  assert.equal(isCliEntrypoint(pathToFileURL(agentPath).href, agentPath), true);
  assert.equal(isCliEntrypoint(pathToFileURL(agentPath).href, path.resolve("downloader.js")), false);
});
