import test from "node:test";
import assert from "node:assert/strict";

import { parseEventLine, createProgressEventForwarder } from "../src/agent/progress-events.js";

test("parses structured event lines and ignores ordinary output", () => {
  assert.deepEqual(parseEventLine("plain output"), null);
  assert.deepEqual(parseEventLine('[event] {"type":"x","message":"hello"}'), {
    type: "x",
    message: "hello",
  });
});

test("progress forwarder posts parsed events with machine id", async () => {
  const posted = [];
  const forwarder = createProgressEventForwarder({
    machineId: "worker-a",
    client: {
      postEvent: async (event) => posted.push(event),
    },
  });

  await forwarder.handleLine('[event] {"severity":"success","type":"zip.completed","message":"zip done"}');
  await forwarder.handleLine("ordinary line");

  assert.deepEqual(posted, [
    {
      machineId: "worker-a",
      severity: "success",
      type: "zip.completed",
      message: "zip done",
      data: {},
    },
  ]);
});
