import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pagesSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");

test("server table action controls stay vertically centered", () => {
  const serversTableSource = pagesSource.slice(
    pagesSource.indexOf("function ServersTable"),
    pagesSource.indexOf("function ResourceActionButtons", pagesSource.indexOf("function ServersTable")),
  );

  assert.match(serversTableSource, /text-right align-middle/);
  assert.match(serversTableSource, /className="flex items-center justify-end gap-1\.5"/);
  assert.match(serversTableSource, /className="state-layer inline-flex h-10 w-10 items-center justify-center[^"]*leading-none[^"]*"/);
});
