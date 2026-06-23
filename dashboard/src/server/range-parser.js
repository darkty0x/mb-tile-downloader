import { normalizeRanges } from "../../../src/config/config-loader.js";

function clampLatitude(latitude) {
  return Math.max(-85.05112878, Math.min(85.05112878, latitude));
}

function longitudeToTileX(longitude, zoom) {
  const n = 2 ** zoom;
  return Math.max(0, Math.min(n - 1, Math.floor(((longitude + 180) / 360) * n)));
}

function latitudeToTileY(latitude, zoom) {
  const latRad = (clampLatitude(latitude) * Math.PI) / 180;
  const n = 2 ** zoom;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return Math.max(0, Math.min(n - 1, Math.floor(y)));
}

function tileXToLongitude(tileX, zoom) {
  return (tileX / (2 ** zoom)) * 360 - 180;
}

function tileYToLatitude(tileY, zoom) {
  const n = Math.PI - (2 * Math.PI * tileY) / (2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function roundCoordinate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseNumber(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} must be a number`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number`);
  return number;
}

function parseLongitude(value, name = "longitude") {
  const longitude = parseNumber(value, name);
  if (longitude < -180 || longitude > 180) throw new Error(`${name} must be between -180 and 180`);
  return longitude;
}

function parseLatitude(value, name = "latitude") {
  const latitude = parseNumber(value, name);
  if (latitude < -85.05112878 || latitude > 85.05112878) {
    throw new Error(`${name} must be between -85.05112878 and 85.05112878`);
  }
  return latitude;
}

