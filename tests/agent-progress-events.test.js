import test from "node:test";
import assert from "node:assert/strict";

import { parseDownloaderProgressLine, parseEventLine, parseStageProgressLine, parseTileRowProgressLine, parseValidateProgressLine, createProgressEventForwarder } from "../src/agent/progress-events.js";

test("parses structured event lines and ignores ordinary output", () => {
  assert.deepEqual(parseEventLine("plain output"), null);
  assert.deepEqual(parseEventLine('[event] {"type":"x","message":"hello"}'), {
    type: "x",
    message: "hello",
  });
});

test("parses downloader progress lines into durable job progress", () => {
  const parsed = parseDownloaderProgressLine(
    "  ↳ range 1/1 row 310/3426 z=19 x=317161 tiles 5600870/61897542 d=0 s=5589956 m=10814 f=0 skippedRows=309 rate=0.0 rows/s 754.6 타일/초 eta=4m 1s"
  );

  assert.equal(parsed.rowsDone, 310);
  assert.equal(parsed.rowsTotal, 3426);
  assert.equal(parsed.tilesDone, 5600870);
  assert.equal(parsed.tilesTotal, 61897542);
  assert.equal(parsed.tilesPerSecond, 754.6);
  assert.equal(parsed.etaSeconds, 241);
  assert.equal(parsed.percent, 9);
});

test("parses Korean downloader progress counters", () => {
  const parsed = parseDownloaderProgressLine(
    "  ↳ 범위 1/1 행 310/3426 z=19 x=317161 타일 5600870/61897542 내리적재=0 보관됨=5589956 빠짐=10814 실패=0 건너뛴행=309 속도=0.0 행/초 754.6 타일/초 완료예상=4m 1s"
  );

  assert.equal(parsed.tilesDownloaded, 0);
  assert.equal(parsed.tileFilesSkipped, 5589956);
  assert.equal(parsed.tilesMissing, 10814);
  assert.equal(parsed.tilesFailed, 0);
  assert.equal(parsed.tilesPerSecond, 754.6);
  assert.equal(parsed.etaSeconds, 241);
});

test("parses row-level tile progress during validate repair downloads", () => {
  const line = "  ... 범위 1/1 행내 z=16 x=55018 타일 56876/65536 내리적재=56876 생성=0 보관됨=0 빠짐=0 실패대기=0";
  const parsed = parseTileRowProgressLine(line);

  assert.equal(parsed.rangeIndex, 1);
  assert.equal(parsed.rangeCount, 1);
  assert.equal(parsed.z, 16);
  assert.equal(parsed.x, 55018);
  assert.equal(parsed.rowTilesDone, 56876);
  assert.equal(parsed.rowTilesTotal, 65536);
  assert.equal(parsed.tilesDone, 56876);
  assert.equal(parsed.tilesTotal, 65536);
  assert.equal(parsed.tilesDownloaded, 56876);
  assert.equal(parsed.percent, 87);
  assert.deepEqual(parseStageProgressLine(line, "validate"), parsed);
  assert.deepEqual(parseStageProgressLine(line, "download"), parsed);
});

test("parses validation progress lines into durable job progress", () => {
  const parsed = parseValidateProgressLine(
    "  🔍 range 18/19 verify rows=255/273 present=55080 missing=0 failed=0"
  );

  assert.equal(parsed.rangeIndex, 18);
  assert.equal(parsed.rangeCount, 19);
  assert.equal(parsed.rowsDone, 255);
  assert.equal(parsed.rowsTotal, 273);
  assert.equal(parsed.tilesDone, 255);
  assert.equal(parsed.tilesTotal, 273);
  assert.equal(parsed.tilesPresent, 55080);
  assert.equal(parsed.tilesMissing, 0);
  assert.equal(parsed.tilesFailed, 0);
  assert.equal(parsed.percent, 93);
  assert.deepEqual(parseStageProgressLine("  🔍 range 18/19 verify rows=255/273 present=55080 missing=0 failed=0", "validate"), parsed);
});

test("parses completed validation lines as full stage progress", () => {
  const parsed = parseValidateProgressLine(
    "  ✔ range 18/19 verified present=59000/59000 missing=0 failed=0 status=green elapsed=20.1s"
  );

  assert.equal(parsed.rangeIndex, 18);
  assert.equal(parsed.rangeCount, 19);
  assert.equal(parsed.tilesDone, 59000);
  assert.equal(parsed.tilesTotal, 59000);
  assert.equal(parsed.percent, 100);
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

test("progress forwarder suppresses noisy range stage lifecycle events", async () => {
  const posted = [];
  const forwarder = createProgressEventForwarder({
    machineId: "worker-a",
    client: {
      postEvent: async (event) => posted.push(event),
    },
  });

  assert.equal(await forwarder.handleLine('[event] {"severity":"info","type":"range.download.started","message":"download started"}'), true);
  assert.equal(await forwarder.handleLine('[event] {"severity":"success","type":"range.upload.completed","message":"upload completed"}'), true);
  assert.equal(await forwarder.handleLine('[event] {"severity":"success","type":"pipeline.completed","message":"pipeline completed","data":{"configName":"cfg-a"}}'), true);

  assert.deepEqual(posted, [
    {
      machineId: "worker-a",
      severity: "success",
      type: "pipeline.completed",
      message: "pipeline completed",
      data: { configName: "cfg-a" },
    },
  ]);
});

test("progress forwarder can opt in to range stage lifecycle events", async () => {
  const posted = [];
  const forwarder = createProgressEventForwarder({
    machineId: "worker-a",
    forwardRangeStageEvents: true,
    client: {
      postEvent: async (event) => posted.push(event),
    },
  });

  await forwarder.handleLine('[event] {"severity":"info","type":"range.download.started","message":"download started"}');

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "range.download.started");
});
