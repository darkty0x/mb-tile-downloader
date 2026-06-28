import test from "node:test";
import assert from "node:assert/strict";

import { moveConfigChoice, reorderConfigChoice, selectedFirstConfigChoices } from "../dashboard/client/lib/config-order.js";

const item = (id, groupKey = id) => ({ id, label: id, path: id, groupKey });
const ids = (items) => items.map((entry) => entry.id);

test("config order moves one item with arrow controls by default", () => {
  const items = [item("a", "g1"), item("b", "g1"), item("c", "g2")];

  assert.deepEqual(ids(moveConfigChoice(items, 1, -1)), ["b", "a", "c"]);
});

test("config order moves same-group items together when grouped", () => {
  const items = [item("a", "g1"), item("b", "g1"), item("c", "g2"), item("d", "g3")];

  assert.deepEqual(ids(moveConfigChoice(items, 0, 1, { grouped: true })), ["c", "a", "b", "d"]);
  assert.deepEqual(ids(moveConfigChoice(items, 2, -1, { grouped: true })), ["c", "a", "b", "d"]);
});

test("config order drag reorders one item or same-group block", () => {
  const items = [item("a", "g1"), item("b", "g1"), item("c", "g2"), item("d", "g3")];

  assert.deepEqual(ids(reorderConfigChoice(items, 1, 3)), ["a", "c", "b", "d"]);
  assert.deepEqual(ids(reorderConfigChoice(items, 1, 3, { position: "after" })), ["a", "c", "d", "b"]);
  assert.deepEqual(ids(reorderConfigChoice(items, 0, 3, { grouped: true })), ["c", "a", "b", "d"]);
  assert.deepEqual(ids(reorderConfigChoice(items, 0, 3, { grouped: true, position: "after" })), ["c", "d", "a", "b"]);
});

test("config order keeps unchecked items after selected items", () => {
  const items = [
    { ...item("a"), selected: true },
    { ...item("b"), selected: false },
    { ...item("c"), selected: true },
    { ...item("d"), selected: false },
  ];

  assert.deepEqual(ids(selectedFirstConfigChoices(items)), ["a", "c", "b", "d"]);
});
