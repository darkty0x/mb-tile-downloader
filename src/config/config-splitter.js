import { normalizeRanges } from "./config-loader.js";

function padPart(index, width = 3) {
  return String(index).padStart(width, "0");
}

function expandRows(rawConfig) {
  const rows = [];
  for (const range of normalizeRanges(rawConfig)) {
    for (let z = range.zoomStart; z <= range.zoomEnd; z++) {
      for (let x = range.xStart; x <= range.xEnd; x++) {
        const tiles = range.yEnd - range.yStart + 1;
        rows.push({
          zoom: z,
          xStart: x,
          xEnd: x,
          yStart: range.yStart,
          yEnd: range.yEnd,
          label: `${range.label} x=${x}`,
          tiles,
        });
      }
    }
  }
  return rows;
}

export function splitConfigByRows(rawConfig, { parts, names } = {}) {
  const machineNames = Array.isArray(names) && names.length > 0
    ? names.map((name) => String(name).trim()).filter(Boolean)
    : Array.from({ length: parts || 0 }, (_, idx) => padPart(idx + 1));

  if (machineNames.length === 0) {
    throw new Error("split requires --parts or --names");
  }

  const rows = expandRows(rawConfig).sort((a, b) => b.tiles - a.tiles);
  if (machineNames.length > rows.length) {
    throw new Error(
      `more split targets than rows: targets=${machineNames.length}, rows=${rows.length}`
    );
  }

  const buckets = machineNames.map((name) => ({
    name,
    ranges: [],
    tiles: 0,
  }));

  for (const row of rows) {
    buckets.sort((a, b) => a.tiles - b.tiles || a.name.localeCompare(b.name));
    const target = buckets[0];
    target.ranges.push({
      zoom: row.zoom,
      xStart: row.xStart,
      xEnd: row.xEnd,
      yStart: row.yStart,
      yEnd: row.yEnd,
      label: row.label,
    });
    target.tiles += row.tiles;
  }

  const baseJobName = rawConfig.jobName || `${rawConfig.provider || "tiles"}-${rawConfig.layer || "download"}`;
  return buckets
    .sort((a, b) => machineNames.indexOf(a.name) - machineNames.indexOf(b.name))
    .map((bucket) => {
      const config = {
        ...rawConfig,
        jobName: `${baseJobName}-${bucket.name}`,
        ranges: bucket.ranges.sort((a, b) => a.zoom - b.zoom || a.xStart - b.xStart || a.yStart - b.yStart),
      };
      return {
        name: bucket.name,
        tiles: bucket.tiles,
        rows: bucket.ranges.length,
        config,
      };
    });
}
