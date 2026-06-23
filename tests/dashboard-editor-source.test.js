import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editorSource = readFileSync(new URL("../dashboard/client/components/dashboard-editor.jsx", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../dashboard/client/components/dashboard-state.js", import.meta.url), "utf8");

test("config batch preview can fill an inferred name into the modal", () => {
  assert.match(editorSource, /required=\{!templateMode \|\| groupEditing\}/);
  assert.match(editorSource, /preview\.suggestedName/);
  assert.match(editorSource, /setNameValue\(preview\.suggestedName\)/);
});

test("range builder defaults point previews to zoom 1 through 19", () => {
  assert.match(editorSource, /useState\("1"\)/);
  assert.match(editorSource, /useState\("19"\)/);
  assert.match(editorSource, /lat: 37\.5665, lon: 126\.9780/);
});

test("range builder treats raw zxy input as Mapbox coordinates without y-scheme choice", () => {
  assert.doesNotMatch(editorSource, /name="inputYScheme"/);
  assert.doesNotMatch(editorSource, /TMS \/ inverted Y/);
  assert.doesNotMatch(stateSource, /inputYScheme/);
});
