import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stateSource = readFileSync(new URL("../dashboard/client/components/dashboard-state.js", import.meta.url), "utf8");
const pagesSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");

test("server management back clears the selected machine source of truth", () => {
  const actionSource = stateSource.slice(
    stateSource.indexOf("showServerList()"),
    stateSource.indexOf("async manageServerConnection", stateSource.indexOf("showServerList()")),
  );
  const managementSource = pagesSource.slice(
    pagesSource.indexOf("export function ServerManagementPage"),
    pagesSource.indexOf("function ServerControlPanel", pagesSource.indexOf("export function ServerManagementPage")),
  );

  assert.match(actionSource, /setSelectedTab\("servers"\)/);
  assert.match(actionSource, /setSelectedMachineId\(null\)/);
  assert.match(actionSource, /selectedMachineIdRef\.current = null/);
  assert.match(actionSource, /setSelectedServerTab\("control"\)/);
  assert.match(actionSource, /setEditor\(\{ type: "summary" \}\)/);
  assert.match(managementSource, /actions\.showServerList\(\)/);
  assert.doesNotMatch(managementSource, /뒤로[^<]*<\/[^>]+>\s*[^<]*<\/[^>]+>[^]*?setEditor\(\{ type: "summary" \}\)/);
});
