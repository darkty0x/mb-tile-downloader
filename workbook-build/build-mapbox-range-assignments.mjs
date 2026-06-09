import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const reportPath = path.join(projectRoot, "reports", "location-mapbox-tiles.json");
const outputDir = path.join(projectRoot, "outputs", "location-range-assignments");
const outputPath = path.join(outputDir, "final_mapbox_range_assignments.xlsx");
const assignees = ["mcs", "kuh", "rhc", "kyj", "cig", "cmi"];

function countryForSite(site) {
  if (site.id === "prince-edward-islands-marion-region") return "ZA";
  if (site.id.startsWith("sk-") || site.id.startsWith("samsung-") || site.id.startsWith("lguplus-")) return "KO";
  if (site.id.startsWith("kddi-") || site.id.startsWith("mageshima-") || site.id.startsWith("jasdf-")) return "JP";
  return "US";
}

const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const assignments = report.sites.map((site, index) => ({
  assignee: assignees[index % assignees.length],
  country: countryForSite(site),
  title: `${index + 1}. ${site.name}`,
  ranges: site.tileRanges.map((range) => range.pathRange).join("\n"),
  complete: "No",
}));

const workbook = Workbook.create();
for (const assignee of assignees) {
  const assigneeRows = assignments
    .filter((entry) => entry.assignee === assignee)
    .map((entry) => [entry.assignee, entry.country, entry.title, entry.ranges, entry.complete]);
  const rows = [["Assignee", "Country", "Range Title", "Mapbox Ranges", "Complete?"], ...assigneeRows];
  const sheet = workbook.worksheets.add(assignee);
  sheet.getRange(`A1:E${rows.length}`).values = rows;

  sheet.getRange("A1:E1").format = {
    fill: "#1F4E79",
    font: { bold: true, color: "#FFFFFF", size: 12 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: "#1F2937" },
  };

  if (rows.length > 1) {
    sheet.getRange(`A2:E${rows.length}`).format = {
      fill: "#FFFFFF",
      font: { color: "#111827", size: 10 },
      verticalAlignment: "top",
      wrapText: true,
      borders: { preset: "outside", style: "thin", color: "#D1D5DB" },
    };
    sheet.getRange(`A2:A${rows.length}`).format.horizontalAlignment = "center";
    sheet.getRange(`B2:B${rows.length}`).format.horizontalAlignment = "center";
    sheet.getRange(`E2:E${rows.length}`).format.horizontalAlignment = "center";
    sheet.getRange(`E2:E${rows.length}`).dataValidation = {
      allowBlank: false,
      list: { inCellDropDown: true, source: ["No", "Yes"] },
    };
    sheet.getRange(`E2:E${rows.length}`).conditionalFormats.add("containsText", {
      text: "Yes",
      format: { fill: "#DCFCE7", font: { color: "#166534", bold: true } },
    });
    sheet.getRange(`E2:E${rows.length}`).conditionalFormats.add("containsText", {
      text: "No",
      format: { fill: "#FEE2E2", font: { color: "#991B1B", bold: true } },
    });
  }

  sheet.getRange("A:A").format.columnWidthPx = 92;
  sheet.getRange("B:B").format.columnWidthPx = 82;
  sheet.getRange("C:C").format.columnWidthPx = 310;
  sheet.getRange("D:D").format.columnWidthPx = 430;
  sheet.getRange("E:E").format.columnWidthPx = 100;
}

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(outputPath);
