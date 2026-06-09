import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const assignees = ["mcs", "kuh", "rhc", "kyj", "cig", "cmi"];
const defaultInputPath =
  "/Users/dell/.codex/attachments/6db3ef6b-1e26-493c-92e0-9abda4811900/pasted-text.txt";
const inputPath = process.argv[2] || defaultInputPath;
const outputDir = path.resolve("configs");

const pbfBase = {
  provider: "mapbox",
  layer: "vector",
  format: "pbf",
  url: {
    template:
      "https://{host}.tiles.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{extension}?access_token={token}",
    hosts: ["a", "b", "c", "d"],
    tileset:
      "mapbox.mapbox-bathymetry-v2,mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2,mapbox.mapbox-models-v1",
    extension: "vector.pbf",
  },
  tile: {
    extension: "vector.pbf",
    yScheme: "xyz",
  },
  output: {
    dir: "../tiles",
    pathTemplate: "{layer}/{z}/{x}/{y}.{extension}",
  },
  performance: {
    maxConcurrentRequests: 4096,
    maxRowsInFlight: 1,
    requestTimeoutMs: 25000,
    maxRetries: 4,
    retryBackoffMs: 150,
  },
  verifyAfterDownload: true,
};

const satelliteBase = {
  provider: "mapbox",
  layer: "satellite",
  format: "jpg",
  url: {
    template:
      "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token={token}",
    hosts: ["api"],
    tileset: "unused",
    extension: "jpg",
  },
  tile: {
    extension: "jpg",
    yScheme: "xyz",
  },
  output: {
    dir: "../tiles",
    pathTemplate: "{layer}/{z}/{x}/{y}.{extension}",
  },
  performance: {
    maxConcurrentRequests: 4096,
    maxRowsInFlight: 1,
    requestTimeoutMs: 25000,
    maxRetries: 3,
    retryBackoffMs: 150,
  },
  verifyAfterDownload: true,
};

function parseTileRange(value) {
  const match = value.match(/^(\d+)\/(\d+)\/(\d+)\/ - \1\/(\d+)\/(\d+)\/$/);
  if (!match) throw new Error(`Invalid Mapbox range: ${value}`);
  const [, z, xStart, yStart, xEnd, yEnd] = match.map(Number);
  return { zoom: z, xStart, xEnd, yStart, yEnd };
}

function parseRows(text) {
  const rowsByAssignee = Object.fromEntries(assignees.map((assignee) => [assignee, []]));
  for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const columns = line.split("\t");
    if (columns.length !== 9) {
      throw new Error(`Line ${lineNumber + 1} must have 9 tab-separated columns`);
    }

    const [assignee, country, title, zoomText, mapboxRange, xCountText, yCountText, tileCountText] = columns;
    if (!rowsByAssignee[assignee]) throw new Error(`Unknown assignee on line ${lineNumber + 1}: ${assignee}`);
    if (country !== "ZA") throw new Error(`Expected country ZA on line ${lineNumber + 1}`);
    if (title !== "1. Prince Edward Islands / Marion Island Region") {
      throw new Error(`Unexpected title on line ${lineNumber + 1}: ${title}`);
    }

    const range = parseTileRange(mapboxRange);
    const zoom = Number(zoomText);
    const xCount = Number(xCountText);
    const yCount = Number(yCountText);
    const tileCount = Number(tileCountText);
    if (range.zoom !== zoom) throw new Error(`Zoom mismatch on line ${lineNumber + 1}`);
    if (range.xEnd - range.xStart + 1 !== xCount) throw new Error(`X count mismatch on line ${lineNumber + 1}`);
    if (range.yEnd - range.yStart + 1 !== yCount) throw new Error(`Y count mismatch on line ${lineNumber + 1}`);
    if (xCount * yCount !== tileCount) throw new Error(`Tile count mismatch on line ${lineNumber + 1}`);

    rowsByAssignee[assignee].push({
      ...range,
      label: `prince-edward-${assignee}-z${zoom}-${rowsByAssignee[assignee].length + 1}`,
    });
  }
  return rowsByAssignee;
}

function buildConfig(base, assignee, ranges) {
  return {
    jobName: `prince-edward-${base.format === "pbf" ? "mapbox-pbf" : "mapbox-satellite"}-${assignee}`,
    ...base,
    ranges,
  };
}

const input = await readFile(inputPath, "utf8");
const rowsByAssignee = parseRows(input);

for (const assignee of assignees) {
  const ranges = rowsByAssignee[assignee].sort((a, b) => a.zoom - b.zoom || a.xStart - b.xStart || a.yStart - b.yStart);
  if (ranges.length === 0) throw new Error(`No ranges found for ${assignee}`);

  const pbfConfig = buildConfig(pbfBase, assignee, ranges);
  const satelliteConfig = buildConfig(satelliteBase, assignee, ranges);
  await writeFile(
    path.join(outputDir, `prince-edward-mapbox-pbf-${assignee}.config.json`),
    `${JSON.stringify(pbfConfig, null, 2)}\n`
  );
  await writeFile(
    path.join(outputDir, `prince-edward-mapbox-satellite-${assignee}.config.json`),
    `${JSON.stringify(satelliteConfig, null, 2)}\n`
  );
}

const summary = Object.fromEntries(
  assignees.map((assignee) => [
    assignee,
    rowsByAssignee[assignee].reduce((sum, range) => sum + (range.xEnd - range.xStart + 1) * (range.yEnd - range.yStart + 1), 0),
  ])
);
console.log(JSON.stringify({ inputPath, generatedUsers: assignees, tileCounts: summary }, null, 2));
