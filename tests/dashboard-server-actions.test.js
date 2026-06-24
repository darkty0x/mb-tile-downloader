import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pagesSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../dashboard/client/components/dashboard-editor.jsx", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../dashboard/client/components/dashboard-state.js", import.meta.url), "utf8");

test("server table action controls stay vertically centered", () => {
  const serversTableSource = pagesSource.slice(
    pagesSource.indexOf("function ServersTable"),
    pagesSource.indexOf("function ResourceActionButtons", pagesSource.indexOf("function ServersTable")),
  );

  assert.match(serversTableSource, /text-right align-middle/);
  assert.match(serversTableSource, /className="flex items-center justify-end gap-1\.5"/);
  assert.match(serversTableSource, /className="state-layer inline-flex h-10 w-10 items-center justify-center[^"]*leading-none[^"]*"/);
});

test("storj completion proof rows expose a delete action", () => {
  const proofSource = pagesSource.slice(
    pagesSource.indexOf("{storjLinks.length ? ("),
    pagesSource.indexOf("function FleetHealthCard", pagesSource.indexOf("{storjLinks.length ? (")),
  );

  assert.match(pagesSource, /function PipelineOverview\(\{ overview, actions,/);
  assert.match(pagesSource, /<PipelineOverview overview=\{overview\} actions=\{actions\}/);
  assert.match(pagesSource, /<PipelineOverview\s+overview=\{overview\}\s+actions=\{actions\}/);
  assert.match(proofSource, /label="완료증명 삭제"/);
  assert.match(proofSource, /event\.stopPropagation\(\)/);
  assert.match(proofSource, /actions\.deleteMachineTask\(link\.machineId,\s*link\.jobId\)/);
});

test("selected server config tab exposes bulk delete action", () => {
  const configTabSource = pagesSource.slice(
    pagesSource.indexOf("function ServerPageConfigs"),
    pagesSource.indexOf("function envVariablesWithoutApiKeys", pagesSource.indexOf("function ServerPageConfigs")),
  );

  assert.match(configTabSource, /const deleteAllConfigs = \(\) => actions\.deleteConfigs\(state\.configs\)/);
  assert.match(configTabSource, /<AppButton variant="danger" icon="trash" disabled=\{!state\.configs\.length\} onClick=\{deleteAllConfigs\}>모두 삭제<\/AppButton>/);
  assert.match(stateSource, /async deleteConfigs\(configsToDelete\)/);
  assert.match(stateSource, /title: "Config 모두 삭제 확인"/);
  assert.match(stateSource, /confirmLabel: "모두 삭제"/);
});

test("start config order modal exposes select all controls and pointer checkbox", () => {
  const modalSource = pagesSource.slice(
    pagesSource.indexOf("function StartConfigOrderModal"),
    pagesSource.indexOf("function activeJobMeta", pagesSource.indexOf("function StartConfigOrderModal")),
  );

  assert.match(modalSource, /const selectAllItems = \(\) => onChange\(request\.items\.map\(\(item\) => \(\{ \.\.\.item, selected: true \}\)\)\);/);
  assert.match(modalSource, /const deselectAllItems = \(\) => onChange\(request\.items\.map\(\(item\) => \(\{ \.\.\.item, selected: false \}\)\)\);/);
  assert.match(modalSource, />모두 선택<\/AppButton>/);
  assert.match(modalSource, />모두 해제<\/AppButton>/);
  assert.match(modalSource, /className="h-5 w-5 shrink-0 cursor-pointer accent-\[var\(--ptg-primary\)\]"/);
});

test("server connection rows show exact stored endpoint and only verify action", () => {
  const sectionSource = pagesSource.slice(
    pagesSource.indexOf("function ServerConnectionsSection"),
    pagesSource.indexOf("export function ServerManagementPage", pagesSource.indexOf("function ServerConnectionsSection")),
  );
  const managementSource = pagesSource.slice(
    pagesSource.indexOf("export function ServerManagementPage"),
    pagesSource.indexOf("function activeJobMeta", pagesSource.indexOf("export function ServerManagementPage")),
  );

  assert.match(sectionSource, /serverConnectionProtocolUrl\(connection\)/);
  assert.match(sectionSource, /\[protocolUrl, connection\.credential\?\.username, machineNameForId\(state, targetMachineId\)\]/);
  assert.match(sectionSource, /serverConnectionTypeLabel\(connection\)/);
  assert.match(sectionSource, />검증<\/AppButton>/);
  assert.doesNotMatch(sectionSource, /manageServerConnection\(connection\.secretId\)/);
  assert.doesNotMatch(sectionSource, /Agent only/);
  assert.doesNotMatch(sectionSource, /RDP:\/\/server/);
  assert.doesNotMatch(sectionSource, /smolmusk|Yahoo/i);
  assert.match(managementSource, /\[serverConnectionTypeLabel\(connection\), endpoint, connection\.credential\?\.username, displayMachineId\(targetMachineId\)\]/);
  assert.match(editorSource, /serverConnectionTypeLabel\(connection\)/);
  assert.match(editorSource, /serverConnectionProtocolUrl\(connection\)/);
  assert.doesNotMatch(editorSource, /Agent only/);
  assert.doesNotMatch(editorSource, /RDP:\/\/server/);
});
