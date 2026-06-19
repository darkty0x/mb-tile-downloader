import test from "node:test";
import assert from "node:assert/strict";

import { buildConfigGroups, planConfigGroupUpdate } from "../dashboard/client/lib/config-groups.js";

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
