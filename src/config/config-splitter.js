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
          label: range.label,
          tiles,
        });
      }
    }
  }
  return rows;
}

function labelForXRange(baseLabel, xStart, xEnd) {
  return `${baseLabel} x=${xStart}${xEnd === xStart ? "" : `-${xEnd}`}`;
}

function compactRows(rows) {
  const ranges = [];
  for (const row of rows) {
    const last = ranges[ranges.length - 1];
    if (
      last &&
      last.zoom === row.zoom &&
      last.yStart === row.yStart &&
      last.yEnd === row.yEnd &&
      last.baseLabel === row.label &&
      last.xEnd + 1 === row.xStart
    ) {
      last.xEnd = row.xEnd;
      last.label = labelForXRange(last.baseLabel, last.xStart, last.xEnd);
      continue;
    }
    ranges.push({
      zoom: row.zoom,
      xStart: row.xStart,
      xEnd: row.xEnd,
      yStart: row.yStart,
      yEnd: row.yEnd,
      label: labelForXRange(row.label, row.xStart, row.xEnd),
      baseLabel: row.label,
    });
  }
  return ranges.map(({ baseLabel, ...range }) => range);
}

export function splitConfigByRows(rawConfig, { parts, names } = {}) {
  const machineNames = Array.isArray(names) && names.length > 0
    ? names.map((name) => String(name).trim()).filter(Boolean)
    : Array.from({ length: parts || 0 }, (_, idx) => padPart(idx + 1));

  if (machineNames.length === 0) {
    throw new Error("split requires --parts or --names");
  }

  const rows = expandRows(rawConfig);
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

  let rowIndex = 0;
  let remainingTiles = rows.reduce((sum, row) => sum + row.tiles, 0);
  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
    const target = buckets[bucketIndex];
    const remainingBuckets = buckets.length - bucketIndex;
    const targetTiles = Math.ceil(remainingTiles / remainingBuckets);

    while (rowIndex < rows.length) {
      const row = rows[rowIndex];
      target.ranges.push(row);
      target.tiles += row.tiles;
      remainingTiles -= row.tiles;
      rowIndex++;

      const remainingRows = rows.length - rowIndex;
      if (
        bucketIndex < buckets.length - 1 &&
        target.tiles >= targetTiles &&
        remainingRows >= buckets.length - bucketIndex - 1
      ) {
        break;
      }
    }
  }

  const baseJobName = rawConfig.jobName || `${rawConfig.provider || "tiles"}-${rawConfig.layer || "download"}`;
  return buckets
    .sort((a, b) => machineNames.indexOf(a.name) - machineNames.indexOf(b.name))
    .map((bucket) => {
      const config = {
        ...rawConfig,
        jobName: `${baseJobName}-${bucket.name}`,
        ranges: compactRows(bucket.ranges),
      };
      return {
        name: bucket.name,
        tiles: bucket.tiles,
        rows: bucket.ranges.length,
        config,
      };
    });
}
