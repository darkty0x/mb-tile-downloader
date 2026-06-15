import { promises as fsp } from "node:fs";
import path from "node:path";

import { createProvider } from "../providers/index.js";

function renderPathTemplate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) {
      throw new Error(`Missing path template value: ${key}`);
    }
    return String(values[key]);
  });
}

export function tilePathForConfig(config, provider, z, x, y) {
  const template = config.output?.pathTemplate || "{layer}/{z}/{x}/{y}.{extension}";
  const rel = renderPathTemplate(template, {
    provider: config.provider,
    layer: config.layer,
    format: config.format,
    extension: provider.extension,
    z,
    x,
    y,
  });
  return path.join(config.output.dir, path.normalize(rel));
}

export async function localEsriTileStatus(config, provider, z, x, y) {
  const filePath = tilePathForConfig(config, provider, z, x, y);
  let buffer;
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile() || st.size <= 0) return "missing";
    buffer = await fsp.readFile(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return "missing";
    throw err;
  }
  return provider.isUnavailable?.(buffer) ? "unavailable" : "present";
}

function normalizedZoomRange(range) {
  const zStart = range.zoomStart ?? range.zoom ?? range.z;
  const zEnd = range.zoomEnd ?? range.zoom ?? range.z ?? zStart;
  return { zStart, zEnd };
}

async function firstEsriHealthcheckUrl(config, provider) {
  let firstMissingUrl = "";
  if (!Array.isArray(config.ranges)) return "";

  for (const range of config.ranges) {
    const { zStart, zEnd } = normalizedZoomRange(range);
    for (let z = zStart; z <= zEnd; z++) {
      for (let x = range.xStart; x <= range.xEnd; x++) {
        for (let y = range.yStart; y <= range.yEnd; y++) {
          const url = provider.buildUrl({ z, x, y });
          const status = await localEsriTileStatus(config, provider, z, x, y);
          if (status === "unavailable") return url;
          if (status === "missing" && !firstMissingUrl) firstMissingUrl = url;
        }
      }
    }
  }

  return firstMissingUrl;
}

function firstRangeUrl(config, provider) {
  const range = Array.isArray(config.ranges) ? config.ranges[0] : null;
  if (!range) return "";
  const { zStart } = normalizedZoomRange(range);
  return provider.buildUrl({ z: zStart, x: range.xStart, y: range.yStart });
}

export async function proxyHealthcheckUrlForConfig(config) {
  if (config.provider !== "esri") return "";
  const provider = createProvider(config);
  return (await firstEsriHealthcheckUrl(config, provider)) || firstRangeUrl(config, provider);
}
