import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildConfigGroups, planConfigGroupAssignmentUpdate, planConfigGroupUpdate } from "../dashboard/client/lib/config-groups.js";

const templates = [
  { id: "esri-satellite", label: "esri-satellite", provider: "esri", layer: "esri-satellite", format: "jpg" },
  { id: "mapbox-dem", label: "mapbox-dem", provider: "mapbox", layer: "dem", format: "pngraw" },
  { id: "mapbox-pbf", label: "mapbox-pbf", provider: "mapbox", layer: "vector", format: "pbf" },
  { id: "mapbox-raster-tileset", label: "mapbox-raster-tileset", provider: "mapbox", layer: "raster", format: "jpg90" },
  { id: "mapbox-rasterarray-mrt", label: "mapbox-rasterarray-mrt", provider: "mapbox", layer: "rasterarray", format: "mrt" },
  { id: "mapbox-satellite", label: "mapbox-satellite", provider: "mapbox", layer: "satellite", format: "jpg" },
  { id: "mapbox-style-static-tiles", label: "mapbox-style-static-tiles", provider: "mapbox", layer: "style-raster", format: "jpg" },
  { id: "mapbox-vector-mvt", label: "mapbox-vector-mvt", provider: "mapbox", layer: "vector", format: "mvt" },
  { id: "mapbox-vector-style-optimized", label: "mapbox-vector-style-optimized", provider: "mapbox", layer: "vector-optimized", format: "mvt" },
];

test("config page groups matching server configs by base name and exposes enabled template icons", () => {
  const groups = buildConfigGroups([
    {
      configId: "cfg-1",
      machineId: "server-01",
      name: "1-pyongyang-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", ranges: [] },
    },
    {
      configId: "cfg-2",
      machineId: "server-01",
      name: "1-pyongyang-mapbox-pbf",
      config: { provider: "mapbox", layer: "vector", format: "pbf", ranges: [] },
    },
  ], templates);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "1-pyongyang");
  assert.equal(groups[0].machineId, "server-01");
  assert.equal(groups[0].templates.length, 9);
  assert.deepEqual(groups[0].enabledTemplateIds, ["esri-satellite", "mapbox-pbf"]);
  assert.deepEqual(
    groups[0].templates.filter((template) => template.enabled).map((template) => template.id),
    ["esri-satellite", "mapbox-pbf"]
  );
});

test("config groups sort machine ids by numeric server order", () => {
  const groups = buildConfigGroups([
    {
      configId: "cfg-10",
      machineId: "server-10",
      name: "10-late-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", ranges: [] },
    },
    {
      configId: "cfg-02",
      machineId: "server-02",
      name: "2-early-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", ranges: [] },
    },
    {
      configId: "cfg-01",
      machineId: "server-01",
      name: "1-first-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", ranges: [] },
    },
  ], templates);

  assert.deepEqual(groups.map((group) => group.machineId), ["server-01", "server-02", "server-10"]);
});

test("sidebar config badge should count assigned config groups, not available template types", () => {
  const configs = [
    {
      configId: "cfg-1",
      machineId: "server-02",
      name: "1-pyongyang-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", ranges: [] },
    },
    {
      configId: "cfg-2",
      machineId: "server-02",
      name: "1-pyongyang-mapbox-pbf",
      config: { provider: "mapbox", layer: "vector", format: "pbf", ranges: [] },
    },
    {
      configId: "cfg-3",
      machineId: "server-02",
      name: "1-pyongyang-mapbox-satellite",
      config: { provider: "mapbox", layer: "satellite", format: "jpg", ranges: [] },
    },
    {
      configId: "cfg-4",
      machineId: "server-03",
      name: "2-chiba-narita-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", ranges: [] },
    },
    {
      configId: "cfg-5",
      machineId: "server-03",
      name: "2-chiba-narita-mapbox-pbf",
      config: { provider: "mapbox", layer: "vector", format: "pbf", ranges: [] },
    },
    {
      configId: "cfg-6",
      machineId: "server-03",
      name: "2-chiba-narita-mapbox-satellite",
      config: { provider: "mapbox", layer: "satellite", format: "jpg", ranges: [] },
    },
  ];

  assert.equal(templates.length, 9);
  assert.equal(configs.length, 6);
  assert.equal(buildConfigGroups(configs, templates).length, 2);
});

test("rail config nav count uses assigned config groups instead of template count", () => {
  const shellSource = readFileSync(new URL("../dashboard/client/components/dashboard-shell.jsx", import.meta.url), "utf8");

  assert.match(shellSource, /import \{ buildConfigGroups \} from "\.\.\/lib\/config-groups";/);
  assert.match(shellSource, /const configGroupCount = buildConfigGroups\(state\.globalConfigs \|\| \[\], state\.configTemplates \|\| \[\]\)\.length;/);
  assert.match(shellSource, /if \(tab === "configs"\) return configGroupCount;/);
  assert.doesNotMatch(shellSource, /if \(tab === "configs"\) return state\.configTemplates\.length/);
});

