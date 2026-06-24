import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseServerConnectionText, redactImportRows } from "../scripts/import-server-connection-profiles.js";
import { planServerConnectionProfileRepairs } from "../scripts/repair-server-connection-profiles.js";

const pagesSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../dashboard/client/components/dashboard-editor.jsx", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../dashboard/client/components/dashboard-state.js", import.meta.url), "utf8");
const seedSource = readFileSync(new URL("../scripts/seed-server-connection-profiles.js", import.meta.url), "utf8");

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

test("pipeline process table keeps stage and status text-only", () => {
  const processTableSource = pagesSource.slice(
    pagesSource.indexOf("{pipelineProcesses.length > 1 ? ("),
    pagesSource.indexOf("{storjLinks.length ? (", pagesSource.indexOf("{pipelineProcesses.length > 1 ? (")),
  );

  assert.doesNotMatch(pagesSource, /const PROCESS_STATUS_ICONS = \{/);
  assert.doesNotMatch(pagesSource, /function processStatusIcon\(process = \{\}\)/);
  assert.doesNotMatch(processTableSource, /<Icon name=\{processStageIcon\(process\.stageLabel \|\| process\.stage\)\}/);
  assert.doesNotMatch(processTableSource, /<Icon name=\{processStatusIcon\(process\)\}/);
  assert.match(processTableSource, /<StatusPill status=\{process\.tone\}>\{process\.statusLabel\}<\/StatusPill>/);
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
  assert.match(sectionSource, /serverConnectionEndpointLabel\(connection\)/);
  assert.match(sectionSource, /\[endpointLabel, connection\.credential\?\.username, machineNameForId\(state, targetMachineId\)\]/);
  assert.match(sectionSource, /serverConnectionTypeLabel\(connection\)/);
  assert.match(sectionSource, />검증<\/AppButton>/);
  assert.doesNotMatch(sectionSource, /manageServerConnection\(connection\.secretId\)/);
  assert.doesNotMatch(sectionSource, /Agent only/);
  assert.doesNotMatch(sectionSource, /RDP:\/\/server/);
  assert.doesNotMatch(sectionSource, /smolmusk|Yahoo/i);
  assert.match(managementSource, /serverConnectionEndpointLabel\(connection\)/);
  assert.match(managementSource, /\[serverConnectionTypeLabel\(connection\), endpoint, connection\.credential\?\.username, displayMachineId\(targetMachineId\)\]/);
  assert.match(editorSource, /serverConnectionTypeLabel\(connection\)/);
  assert.match(editorSource, /serverConnectionProtocolUrl\(connection\)/);
  assert.match(editorSource, /serverConnectionEndpointLabel\(connection\)/);
  assert.doesNotMatch(editorSource, /Agent only/);
  assert.doesNotMatch(editorSource, /RDP:\/\/server/);
});

test("server credential importer parses pasted real endpoint blocks without exposing passwords in previews", () => {
  const rows = parseServerConnectionText(
    [
      "#01 (1TB)",
      "IP: 95.216.247.19:7777",
      "Username: root",
      "Password: dummy-password-1",
      "",
      "#02 (500GB)",
      "IP: 195.201.245.29:7777",
      "Username: root",
      "Password: dummy-password-2",
    ].join("\n")
  );

  assert.deepEqual(rows.map((row) => [row.label, row.machineId, row.protocolUrl, row.username]), [
    ["봉사기 1", "server-01", "ssh://95.216.247.19:7777", "root"],
    ["봉사기 2", "server-02", "ssh://195.201.245.29:7777", "root"],
  ]);
  assert.equal(redactImportRows(rows)[0].hasPassword, true);
  assert.equal(JSON.stringify(redactImportRows(rows)).includes("dummy-password"), false);
});

test("server connection seeding defaults to PC agent-only profiles", () => {
  assert.match(seedSource, /protocol: "agent"/);
  assert.match(seedSource, /protocolUrl: isAgentProfile \? `agent:\/\/\$\{machineId\}`/);
  assert.match(seedSource, /username: isAgentProfile \? "" : opts\.username/);
  assert.match(seedSource, /password: isAgentProfile \? "" : opts\.password/);
});

test("server connection repair plan converts fake RDP profiles to PC agent profiles", () => {
  const plan = planServerConnectionProfileRepairs(
    [
      {
        secretId: "secret-server-01",
        secretType: "server_rdp_credential",
        label: "봉사기 1",
        credential: {
          protocol: "rdp",
          protocolUrl: "rdp://server-01:3389",
          machineId: "server-01",
          username: "smolmusk@yahoo.com",
        },
      },
      {
        secretId: "secret-server-02",
        secretType: "server_rdp_credential",
        label: "봉사기 2",
        credential: {
          protocol: "agent",
          protocolUrl: "agent://server-02",
          machineId: "server-02",
          username: "",
        },
      },
    ],
    [
      { label: "봉사기 1", machineId: "server-01", protocolUrl: "agent://server-01" },
      { label: "봉사기 2", machineId: "server-02", protocolUrl: "agent://server-02" },
    ]
  );

  assert.deepEqual(plan.map((item) => [item.machineId, item.action, item.protocolUrl, item.previousUsername]), [
    ["server-01", "repair", "agent://server-01", "smolmusk@yahoo.com"],
    ["server-02", "ok", "agent://server-02", ""],
  ]);
});
