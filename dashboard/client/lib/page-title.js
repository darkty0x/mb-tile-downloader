import { buildOverviewModel, jobPipelineStepNumber, jobStageProgressPercent } from "./overview-model.js";
import { findMachineById, normalizeMachineId, sameMachineId } from "../components/dashboard-core.js";

const BASE_TITLE = "PTG 관리체계";

function targetMachineIdForServerPage(state = {}) {
  if (state.authStatus && state.authStatus !== "authenticated") return null;
  if (state.selectedTab !== "servers" || state.editor?.type !== "server-management") return null;

  const connection = state.secretPool?.find((item) => item.secretId === state.editor.id);
  return normalizeMachineId(
    connection?.targetMachineId
      || connection?.credential?.machineId
      || connection?.machineId
      || state.editor.machineId
      || state.selectedMachineId
  ) || null;
}

function compactServerNumber(machineId) {
  const match = /(?:^|[\s_-])server[\s_-]*(\d+)(?:\b|$)/i.exec(String(machineId || ""));
  if (!match) return String(machineId || "").trim().toUpperCase();
  return match[1].padStart(2, "0");
}

function serverTitleStatus(state = {}, machineId) {
  const machine = findMachineById(state.machines || [], machineId);
  const selectedMatchesTarget = sameMachineId(state.selectedMachineId, machineId);
  const overview = buildOverviewModel({
    machines: machine ? [machine] : [],
    configs: selectedMatchesTarget ? state.configs || [] : [],
    events: selectedMatchesTarget ? state.events || [] : [],
    jobs: selectedMatchesTarget ? state.jobs || [] : [],
    secretPool: state.secretPool || [],
    settings: state.settings || {},
    machineId,
  });
  const stepNumber = jobPipelineStepNumber(overview.activeJob) || 0;
  const progress = overview.activeJob ? jobStageProgressPercent(overview.activeJob) : 0;
  return `${compactServerNumber(machineId)}:${stepNumber}:${progress}%`;
}

export function buildDashboardDocumentTitle(state = {}) {
  const targetMachineId = targetMachineIdForServerPage(state);
  if (!targetMachineId) return BASE_TITLE;
  return `${BASE_TITLE} | ${serverTitleStatus(state, targetMachineId)}`;
}
