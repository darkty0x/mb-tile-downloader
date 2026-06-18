import test from "node:test";
import assert from "node:assert/strict";

import { enableWindowsUtf8Console } from "../src/runtime/windows-console.js";

test("windows UTF-8 console setup is a no-op outside Windows", () => {
  const calls = [];
  const enabled = enableWindowsUtf8Console({
    platform: "linux",
    execFileSyncImpl: (...args) => calls.push(args),
  });

  assert.equal(enabled, false);
  assert.deepEqual(calls, []);
});
