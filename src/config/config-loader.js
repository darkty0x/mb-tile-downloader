import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { loadMapboxTokensFromEnv } from "../auth/mapbox-token-pool.js";
import { resolveOutputStorage } from "../runtime/output-storage.js";
import { buildPlatformProfile } from "../runtime/platform-profile.js";

const PROVIDERS = new Set(["mapbox", "esri"]);

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireInteger(value, name) {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function validateRange(range) {
  for (const key of ["zoomStart", "zoomEnd", "xStart", "xEnd", "yStart", "yEnd"]) {
    requireInteger(range[key], `range.${key}`);
  }
  if (range.zoomEnd < range.zoomStart) throw new Error("range.zoomEnd < range.zoomStart");
  if (range.xEnd < range.xStart) throw new Error("range.xEnd < range.xStart");
  if (range.yEnd < range.yStart) throw new Error("range.yEnd < range.yStart");

  for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
    const max = 2 ** z - 1;
    if (range.xStart < 0 || range.xEnd > max || range.yStart < 0 || range.yEnd > max) {
      throw new Error(
        `range coordinates outside valid tile bounds for zoom ${z}: expected 0..${max}`
      );
    }
  }
}

export function summarizeOperationalRangeWarnings(ranges = []) {
  const warnings = [];
  for (const range of ranges) {
    for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
      const max = 2 ** z - 1;
      const xCount = range.xEnd - range.xStart + 1;
      const yCount = range.yEnd - range.yStart + 1;
      const tileCount = xCount * yCount;
      if (range.yStart === 0 && range.yEnd === max && tileCount >= 1_000_000) {
        warnings.push({
          type: "full-y-span",
          message:
            `range ${range.label || `z=${z} x=${range.xStart}-${range.xEnd}`} covers the full y span ` +
            `0-${max} at z=${z}; ${tileCount.toLocaleString("en-US")} tiles will run row-by-row`,
          z,
          xStart: range.xStart,
          xEnd: range.xEnd,
          yStart: range.yStart,
          yEnd: range.yEnd,
          tileCount,
        });
      }
    }
  }
  return warnings;
}

