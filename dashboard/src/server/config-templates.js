import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIR, "../../..");
export const DEFAULT_CONFIG_TEMPLATES_DIR = path.join(PROJECT_ROOT, "configs");

const CONFIG_TYPE_FILE_PATTERN = /^(?:esri|mapbox)-.+\.config\.json$/;
const PROVIDER_ORDER = new Map([
  ["esri", 0],
  ["mapbox", 1],
]);
const DEFAULT_RANGE = { zoom: 1, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 };
const DEFAULT_OUTPUT = {
  dir: "../tiles",
  pathTemplate: "{layer}/{z}/{x}/{y}.{extension}",
};
const DEFAULT_PERFORMANCE = {
  maxConcurrentRequests: 4096,
  maxRowsInFlight: 1,
  requestTimeoutMs: 25000,
  maxRetries: 3,
  retryBackoffMs: 150,
};
const BUILT_IN_CONFIGS = [
  {
    id: "esri-satellite",
    config: {
      jobName: "esri-satellite",
      provider: "esri",
      layer: "esri-satellite",
      format: "jpg",
      url: {
        template: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      },
      tile: { extension: "jpg", yScheme: "xyz", unavailableTileSha256: [] },
      output: DEFAULT_OUTPUT,
      performance: { ...DEFAULT_PERFORMANCE, maxRetries: 4 },
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-dem",
    config: {
      jobName: "mapbox-dem",
      provider: "mapbox",
      layer: "dem",
      format: "pngraw",
      url: {
        template: "https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token={token}",
        hosts: ["api"],
        tileset: "mapbox.terrain-rgb",
        extension: "pngraw",
      },
      tile: { extension: "pngraw", yScheme: "xyz" },
      output: DEFAULT_OUTPUT,
      performance: DEFAULT_PERFORMANCE,
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-pbf",
    config: {
      jobName: "mapbox-pbf",
      provider: "mapbox",
      layer: "vector",
      format: "pbf",
      url: {
        tileset: "mapbox.mapbox-bathymetry-v2,mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2,mapbox.mapbox-models-v1",
        extension: "vector.pbf",
      },
      output: DEFAULT_OUTPUT,
      performance: { ...DEFAULT_PERFORMANCE, maxRetries: 4 },
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-raster-tileset",
    config: {
      jobName: "mapbox-raster-tileset",
      provider: "mapbox",
      layer: "raster",
      format: "jpg90",
      url: {
        template: "https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}{scale}.{extension}?access_token={token}",
        tileset: "mapbox.satellite",
        scale: "@2x",
        extension: "jpg90",
      },
      tile: { extension: "jpg", yScheme: "xyz" },
      output: DEFAULT_OUTPUT,
      performance: DEFAULT_PERFORMANCE,
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-rasterarray-mrt",
    config: {
      jobName: "mapbox-rasterarray-mrt",
      provider: "mapbox",
      layer: "rasterarray",
      format: "mrt",
      url: {
        template: "https://api.mapbox.com/rasterarrays/v1/{tileset}/{z}/{x}/{y}.mrt?access_token={token}",
        tileset: "username.tileset",
      },
      tile: { extension: "mrt", yScheme: "xyz" },
      output: DEFAULT_OUTPUT,
      performance: DEFAULT_PERFORMANCE,
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-satellite",
    config: {
      jobName: "mapbox-satellite",
      provider: "mapbox",
      layer: "satellite",
      format: "jpg",
      url: {
        template: "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token={token}",
        hosts: ["api"],
        tileset: "unused",
        extension: "jpg",
      },
      tile: { extension: "jpg", yScheme: "xyz" },
      output: DEFAULT_OUTPUT,
      performance: DEFAULT_PERFORMANCE,
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-style-static-tiles",
    config: {
      jobName: "mapbox-style-static-tiles",
      provider: "mapbox",
      layer: "style-raster",
      format: "jpg",
      url: {
        template: "https://api.mapbox.com/styles/v1/{username}/{styleId}/tiles/{tileSize}/{z}/{x}/{y}{scale}?access_token={token}",
        username: "mapbox",
        styleId: "satellite-v9",
        tileSize: 512,
        scale: "",
      },
      tile: { extension: "jpg", yScheme: "xyz" },
      output: DEFAULT_OUTPUT,
      performance: DEFAULT_PERFORMANCE,
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-vector-mvt",
    config: {
      jobName: "mapbox-vector-mvt",
      provider: "mapbox",
      layer: "vector",
      format: "mvt",
      url: {
        template: "https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{extension}?access_token={token}",
        tileset: "mapbox.mapbox-streets-v8",
        extension: "mvt",
      },
      tile: { extension: "mvt", yScheme: "xyz" },
      output: DEFAULT_OUTPUT,
      performance: DEFAULT_PERFORMANCE,
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
  {
    id: "mapbox-vector-style-optimized",
    config: {
      jobName: "mapbox-vector-style-optimized",
      provider: "mapbox",
      layer: "vector-optimized",
      format: "mvt",
      url: {
        template: "https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{extension}?style={style}&access_token={token}",
        tileset: "mapbox.mapbox-streets-v8",
        style: "mapbox://styles/mapbox/streets-v12@00",
        extension: "mvt",
      },
      tile: { extension: "mvt", yScheme: "xyz" },
      output: DEFAULT_OUTPUT,
      performance: DEFAULT_PERFORMANCE,
      verifyAfterDownload: true,
      ranges: [DEFAULT_RANGE],
    },
  },
];

function clone(value) {
  return structuredClone(value);
}

export function stripTemplateRanges(config) {
  const next = clone(config);
  delete next.ranges;
  delete next.zoom;
  delete next.z;
  delete next.zoomStart;
  delete next.zoomEnd;
  delete next.xStart;
  delete next.xEnd;
  delete next.yStart;
  delete next.yEnd;
  return next;
}

function templateIdFromFile(fileName) {
  return fileName.replace(/\.config\.json$/, "");
}

function summarizeTemplate({ fileName, id: inputId, config, includeConfig, sourcePath, sourceType = "file" }) {
  const id = inputId || templateIdFromFile(fileName);
  const provider = String(config.provider || "").toLowerCase();
  if (!PROVIDER_ORDER.has(provider)) {
    throw new Error(`${fileName || id}: config.provider must be one of: mapbox, esri`);
  }

  const format = config.format || config.tile?.extension || "default";
  const label = config.jobName || id;

  return {
    id,
    label,
    provider,
    layer: config.layer || provider,
    format,
    extension: config.tile?.extension || format,
    sourcePath: sourcePath || `configs/${fileName}`,
    sourceType,
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
  const byId = new Map(BUILT_IN_CONFIGS.map((template) => [
    template.id,
    summarizeTemplate({
      id: template.id,
      config: template.config,
      includeConfig,
      sourcePath: `preset:${template.id}`,
      sourceType: "preset",
    }),
  ]));

  let files;
  try {
    files = await readdir(templatesDir);
  } catch (err) {
    if (err.code === "ENOENT") files = [];
    else throw err;
  }

  for (const fileName of files.filter((file) => CONFIG_TYPE_FILE_PATTERN.test(file)).sort()) {
    const filePath = path.join(templatesDir, fileName);
    let config;
    try {
      config = JSON.parse(await readFile(filePath, "utf8"));
    } catch (err) {
      throw new Error(`${fileName}: ${err.message}`);
    }
    const template = summarizeTemplate({ fileName, config, includeConfig });
    byId.set(template.id, template);
  }

  return [...byId.values()].sort((a, b) => {
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
