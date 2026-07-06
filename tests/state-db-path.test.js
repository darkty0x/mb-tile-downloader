import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { stateDbPathForConfig } from "../src/runtime/state-db-path.js";

test("dashboard materialized configs use the project-level state database", () => {
  const projectDir = path.resolve("/tmp/mb-tile-downloader");
  const config = {
    configPath: path.join(projectDir, ".tile-state", "dashboard", "configs", "cfg-a.json"),
    configDir: path.join(projectDir, ".tile-state", "dashboard", "configs"),
    jobName: "16-55000-55999-mapbox-pbf",
  };

  assert.equal(
    stateDbPathForConfig(config, {}, { projectDir }),
    path.join(projectDir, ".tile-state", "16-55000-55999-mapbox-pbf.sqlite")
  );
});

test("external configs keep the config-relative default state database", () => {
  const projectDir = path.resolve("/tmp/mb-tile-downloader");
  const config = {
    configPath: path.resolve("/tmp/external/configs/mapbox.json"),
    configDir: path.resolve("/tmp/external/configs"),
    jobName: "external-mapbox",
  };

  assert.equal(
    stateDbPathForConfig(config, {}, { projectDir }),
    path.resolve("/tmp/external/.tile-state/external-mapbox.sqlite")
  );
});
