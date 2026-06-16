import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRanges } from "../../../src/config/config-loader.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIR, "../../..");
export const DEFAULT_CONFIG_TEMPLATES_DIR = path.join(PROJECT_ROOT, "configs");

const CONFIG_TYPE_FILE_PATTERN = /^(?:esri|mapbox)-.+\.config\.json$/;
const PROVIDER_ORDER = new Map([
  ["esri", 0],
  ["mapbox", 1],
]);

function clone(value) {
  return structuredClone(value);
}

function templateIdFromFile(fileName) {
  return fileName.replace(/\.config\.json$/, "");
}

function summarizeTemplate({ fileName, config, includeConfig }) {
  const id = templateIdFromFile(fileName);
  const provider = String(config.provider || "").toLowerCase();
  if (!PROVIDER_ORDER.has(provider)) {
    throw new Error(`${fileName}: config.provider must be one of: mapbox, esri`);
  }

  const ranges = normalizeRanges(config);
  const format = config.format || config.tile?.extension || "default";
  const label = config.jobName || id;

  return {
    id,
    label,
    provider,
    layer: config.layer || provider,
    format,
    extension: config.tile?.extension || format,
    rangeCount: ranges.length,
    sourcePath: `configs/${fileName}`,
    ...(includeConfig ? { config: clone(config) } : {}),
  };
}

export function slugifyJobName(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "dashboard-config";
}

export async function listConfigTemplates({
  templatesDir = DEFAULT_CONFIG_TEMPLATES_DIR,
  includeConfig = false,
} = {}) {
  let files;
  try {
    files = await readdir(templatesDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const templates = [];
  for (const fileName of files.filter((file) => CONFIG_TYPE_FILE_PATTERN.test(file)).sort()) {
    const filePath = path.join(templatesDir, fileName);
    let config;
    try {
      config = JSON.parse(await readFile(filePath, "utf8"));
    } catch (err) {
      throw new Error(`${fileName}: ${err.message}`);
    }
    templates.push(summarizeTemplate({ fileName, config, includeConfig }));
  }

  return templates.sort((a, b) => {
    const providerRank = (PROVIDER_ORDER.get(a.provider) ?? 99) - (PROVIDER_ORDER.get(b.provider) ?? 99);
    return providerRank || a.label.localeCompare(b.label);
  });
}

export async function selectConfigTemplates(templateIds, options = {}) {
  if (!Array.isArray(templateIds) || templateIds.length === 0) {
    throw new Error("templateIds must include at least one config type");
  }

  const requestedIds = [...new Set(templateIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (requestedIds.length === 0) {
    throw new Error("templateIds must include at least one config type");
  }

  const templates = await listConfigTemplates({ ...options, includeConfig: true });
  const byId = new Map(templates.map((template) => [template.id, template]));
  return requestedIds.map((id) => {
    const template = byId.get(id);
    if (!template) throw new Error(`unknown config type: ${id}`);
    return template;
  });
}

export function configNameForTemplate({ baseName, template, multiple }) {
  const cleanBase = String(baseName || "").trim();
  if (!cleanBase) return template.label;
  return multiple ? `${cleanBase} - ${template.label}` : cleanBase;
}

export function configJobNameForTemplate({ name, template }) {
  const nameSlug = slugifyJobName(name);
  return nameSlug.includes(template.id) ? nameSlug : `${nameSlug}-${template.id}`;
}