test("config group update plan adds missing selected types and removes unchecked existing configs", () => {
  const [group] = buildConfigGroups([
    {
      configId: "cfg-1",
      machineId: "server-01",
      name: "1-pyongyang-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", ranges: [] },
    },
    {
      configId: "cfg-2",
      machineId: "server-01",
      name: "1-pyongyang-mapbox-pbf",
      config: { provider: "mapbox", layer: "vector", format: "pbf", ranges: [] },
    },
  ], templates);

  assert.deepEqual(
    planConfigGroupUpdate(group, ["esri-satellite", "mapbox-dem"]),
    {
      addTemplateIds: ["mapbox-dem"],
      removeConfigIds: ["cfg-2"],
    }
  );
});

test("config group assignment update plan renames and moves selected existing types", () => {
  const [group] = buildConfigGroups([
    {
      configId: "cfg-1",
      machineId: "server-01",
      name: "1-pyongyang-esri-satellite",
      config: { provider: "esri", layer: "esri-satellite", format: "jpg", jobName: "1-pyongyang-esri-satellite", ranges: [] },
    },
    {
      configId: "cfg-2",
      machineId: "server-01",
      name: "1-pyongyang-mapbox-pbf",
      config: { provider: "mapbox", layer: "vector", format: "pbf", jobName: "1-pyongyang-mapbox-pbf", ranges: [] },
    },
  ], templates);

  assert.deepEqual(
    planConfigGroupAssignmentUpdate(group, ["esri-satellite", "mapbox-pbf"], {
      name: "10-jeju-naval-base",
      machineIds: ["server-02"],
    }),
    [
      {
        configId: "cfg-1",
        machineId: "server-02",
        name: "10-jeju-naval-base-esri-satellite",
        config: { provider: "esri", layer: "esri-satellite", format: "jpg", jobName: "10-jeju-naval-base-esri-satellite", ranges: [] },
      },
      {
        configId: "cfg-2",
        machineId: "server-02",
        name: "10-jeju-naval-base-mapbox-pbf",
        config: { provider: "mapbox", layer: "vector", format: "pbf", jobName: "10-jeju-naval-base-mapbox-pbf", ranges: [] },
      },
    ]
  );
});

test("config group assignment update plan writes edited ranges to selected existing types", () => {
  const editedRanges = [{ zoomStart: 3, zoomEnd: 3, xStart: 4, xEnd: 5, yStart: 6, yEnd: 7 }];
  const [group] = buildConfigGroups([
    {
      configId: "cfg-1",
      machineId: "server-01",
      name: "1-pyongyang-esri-satellite",
      config: {
        provider: "esri",
        layer: "esri-satellite",
        format: "jpg",
        jobName: "1-pyongyang-esri-satellite",
        ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1 }],
      },
    },
    {
      configId: "cfg-2",
      machineId: "server-01",
      name: "1-pyongyang-mapbox-pbf",
      config: {
        provider: "mapbox",
        layer: "vector",
        format: "pbf",
        jobName: "1-pyongyang-mapbox-pbf",
        ranges: [{ zoomStart: 1, zoomEnd: 1, xStart: 1, xEnd: 1, yStart: 1, yEnd: 1 }],
      },
    },
  ], templates);

  assert.deepEqual(
    planConfigGroupAssignmentUpdate(group, ["esri-satellite", "mapbox-pbf"], {
      name: "1-pyongyang",
      machineIds: ["server-01"],
      ranges: editedRanges,
    }).map((update) => [update.configId, update.config.ranges]),
    [
      ["cfg-1", editedRanges],
      ["cfg-2", editedRanges],
    ]
  );
});

test("config group cards expose icon actions without the old type-edit label", () => {
  const pageSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");
  const editorSource = readFileSync(new URL("../dashboard/client/components/dashboard-editor.jsx", import.meta.url), "utf8");
  const stateSource = readFileSync(new URL("../dashboard/client/components/dashboard-state.js", import.meta.url), "utf8");

  assert.doesNotMatch(pageSource, />류형 편집<\/AppButton>/);
  assert.match(pageSource, /<IconButton label="편집" icon="edit" onClick=\{editGroup\} \/>/);
  assert.match(pageSource, /<IconButton label="복제" icon="copy" onClick=\{duplicateGroup\} \/>/);
  assert.match(pageSource, /<IconButton label="삭제" icon="trash" onClick=\{deleteGroup\} \/>/);
  assert.match(pageSource, /actions\.deleteConfigGroup\(group\)/);
  assert.match(stateSource, /async deleteConfigGroup\(configGroup\)/);
  assert.match(editorSource, /initialRanges=\{groupEditing \? groupRanges : \[\]\}/);
  assert.doesNotMatch(editorSource, /groupEditing \? null : <ConfigRangeBuilder/);
  assert.match(stateSource, /\/api\/ranges\/parse/);
  assert.match(stateSource, /planConfigGroupAssignmentUpdate\(configGroup, templateIds, \{ name, machineIds, ranges \}\)/);
});

test("enabled config type tiles show a prominent server assignment label", () => {
  const pageSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");

  assert.match(pageSource, /const templateMachineName = enabled \? machineName : "";/);
  assert.match(pageSource, /<span className="block w-full truncate text-\[12px\] font-\[850\]/);
  assert.match(pageSource, /\{templateMachineName\}/);
});
