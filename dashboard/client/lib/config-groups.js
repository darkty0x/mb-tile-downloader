import { compareMachineIds } from "./machine-sort.js";

function cleanName(value) {
  return String(value || "Config 화일").replace(/\.config\.json$/i, "").replace(/\.json$/i, "").replace(/\s+-\s+/g, "-").trim();
}

function normalizeValue(value) {
  return String(value || "").trim().toLowerCase();
}

function parseConfigContent(content) {
  if (!content || typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function configFromRecord(configRecord = {}) {
  if (configRecord.config && typeof configRecord.config === "object") return configRecord.config;
  return parseConfigContent(configRecord.content) || {};
}

function configRecordName(configRecord = {}) {
  const config = configFromRecord(configRecord);
  return cleanName(configRecord.name || config.jobName || configRecord.fileName || configRecord.path || configRecord.absolutePath);
}

function configFormat(config = {}, configRecord = {}) {
  return config.format || configRecord.format || config.tile?.extension || configRecord.extension || "default";
}

export function inferConfigTemplateId(configRecord = {}, templates = []) {
  const name = configRecordName(configRecord);
  const config = configFromRecord(configRecord);
  const provider = normalizeValue(config.provider || configRecord.provider);
  const layer = normalizeValue(config.layer || configRecord.layer);
  const format = normalizeValue(configFormat(config, configRecord));
  const extension = normalizeValue(config.tile?.extension || configRecord.extension || format);

  const suffixMatch = templates.find((template) => name.toLowerCase().endsWith(`-${normalizeValue(template.id)}`));
  if (suffixMatch) return suffixMatch.id;

  const exactMatch = templates.find((template) => (
    normalizeValue(template.provider) === provider
    && normalizeValue(template.layer) === layer
    && (
      normalizeValue(template.format) === format
      || normalizeValue(template.extension) === extension
    )
  ));
  return exactMatch?.id || "";
}

export function configGroupName(configRecord = {}, templateId = "") {
  const name = configRecordName(configRecord);
  const suffix = normalizeValue(templateId);
  if (suffix && name.toLowerCase().endsWith(`-${suffix}`)) {
    return name.slice(0, -(suffix.length + 1));
  }
  return name;
}

function collectMachineLocalConfigs(machines = []) {
  return (machines || []).flatMap((machine) => {
    const machineId = machine?.machineId || machine?.agentId || "";
    return (machine?.agentSnapshot?.configs || []).map((item) => {
      const config = configFromRecord(item);
      return {
        ...item,
        source: "local",
        machineId,
        name: configRecordName({ ...item, config }),
        provider: config.provider || item.provider,
        layer: config.layer || item.layer,
        format: configFormat(config, item),
        ranges: config.ranges || item.ranges || [],
        config,
      };
    });
  });
}

export function buildConfigGroups(configs = [], templates = [], machines = []) {
  const templateIds = templates.map((template) => template.id);
  const byKey = new Map();
  const allConfigs = [
    ...(configs || []).map((config) => ({ ...config, source: config.source || "dashboard" })),
    ...collectMachineLocalConfigs(machines),
  ];
  const seenConfigs = new Set();

  for (const config of allConfigs) {
    const templateId = inferConfigTemplateId(config, templates);
    const groupName = configGroupName(config, templateId);
    const machineId = config.machineId || "";
    const configIdentity = `${machineId}\u0000${groupName}\u0000${templateId || configRecordName(config)}`;
    if (seenConfigs.has(configIdentity)) continue;
    seenConfigs.add(configIdentity);
    const key = `${machineId}\u0000${groupName}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: groupName,
        machineId,
        configCount: 0,
        enabledTemplateIds: [],
        templates: templates.map((template) => ({ ...template, enabled: false, config: null })),
        configs: [],
      });
    }
    const group = byKey.get(key);
    group.configCount += 1;
    group.configs.push(config);
    if (templateId && !group.enabledTemplateIds.includes(templateId)) {
      group.enabledTemplateIds.push(templateId);
    }
  }

  const order = new Map(templateIds.map((id, index) => [id, index]));
  for (const group of byKey.values()) {
    group.enabledTemplateIds.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b));
    group.templates = group.templates.map((template) => {
      const config = group.configs.find((item) => inferConfigTemplateId(item, templates) === template.id) || null;
      return { ...template, enabled: Boolean(config), config };
    });
  }

  return [...byKey.values()].sort((a, b) => (
    compareMachineIds(a.machineId || "", b.machineId || "")
    || a.name.localeCompare(b.name)
  ));
}

export function planConfigGroupUpdate(group = {}, selectedTemplateIds = []) {
  const selected = new Set(selectedTemplateIds.map((id) => String(id || "").trim()).filter(Boolean));
  const existingTemplates = (group.templates || []).filter((template) => template.enabled && template.config?.configId);
  const existingIds = new Set(existingTemplates.map((template) => template.id));

  return {
    addTemplateIds: [...selected].filter((id) => !existingIds.has(id)),
    removeConfigIds: existingTemplates
      .filter((template) => !selected.has(template.id))
      .map((template) => template.config.configId),
  };
}

export function planConfigGroupAssignmentUpdate(group = {}, selectedTemplateIds = [], { name, machineIds = [] } = {}) {
  const selected = new Set(selectedTemplateIds.map((id) => String(id || "").trim()).filter(Boolean));
  const targetName = cleanName(name || group.name || "");
  const targetMachineIds = machineIds.map((id) => String(id || "").trim()).filter(Boolean);
  const targetMachineId = targetMachineIds.length === 1 ? targetMachineIds[0] : String(group.machineId || "").trim();
  return (group.templates || [])
    .filter((template) => selected.has(template.id) && template.enabled && template.config?.configId)
    .map((template) => {
      const current = template.config;
      const nextName = targetName && template.id ? `${targetName}-${template.id}` : current.name;
      const nextConfig = {
        ...(current.config || {}),
        jobName: nextName,
      };
      const machineChanged = String(current.machineId || "").trim() !== targetMachineId;
      const nameChanged = String(current.name || "").trim() !== nextName;
      const jobNameChanged = String(current.config?.jobName || "").trim() !== nextName;
      if (!machineChanged && !nameChanged && !jobNameChanged) return null;
      return {
        configId: current.configId,
        machineId: targetMachineId || null,
        name: nextName,
        config: nextConfig,
      };
    })
    .filter(Boolean);
}
