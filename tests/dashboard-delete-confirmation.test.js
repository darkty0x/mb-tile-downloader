import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stateSource = readFileSync(new URL("../dashboard/client/components/dashboard-state.js", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../dashboard/client/components/dashboard-shell.jsx", import.meta.url), "utf8");
const pagesSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");

test("destructive dashboard actions cannot bypass the shared confirmation dialog", () => {
  assert.doesNotMatch(stateSource, /ptg\.confirm\.[^`]*\.skip/);
  assert.doesNotMatch(shellSource, /다음에도 다시 묻기/);
  assert.doesNotMatch(pagesSource, /globalThis\.confirm|window\.confirm/);
});

test("machine deletion is confirmed in the action layer before calling the delete API", () => {
  const deleteMachineSource = stateSource.slice(
    stateSource.indexOf("async deleteMachine(machineId)"),
    stateSource.indexOf("async saveServerConnection", stateSource.indexOf("async deleteMachine(machineId)")),
  );

  assert.match(deleteMachineSource, /confirmDanger\(\{/);
  assert.match(deleteMachineSource, /title:\s*"봉사기 삭제 확인"/);
  assert.match(deleteMachineSource, /method:\s*"DELETE"/);
  assert.ok(deleteMachineSource.indexOf("confirmDanger({") < deleteMachineSource.indexOf('method: "DELETE"'));
});