function tileYToLatitude(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function shouldAutoInvertUkraineY(config, range) {
  const name = `${config?.jobName || ""} ${config?.name || ""}`.toLowerCase();
  if (!name.includes("ukraine")) return false;
  if (range.zoomStart !== range.zoomEnd) return false;
  const z = range.zoomStart;
  const max = 2 ** z - 1;
  const centerY = (range.yStart + range.yEnd) / 2;
  const currentLat = tileYToLatitude(centerY, z);
  const invertedCenterY = max - centerY;
  const invertedLat = tileYToLatitude(invertedCenterY, z);
  return currentLat < 0 && invertedLat >= 44 && invertedLat <= 54;
}

function autoCorrectUkraineY(config, range) {
  if (!shouldAutoInvertUkraineY(config, range)) return range;
  const max = 2 ** range.zoomStart - 1;
  return {
    ...range,
    yStart: max - range.yEnd,
    yEnd: max - range.yStart,
    label: `${range.label} y=tms->xyz`,
    autoCorrectedY: "tms-to-xyz",
  };
}

export function normalizeRanges(config) {
  const { ranges, zoomStart, zoomEnd, xStart, xEnd, yStart, yEnd } = config || {};

  if (Array.isArray(ranges) && ranges.length > 0) {
    return ranges.map((range, idx) => {
      const zStart = range.zoom ?? range.z ?? range.zoomStart;
      const zEnd = range.zoom ?? range.z ?? range.zoomEnd ?? zStart;
      const normalized = {
        zoomStart: zStart,
        zoomEnd: zEnd,
        xStart: range.xStart,
        xEnd: range.xEnd,
        yStart: range.yStart,
        yEnd: range.yEnd,
        label:
          range.label ||
          `range#${idx + 1}: z=${zStart}${zEnd !== zStart ? `-${zEnd}` : ""} x=${range.xStart}-${range.xEnd} y=${range.yStart}-${range.yEnd}`,
      };
      const corrected = autoCorrectUkraineY(config, normalized);
      validateRange(corrected);
      return corrected;
    });
  }

  if (zoomStart !== undefined && xStart !== undefined) {
    const normalized = {
      zoomStart,
      zoomEnd: zoomEnd ?? zoomStart,
      xStart,
      xEnd,
      yStart,
      yEnd,
      label: "legacy-range",
    };
    const corrected = autoCorrectUkraineY(config, normalized);
    validateRange(corrected);
    return [corrected];
  }

  throw new Error("No valid ranges found in config");
}

function resolvePlatformPath(config, baseKey, configDir, fallback) {
  const suffix =
    process.platform === "darwin"
      ? "Mac"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";
  const selected = config[`${baseKey}${suffix}`] || config[baseKey] || fallback;
  if (!selected) return selected;
  if (/^[a-z]+:\/\//i.test(selected)) return selected;
  return path.isAbsolute(selected) ? selected : path.resolve(configDir, selected);
}

function providerDefaults(provider, format) {
  if (provider === "esri") {
    return {
      layer: "esri-satellite",
      format: format || "jpg",
      url: {
        template:
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      },
      tile: {
        extension: format || "jpg",
        yScheme: "xyz",
      },
    };
  }

  return {
    layer: "vector",
    format: format || "pbf",
    url: {
      template:
        "https://{host}.tiles.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{extension}?access_token={token}",
      hosts: ["a", "b", "c", "d"],
    },
    tile: {
      extension: format === "pbf" || !format ? "vector.pbf" : format,
      yScheme: "xyz",
    },
  };
}

export async function loadConfig(configPath, options = {}) {
  const absPath = path.resolve(configPath);
  const configDir = path.dirname(absPath);
  const raw = JSON.parse(await fsp.readFile(absPath, "utf8"));

  const provider = String(raw.provider || "").toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error("config.provider must be one of: mapbox, esri");
  }

  const validateCredentials = options.validateCredentials !== false;
  if (validateCredentials && provider === "mapbox" && loadMapboxTokensFromEnv(options.env).length === 0) {
    throw new Error(
      "MAPBOX_ACCESS_TOKENS is required for Mapbox downloads; provide one or more tokens"
    );
  }

  const defaults = providerDefaults(provider, raw.format);
  const layer = raw.layer || defaults.layer;
  const format = raw.format || defaults.format;
  const tile = { ...defaults.tile, ...(raw.tile || {}) };
  const url = { ...defaults.url, ...(raw.url || {}) };
  const ranges = normalizeRanges(raw);
  const operationalWarnings = summarizeOperationalRangeWarnings(ranges);
  const output = await resolveOutputStorage({
    dir: resolvePlatformPath(
      {
        outputDir: raw.output?.dir || raw.outputDir,
        outputDirMac: raw.output?.dirMac || raw.outputDirMac,
        outputDirWindows: raw.output?.dirWindows || raw.outputDirWindows,
        outputDirLinux: raw.output?.dirLinux || raw.outputDirLinux,
      },
      "outputDir",
      configDir,
      "tiles"
    ),
    configDir,
    env: options.env || process.env,
    platform: options.platform || process.platform,
    projectDir: options.projectDir || process.cwd(),
    collectDiskInfoImpl: options.collectDiskInfoImpl,
  });
  output.pathTemplate =
    raw.output?.pathTemplate || "{layer}/{z}/{x}/{y}.{extension}";
  const performance = {
    maxConcurrentRequests:
      raw.performance?.maxConcurrentRequests || raw.concurrency,
    maxRowsInFlight: raw.performance?.maxRowsInFlight || raw.rowConcurrency,
    requestTimeoutMs: raw.performance?.requestTimeoutMs || raw.fetchTimeoutMs,
    maxRetries: raw.performance?.maxRetries || raw.retryPerHost || 3,
    retryBackoffMs: raw.performance?.retryBackoffMs || raw.retryBackoffMs || 150,
  };
  const platformProfile = buildPlatformProfile({
    platform: options.platform || process.platform,
    requestedConcurrency: performance.maxConcurrentRequests,
    requestedRows: performance.maxRowsInFlight,
    requestTimeoutMs: performance.requestTimeoutMs,
    provider,
    env: options.env || process.env,
    defaultProxyFilePath: options.defaultProxyFilePath,
  });
  const jobName = raw.jobName || `${provider}-${layer}-${format}`;

  const effectiveForHash = {
    provider,
    layer,
    format,
    tile,
    url,
    output,
    ranges,
  };

  return {
    configPath: absPath,
    configDir,
    jobName,
    provider,
    layer,
    format,
    url,
    tile,
    ranges,
    operationalWarnings,
    output,
    performance,
    platformProfile,
    verifyAfterDownload: parseBoolean(raw.verifyAfterDownload) ?? true,
    assumeEmpty: Boolean(raw.assumeEmpty),
    configHash: sha256(stableStringify(effectiveForHash)),
    raw,
  };
}
