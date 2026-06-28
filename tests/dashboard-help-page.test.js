import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const pagesSource = readFileSync(new URL("../dashboard/client/components/dashboard-pages.jsx", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../dashboard/client/components/dashboard-core.js", import.meta.url), "utf8");

test("help page renders captured page images instead of placeholder screenshot slots", () => {
  const source = `${pagesSource}\n${coreSource}`;
  for (const text of ["참고이미지", "Screenshot", "이미지를 여기에 추가합니다", "backend snapshot", "가이드"]) {
    assert.equal(source.includes(text), false, `unexpected help placeholder text: ${text}`);
  }

  const screenshotPaths = [...pagesSource.matchAll(/src: "(\/help\/[^"]+\.png)"/g)].map((match) => match[1]);
  assert.deepEqual(screenshotPaths, [
    "/help/overview.png",
    "/help/servers.png",
    "/help/configs.png",
    "/help/pipelines.png",
    "/help/secrets.png",
    "/help/credentials.png",
    "/help/events.png",
    "/help/alerts.png",
    "/help/settings.png",
  ]);

  for (const screenshotPath of screenshotPaths) {
    const assetUrl = new URL(`../dashboard/client/public${screenshotPath}`, import.meta.url);
    assert.equal(existsSync(assetUrl), true, `missing help screenshot asset: ${screenshotPath}`);
  }
});
