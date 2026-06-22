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

test("global git pull restart uses one confirmed bulk action", () => {
  const globalGitSource = stateSource.slice(
    stateSource.indexOf("async gitPullRestartAllMachines()"),
    stateSource.indexOf("async writeRootEnv", stateSource.indexOf("async gitPullRestartAllMachines()")),
  );

  assert.match(globalGitSource, /confirmDanger\(\{/);
  assert.match(globalGitSource, /\/api\/machines\/commands/);
  assert.match(globalGitSource, /commandType:\s*"git_pull_restart"/);
  assert.ok(globalGitSource.indexOf("confirmDanger({") < globalGitSource.indexOf("/api/machines/commands"));
  assert.match(pagesSource, /actions\.gitPullRestartAllMachines/);
});

test("completed config cleanup uses the shared confirmation before delete APIs", () => {
  const cleanupSource = stateSource.slice(
    stateSource.indexOf("async function promptToDeleteCompletedConfigs"),
    stateSource.indexOf("useEffect(() => {", stateSource.indexOf("async function promptToDeleteCompletedConfigs")),
  );

  assert.match(cleanupSource, /confirmDanger\(\{/);
  assert.match(cleanupSource, /title:\s*"완료된 Config 삭제 확인"/);
  assert.match(cleanupSource, /\/api\/configs\/\$\{encodeURIComponent\(candidate\.configId\)\}/);
  assert.ok(cleanupSource.indexOf("confirmDanger({") < cleanupSource.indexOf("/api/configs/"));
});