function parseInteger(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function normalizeZooms({ zoom, zoomStart, zoomEnd } = {}) {
  const firstValue = [zoom, zoomStart, zoomEnd].find((value) => value !== undefined && value !== null && value !== "");
  const lastValue = [zoomEnd, zoom, zoomStart].find((value) => value !== undefined && value !== null && value !== "");
  const zStart = parseInteger(firstValue, "zoom");
  const zEnd = parseInteger(lastValue, "zoomEnd");
  if (zEnd < zStart) throw new Error("zoomEnd must be greater than or equal to zoomStart");
  return { zoomStart: zStart, zoomEnd: zEnd };
}

function normalizePointZooms(zoomOptions = {}) {
  return normalizeZooms({
    zoomStart: zoomOptions.zoomStart === undefined || zoomOptions.zoomStart === null || zoomOptions.zoomStart === "" ? 1 : zoomOptions.zoomStart,
    zoomEnd: zoomOptions.zoomEnd === undefined || zoomOptions.zoomEnd === null || zoomOptions.zoomEnd === "" ? 19 : zoomOptions.zoomEnd,
    zoom: zoomOptions.zoom,
  });
}

function rangesFromBounds({ west, south, east, north, zoomStart, zoomEnd, label }) {
  const ranges = [];
  for (let zoom = zoomStart; zoom <= zoomEnd; zoom++) {
    ranges.push({
      zoom,
      xStart: longitudeToTileX(west, zoom),
      xEnd: longitudeToTileX(east, zoom),
      yStart: latitudeToTileY(north, zoom),
      yEnd: latitudeToTileY(south, zoom),
      label: label || `bounds z=${zoom} lon=${west}-${east} lat=${south}-${north}`,
    });
  }
  return normalizeRanges({ ranges });
}

function rangesFromPoint({ latitude, longitude, zoomStart, zoomEnd }) {
  const ranges = [];
  for (let zoom = zoomStart; zoom <= zoomEnd; zoom++) {
    const x = longitudeToTileX(longitude, zoom);
    const y = latitudeToTileY(latitude, zoom);
    ranges.push({
      zoom,
      xStart: x,
      xEnd: x,
      yStart: y,
      yEnd: y,
      label: `point z=${zoom} lat=${latitude} lon=${longitude}`,
    });
  }
  return normalizeRanges({ ranges });
}

function parsedRanges(ranges, { source, canInferArea = false } = {}) {
  return {
    ranges,
    source,
    canInferArea,
  };
}

function parseLatLonInput(input, zoomOptions) {
  const namedLat = input.match(/\b(?:lat|latitude)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const namedLon = input.match(/\b(?:lon|lng|longitude)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (namedLat && namedLon) {
    const { zoomStart, zoomEnd } = normalizePointZooms(zoomOptions);
    return parsedRanges(rangesFromPoint({
      latitude: parseLatitude(namedLat[1], "latitude"),
      longitude: parseLongitude(namedLon[1], "longitude"),
      zoomStart,
      zoomEnd,
    }), { source: "point", canInferArea: true });
  }

  const pairMatch = input.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!pairMatch) return null;
  const latitude = parseLatitude(pairMatch[1], "latitude");
  const longitude = parseLongitude(pairMatch[2], "longitude");
  const { zoomStart, zoomEnd } = normalizePointZooms(zoomOptions);
  return parsedRanges(rangesFromPoint({ latitude, longitude, zoomStart, zoomEnd }), {
    source: "point",
    canInferArea: true,
  });
}

function parseJsonRangeInput(input, zoomOptions) {
  const parsed = JSON.parse(input);
  if (Array.isArray(parsed)) {
    return parsedRanges(normalizeRanges({ ranges: parsed }), { source: "json-ranges" });
  }
  if (parsed?.ranges) {
    return parsedRanges(normalizeRanges(parsed), { source: "json-ranges" });
  }
  const hasBounds = ["west", "south", "east", "north"].every((key) => parsed?.[key] !== undefined);
  if (hasBounds) {
    const zooms = normalizeZooms({ ...zoomOptions, ...parsed });
    return parsedRanges(rangesFromBounds({
      west: parseLongitude(parsed.west, "west"),
      south: parseLatitude(parsed.south, "south"),
      east: parseLongitude(parsed.east, "east"),
      north: parseLatitude(parsed.north, "north"),
      ...zooms,
    }), { source: "bounds", canInferArea: true });
  }
  const latitude = parsed?.latitude ?? parsed?.lat;
  const longitude = parsed?.longitude ?? parsed?.lon ?? parsed?.lng;
  if (latitude !== undefined && longitude !== undefined) {
    const zooms = normalizePointZooms({ ...zoomOptions, ...parsed });
    return parsedRanges(rangesFromPoint({
      latitude: parseLatitude(latitude, "latitude"),
      longitude: parseLongitude(longitude, "longitude"),
      ...zooms,
    }), { source: "point", canInferArea: true });
  }
  return parsedRanges(normalizeRanges({ ranges: [parsed] }), { source: "json-ranges" });
}

function parseTileRangeInput(input) {
  const compact = input.replace(/\s+/g, " ").trim();
  const lines = input.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    const ranges = [];
    for (const line of lines) {
      const parsed = parseTileRangeInput(line);
      if (!parsed) return null;
      ranges.push(...parsed.ranges);
    }
    return parsedRanges(normalizeRanges({ ranges }), { source: "tile-ranges" });
  }

  const slashMatch = compact.match(/^(\d+)\/(\d+)\/(\d+)\/?\s*[-–—]\s*(?:(\d+)\/)?(\d+)\/(\d+)\/?$/);
  if (slashMatch) {
    const zoomStart = parseInteger(slashMatch[1], "zoom");
    const zoomEnd = parseInteger(slashMatch[4] || slashMatch[1], "zoomEnd");
    if (zoomStart !== zoomEnd) throw new Error("slash tile range must use the same zoom at both ends");
    return parsedRanges(normalizeRanges({
      ranges: [{
        zoom: zoomStart,
        xStart: parseInteger(slashMatch[2], "xStart"),
        xEnd: parseInteger(slashMatch[5], "xEnd"),
        yStart: parseInteger(slashMatch[3], "yStart"),
        yEnd: parseInteger(slashMatch[6], "yEnd"),
      }],
    }), { source: "tile-ranges" });
  }

  const keyMatch = compact.match(/z(?:oom)?\s*=\s*(\d+)(?:\s*[-–—]\s*(\d+))?.*?x\s*=\s*(\d+)\s*[-–—]\s*(\d+).*?y\s*=\s*(\d+)\s*[-–—]\s*(\d+)/i);
  if (keyMatch) {
    return parsedRanges(normalizeRanges({
      ranges: [{
        zoomStart: parseInteger(keyMatch[1], "zoomStart"),
        zoomEnd: parseInteger(keyMatch[2] || keyMatch[1], "zoomEnd"),
        xStart: parseInteger(keyMatch[3], "xStart"),
        xEnd: parseInteger(keyMatch[4], "xEnd"),
        yStart: parseInteger(keyMatch[5], "yStart"),
        yEnd: parseInteger(keyMatch[6], "yEnd"),
      }],
    }), { source: "tile-ranges" });
  }

  return null;
}

export function rangesForYScheme(ranges = [], yScheme = "xyz") {
  const normalized = normalizeRanges({ ranges });
  if (String(yScheme || "xyz").toLowerCase() !== "tms") return normalized;
  return normalized.flatMap((range) => {
    const converted = [];
    for (let zoom = range.zoomStart; zoom <= range.zoomEnd; zoom += 1) {
      const max = 2 ** zoom - 1;
      converted.push({
        ...range,
        zoomStart: zoom,
        zoomEnd: zoom,
        yStart: max - range.yEnd,
        yEnd: max - range.yStart,
        label: `${range.label} y=tms->xyz`,
        autoCorrectedY: "tms-to-xyz",
      });
    }
    return converted;
  });
}

function parseBoundsInput(input, zoomOptions) {
  const lbTrMatch = input.match(/LB\s*:?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)[\s\S]*?TR\s*:?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (!lbTrMatch) return null;
  const { zoomStart, zoomEnd } = normalizeZooms(zoomOptions);
  const west = parseLongitude(lbTrMatch[1], "LB longitude");
  const south = parseLatitude(lbTrMatch[2], "LB latitude");
  const east = parseLongitude(lbTrMatch[3], "TR longitude");
  const north = parseLatitude(lbTrMatch[4], "TR latitude");
  if (east < west) throw new Error("TR longitude must be greater than or equal to LB longitude");
  if (north < south) throw new Error("TR latitude must be greater than or equal to LB latitude");
  return parsedRanges(rangesFromBounds({ west, south, east, north, zoomStart, zoomEnd }), {
    source: "bounds",
    canInferArea: true,
  });
}

function pointFromRanges(ranges = []) {
  let point = null;
  for (const range of ranges) {
    const match = String(range.label || "").match(/^point z=\d+ lat=(-?\d+(?:\.\d+)?) lon=(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const current = {
      latitude: parseNumber(match[1], "latitude"),
      longitude: parseNumber(match[2], "longitude"),
    };
    if (point && (point.latitude !== current.latitude || point.longitude !== current.longitude)) return null;
    point = current;
  }
  return point;
}

export function parseConfigRangeInput({ input, zoom, zoomStart, zoomEnd } = {}) {
  const text = String(input || "").trim();
  if (!text) throw new Error("range input is required");
  if (/^[\[{]/.test(text)) return parseJsonRangeInput(text, { zoom, zoomStart, zoomEnd });
  return parseTileRangeInput(text)
    || parseLatLonInput(text, { zoom, zoomStart, zoomEnd })
    || parseBoundsInput(text, { zoom, zoomStart, zoomEnd })
    || (() => {
    throw new Error("Unsupported range input. Use latitude/longitude, LB/TR bounds, z/x/y - z/x/y, z/x-y y-y, JSON ranges, or a config JSON with ranges.");
  })();
}

export function parseConfigRanges(options = {}) {
  return parseConfigRangeInput(options).ranges;
}

export function summarizeRanges(ranges, { includeArea = true } = {}) {
  const normalized = normalizeRanges({ ranges });
  const tiles = normalized.reduce(
    (sum, range) => sum + (range.zoomEnd - range.zoomStart + 1) * (range.xEnd - range.xStart + 1) * (range.yEnd - range.yStart + 1),
    0
  );
  if (!includeArea) {
    return {
      ranges: normalized,
      rangeCount: normalized.length,
      tiles,
      area: null,
    };
  }
  const point = pointFromRanges(normalized);
  if (point) {
    const roundedLatitude = roundCoordinate(point.latitude);
    const roundedLongitude = roundCoordinate(point.longitude);
    return {
      ranges: normalized,
      rangeCount: normalized.length,
      tiles,
      area: {
        label: `lat ${roundedLatitude}, lon ${roundedLongitude}`,
        bounds: {
          west: roundedLongitude,
          south: roundedLatitude,
          east: roundedLongitude,
          north: roundedLatitude,
        },
        center: {
          longitude: roundedLongitude,
          latitude: roundedLatitude,
        },
      },
    };
  }
  const bounds = normalized.reduce((acc, range) => {
    const zoom = range.zoomStart;
    const west = tileXToLongitude(range.xStart, zoom);
    const east = tileXToLongitude(range.xEnd + 1, zoom);
    const north = tileYToLatitude(range.yStart, zoom);
    const south = tileYToLatitude(range.yEnd + 1, zoom);
    return {
      west: Math.min(acc.west, west),
      south: Math.min(acc.south, south),
      east: Math.max(acc.east, east),
      north: Math.max(acc.north, north),
    };
  }, { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });
  const area = normalized.length
    ? {
        label: `lon ${roundCoordinate(bounds.west)}-${roundCoordinate(bounds.east)}, lat ${roundCoordinate(bounds.south)}-${roundCoordinate(bounds.north)}`,
        bounds: {
          west: roundCoordinate(bounds.west),
          south: roundCoordinate(bounds.south),
          east: roundCoordinate(bounds.east),
          north: roundCoordinate(bounds.north),
        },
        center: {
          longitude: roundCoordinate((bounds.west + bounds.east) / 2),
          latitude: roundCoordinate((bounds.south + bounds.north) / 2),
        },
      }
    : null;
  return {
    ranges: normalized,
    rangeCount: normalized.length,
    tiles,
    area,
  };
}
