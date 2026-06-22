import { buildOverviewModel } from "./overview-model.js";

export function completedConfigDeleteCandidates({ configs = [], jobs = [], machines = [] } = {}) {
  const configById = new Map((configs || []).map((config) => [config.configId, config]));
  const seenConfigIds = new Set();
  const overview = buildOverviewModel({ machines, configs, jobs });

  return (overview.storjLinks || [])
    .map((link) => {
      const configId = String(link.configId || "").trim();
      if (!configId || seenConfigIds.has(configId) || !configById.has(configId)) return null;
      seenConfigIds.add(configId);
      const config = configById.get(configId);
      return {
        configId,
        configName: config?.name || link.configName || configId,
        machineId: config?.machineId || "",
        shareUrl: link.shareUrl || "",
      };
    })
    .filter(Boolean);
}

export function completedConfigPromptKey(candidates = []) {
  return candidates
    .map((candidate) => `${candidate.configId}:${candidate.shareUrl || ""}`)
    .sort()
    .join("|");
}
