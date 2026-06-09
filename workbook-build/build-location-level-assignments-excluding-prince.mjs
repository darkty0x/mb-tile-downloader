import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const reportPath = path.join(projectRoot, "reports", "location-mapbox-tiles.json");
const outputDir = path.join(projectRoot, "outputs", "location-range-assignments");
const outputPath = path.join(outputDir, "location_level_assignments_excluding_prince_edward.xlsx");
const assignees = ["mcs", "kuh", "rhc", "kyj", "cig", "cmi"];
const excludedSiteId = "prince-edward-islands-marion-region";
const assignmentPlanByOriginalNumber = new Map([
  [13, "mcs"],
  [14, "kuh"],
  [15, "kuh"],
  [16, "kuh"],
  [4, "rhc"],
  [7, "rhc"],
  [9, "rhc"],
  [22, "rhc"],
  [10, "kyj"],
  [12, "kyj"],
  [17, "kyj"],
  [18, "kyj"],
  [21, "kyj"],
  [5, "cig"],
  [8, "cig"],
  [11, "cig"],
  [20, "cig"],
  [23, "cig"],
  [2, "cmi"],
  [3, "cmi"],
  [6, "cmi"],
  [19, "cmi"],
]);

function countryForSite(site) {
  if (site.id === excludedSiteId) return "ZA";
  if (site.id.startsWith("sk-") || site.id.startsWith("samsung-") || site.id.startsWith("lguplus-")) return "KO";
  if (site.id.startsWith("kddi-") || site.id.startsWith("mageshima-") || site.id.startsWith("jasdf-")) return "JP";
  return "US";
}

function styleHeader(range) {
  range.format = {
    fill: "#1F4E79",
    font: { bold: true, color: "#FFFFFF", size: 12 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: "#1F2937" },
  };
}

function styleBody(range) {
  range.format = {
    fill: "#FFFFFF",
    font: { color: "#111827", size: 10 },
    verticalAlignment: "top",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: "#D1D5DB" },
  };
}

function addCompletionValidation(range) {
  range.dataValidation = {
    allowBlank: false,
    list: { inCellDropDown: true, source: ["No", "Yes"] },
  };
  range.conditionalFormats.add("containsText", {
    text: "Yes",
    format: { fill: "#DCFCE7", font: { color: "#166534", bold: true } },
  });
  range.conditionalFormats.add("containsText", {
    text: "No",
    format: { fill: "#FEE2E2", font: { color: "#991B1B", bold: true } },
  });
}

const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const assignments = report.sites
  .map((site, originalIndex) => ({ site, originalNumber: originalIndex + 1 }))
  .filter(({ site }) => site.id !== excludedSiteId)
  .map(({ site, originalNumber }) => {
    const assignee = assignmentPlanByOriginalNumber.get(originalNumber);
    if (!assignee) {
      throw new Error(`Missing optimized assignment for location ${originalNumber}: ${site.name}`);
    }
    return {
      assignee,
      country: countryForSite(site),
      title: `${originalNumber}. ${site.name}`,
      ranges: site.tileRanges.map((range) => range.pathRange).join("\n"),
      tileCount: site.tileRanges.reduce((sum, range) => sum + range.tiles, 0),
      complete: "No",
    };
  });

const workbook = Workbook.create();
const summaryRows = [
  ["Assignee", "Assigned Locations", "Total Tile Count", "Complete?"],
  ...assignees.map((assignee) => {
    const rows = assignments.filter((entry) => entry.assignee === assignee);
    return [assignee, rows.length, rows.reduce((sum, row) => sum + row.tileCount, 0), "No"];
  }),
];

const summary = workbook.worksheets.add("Summary");
summary.getRange(`A1:D${summaryRows.length}`).values = summaryRows;
styleHeader(summary.getRange("A1:D1"));
styleBody(summary.getRange(`A2:D${summaryRows.length}`));
summary.getRange(`A2:A${summaryRows.length}`).format.horizontalAlignment = "center";
summary.getRange(`B2:D${summaryRows.length}`).format.horizontalAlignment = "center";
addCompletionValidation(summary.getRange(`D2:D${summaryRows.length}`));
summary.getRange("A:A").format.columnWidthPx = 100;
summary.getRange("B:B").format.columnWidthPx = 140;
summary.getRange("C:C").format.columnWidthPx = 140;
summary.getRange("D:D").format.columnWidthPx = 100;

for (const assignee of assignees) {
  const rowsForAssignee = assignments.filter((entry) => entry.assignee === assignee);
  const rows = [
    ["Assignee", "Country", "Range Title", "Mapbox Ranges", "Tile Count", "Complete?"],
    ...rowsForAssignee.map((entry) => [
      entry.assignee,
      entry.country,
      entry.title,
      entry.ranges,
      entry.tileCount,
      entry.complete,
    ]),
  ];
  const sheet = workbook.worksheets.add(assignee);
  sheet.getRange(`A1:F${rows.length}`).values = rows;
  styleHeader(sheet.getRange("A1:F1"));
  styleBody(sheet.getRange(`A2:F${rows.length}`));
  sheet.getRange(`A2:B${rows.length}`).format.horizontalAlignment = "center";
  sheet.getRange(`E2:F${rows.length}`).format.horizontalAlignment = "center";
  addCompletionValidation(sheet.getRange(`F2:F${rows.length}`));
  sheet.getRange("A:A").format.columnWidthPx = 92;
  sheet.getRange("B:B").format.columnWidthPx = 82;
  sheet.getRange("C:C").format.columnWidthPx = 340;
  sheet.getRange("D:D").format.columnWidthPx = 430;
  sheet.getRange("E:E").format.columnWidthPx = 120;
  sheet.getRange("F:F").format.columnWidthPx = 100;
}

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(outputPath);
console.log(JSON.stringify({
  excluded: excludedSiteId,
  assignedLocations: assignments.length,
  perAssignee: Object.fromEntries(assignees.map((assignee) => [
    assignee,
    assignments.filter((entry) => entry.assignee === assignee).length,
  ])),
}, null, 2));
