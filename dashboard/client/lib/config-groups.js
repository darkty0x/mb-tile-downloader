function cleanName(value) {
  return String(value || "Config 화일").replace(/\.config\.json$/i, "").replace(/\.json$/i, "").replace(/\s+-\s+/g, "-").trim();
}

function normalizeValue(value) {
  return String(value || "").trim().toLowerCase();
}

function configFormat(config = {}) {
  return config.format || config.tile?.extension || "default";
}

export function inferConfigTemplateId(configRecord = {}, templates = []) {
  const name = cleanName(configRecord.name || configRecord.config?.jobName);
  const config = configRecord.config || {};
  const provider = normalizeValue(config.provider);
  const layer = normalizeValue(config.layer);
  const format = normalizeValue(configFormat(config));
  const extension = normalizeValue(config.tile?.extension || format);

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
  const name = cleanName(configRecord.name || configRecord.config?.jobName);
  const suffix = normalizeValue(templateId);
  if (suffix && name.toLowerCase().endsWith(`-${suffix}`)) {
    return name.slice(0, -(suffix.length + 1));
  }
  return name;
}

export function buildConfigGroups(configs = [], templates = []) {
  const templateIds = templates.map((template) => template.id);
  const byKey = new Map();

  for (const config of configs) {
    const templateId = inferConfigTemplateId(config, templates);
    const groupName = configGroupName(config, templateId);
    const machineId = config.machineId || "";
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
    (a.machineId || "").localeCompare(b.machineId || "")
    || a.name.localeCompare(b.name)
  ));
}
