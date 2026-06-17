import assert from "node:assert/strict";
import test from "node:test";

import { shortDate } from "../dashboard/client/components/dashboard-core.js";

test("shortDate uses Korean numeric standard without English timezone text", () => {
  const formatted = shortDate("2026-06-17T00:13:00.000Z");

  assert.match(formatted, /^\d{4}\. \d{2}\. \d{2}\. \d{2}:\d{2}$/);
  assert.doesNotMatch(formatted, /AM|PM|GMT|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May/i);
});
