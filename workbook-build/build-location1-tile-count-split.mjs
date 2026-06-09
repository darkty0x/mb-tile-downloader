import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const reportPath = path.join(projectRoot, "reports", "location-mapbox-tiles.json");
const outputDir = path.join(projectRoot, "outputs", "location-range-assignments");
const outputPath = path.join(outputDir, "location1_prince_edward_tile_count_split.xlsx");
const assignees = ["mcs", "kuh", "rhc", "kyj", "cig", "cmi"];

function pathRange(z, xStart, xEnd, yStart, yEnd) {
  return `${z}/${xStart}/${yStart}/ - ${z}/${xEnd}/${yEnd}/`;
}

function splitRangeByTileCount(site) {
  const totals = Object.fromEntries(assignees.map((assignee) => [assignee, 0]));
  const rows = [];

  for (const range of site.tileRanges) {
    const xCount = range.xEnd - range.xStart + 1;
    const yCount = range.yEnd - range.yStart + 1;
    const baseWidth = Math.floor(xCount / assignees.length);
    const extraColumns = xCount % assignees.length;
    const extraAssignees = new Set(
      [...assignees]
        .sort((a, b) => totals[a] - totals[b] || assignees.indexOf(a) - assignees.indexOf(b))
        .slice(0, extraColumns),
    );

    let xCursor = range.xStart;
    for (const assignee of assignees) {
      const width = baseWidth + (extraAssignees.has(assignee) ? 1 : 0);
      if (width <= 0) continue;

      const xStart = xCursor;
      const xEnd = xCursor + width - 1;
      const tileCount = width * yCount;
      totals[assignee] += tileCount;
      rows.push({
        assignee,
        country: "ZA",
        title: `1. ${site.name}`,
        z: range.z,
        mapboxRange: pathRange(range.z, xStart, xEnd, range.yStart, range.yEnd),
        xCount: width,
        yCount,
        tileCount,
        complete: "No",
      });
      xCursor = xEnd + 1;
    }
  }

  return { rows, totals };
}

const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const site = report.sites[0];
const { rows, totals } = splitRangeByTileCount(site);
const totalTiles = site.tileRanges.reduce((sum, range) => sum + range.tiles, 0);
const assignedTiles = Object.values(totals).reduce((sum, value) => sum + value, 0);

if (site.id !== "prince-edward-islands-marion-region") {
  throw new Error(`Expected location 1 to be Prince Edward Islands, got ${site.id}`);
}
if (assignedTiles !== totalTiles) {
  throw new Error(`Tile split mismatch: assigned ${assignedTiles}, source ${totalTiles}`);
}

const workbook = Workbook.create();
const summaryRows = [
  ["Assignee", "Country", "Range Title", "Assigned Range Rows", "Total Tiles", "Share %", "Complete?"],
  ...assignees.map((assignee) => {
    const assignedRows = rows.filter((row) => row.assignee === assignee);
    return [
      assignee,
      "ZA",
      `1. ${site.name}`,
      assignedRows.length,
      totals[assignee],
      totals[assignee] / totalTiles,
      "No",
    ];
  }),
];

const summary = workbook.worksheets.add("Summary");
summary.getRange(`A1:G${summaryRows.length}`).values = summaryRows;
summary.getRange("A1:G1").format = {
  fill: "#1F4E79",
  font: { bold: true, color: "#FFFFFF", size: 12 },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "outside", style: "thin", color: "#1F2937" },
};
summary.getRange(`A2:G${summaryRows.length}`).format = {
  fill: "#FFFFFF",
  font: { color: "#111827", size: 10 },
  verticalAlignment: "top",
  wrapText: true,
  borders: { preset: "outside", style: "thin", color: "#D1D5DB" },
};
summary.getRange(`F2:F${summaryRows.length}`).numberFormat = "0.0000%";
summary.getRange(`G2:G${summaryRows.length}`).dataValidation = {
  allowBlank: false,
  list: { inCellDropDown: true, source: ["No", "Yes"] },
};
summary.getRange(`G2:G${summaryRows.length}`).conditionalFormats.add("containsText", {
  text: "Yes",
  format: { fill: "#DCFCE7", font: { color: "#166534", bold: true } },
});
summary.getRange(`G2:G${summaryRows.length}`).conditionalFormats.add("containsText", {
  text: "No",
  format: { fill: "#FEE2E2", font: { color: "#991B1B", bold: true } },
});
summary.getRange("A:A").format.columnWidthPx = 92;
summary.getRange("B:B").format.columnWidthPx = 82;
summary.getRange("C:C").format.columnWidthPx = 330;
summary.getRange("D:D").format.columnWidthPx = 140;
summary.getRange("E:E").format.columnWidthPx = 130;
summary.getRange("F:F").format.columnWidthPx = 100;
summary.getRange("G:G").format.columnWidthPx = 100;

for (const assignee of assignees) {
  const assignedRows = rows.filter((row) => row.assignee === assignee);
  const sheetRows = [
    ["Assignee", "Country", "Range Title", "Zoom", "Mapbox Range", "X Count", "Y Count", "Tile Count", "Complete?"],
    ...assignedRows.map((row) => [
      row.assignee,
      row.country,
      row.title,
      row.z,
      row.mapboxRange,
      row.xCount,
      row.yCount,
      row.tileCount,
      row.complete,
    ]),
  ];
  const sheet = workbook.worksheets.add(assignee);
  sheet.getRange(`A1:I${sheetRows.length}`).values = sheetRows;
  sheet.getRange("A1:I1").format = {
    fill: "#1F4E79",
    font: { bold: true, color: "#FFFFFF", size: 12 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: "#1F2937" },
  };
  sheet.getRange(`A2:I${sheetRows.length}`).format = {
    fill: "#FFFFFF",
    font: { color: "#111827", size: 10 },
    verticalAlignment: "top",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: "#D1D5DB" },
  };
  sheet.getRange(`A2:B${sheetRows.length}`).format.horizontalAlignment = "center";
  sheet.getRange(`D2:D${sheetRows.length}`).format.horizontalAlignment = "center";
  sheet.getRange(`F2:I${sheetRows.length}`).format.horizontalAlignment = "center";
  sheet.getRange(`I2:I${sheetRows.length}`).dataValidation = {
    allowBlank: false,
    list: { inCellDropDown: true, source: ["No", "Yes"] },
  };
  sheet.getRange(`I2:I${sheetRows.length}`).conditionalFormats.add("containsText", {
    text: "Yes",
    format: { fill: "#DCFCE7", font: { color: "#166534", bold: true } },
  });
  sheet.getRange(`I2:I${sheetRows.length}`).conditionalFormats.add("containsText", {
    text: "No",
    format: { fill: "#FEE2E2", font: { color: "#991B1B", bold: true } },
  });
  sheet.getRange("A:A").format.columnWidthPx = 92;
  sheet.getRange("B:B").format.columnWidthPx = 82;
  sheet.getRange("C:C").format.columnWidthPx = 330;
  sheet.getRange("D:D").format.columnWidthPx = 60;
  sheet.getRange("E:E").format.columnWidthPx = 310;
  sheet.getRange("F:H").format.columnWidthPx = 90;
  sheet.getRange("I:I").format.columnWidthPx = 100;
}

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(outputPath);
console.log(JSON.stringify({ totalTiles, assignedTiles, totals }, null, 2));
