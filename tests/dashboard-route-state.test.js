import assert from "node:assert/strict";
import test from "node:test";

import { parseDashboardRoute } from "../dashboard/client/lib/route-state.js";

test("servers route with machineId opens the selected server management view", () => {
  const route = parseDashboardRoute("https://echopoly.xyz/servers?machineId=server-01");

  assert.equal(route.selectedTab, "servers");
  assert.equal(route.selectedMachineId, "server-01");
  assert.deepEqual(route.editor, { type: "server-management", machineId: "server-01" });
});

test("servers route without machineId keeps the server list view", () => {
  const route = parseDashboardRoute("https://echopoly.xyz/servers");

  assert.equal(route.selectedTab, "servers");
  assert.equal(route.selectedMachineId, null);
  assert.deepEqual(route.editor, { type: "summary" });
});

test("selected server route keeps the requested server tab", () => {
  const route = parseDashboardRoute("https://echopoly.xyz/servers?machineId=SERVER-01&serverTab=console");

  assert.equal(route.selectedMachineId, "server-01");
  assert.equal(route.selectedServerTab, "console");
  assert.deepEqual(route.editor, { type: "server-management", machineId: "server-01" });
});
