import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);

test("watchdog restarts a crashed resumable command", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "watchdog-"));
  const marker = path.join(dir, "attempts.txt");
  const script = [
    "const fs = require('node:fs');",
    "const marker = process.env.WATCHDOG_TEST_MARKER;",
    "const attempts = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;",
    "fs.writeFileSync(marker, String(attempts + 1));",
    "console.log(`attempt ${attempts + 1}`);",
    "process.exit(attempts === 0 ? 2 : 0);",
  ].join(" ");

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "scripts/watchdog.js",
      "--idle-ms=0",
      "--restart-delay-ms=1",
      "--max-restarts=2",
      "--",
      process.execPath,
      "-e",
      script,
    ],
    {
      cwd: path.resolve("."),
      env: { ...process.env, WATCHDOG_TEST_MARKER: marker },
    }
  );

  assert.match(stdout, /attempt 1/);
  assert.match(stdout, /attempt 2/);
  assert.match(stderr, /restarting in 1ms/);
  assert.equal(await readFile(marker, "utf8"), "2");
});

test("watchdog does not restart non-restartable token exhaustion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "watchdog-"));
  const marker = path.join(dir, "attempts.txt");
  await writeFile(marker, "0");
  const script = [
    "const fs = require('node:fs');",
    "const marker = process.env.WATCHDOG_TEST_MARKER;",
    "const attempts = Number(fs.readFileSync(marker, 'utf8'));",
    "fs.writeFileSync(marker, String(attempts + 1));",
    "console.error('Fatal: All Mapbox access tokens are unusable; stopping immediately');",
    "process.exit(1);",
  ].join(" ");

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          "scripts/watchdog.js",
          "--idle-ms=0",
          "--restart-delay-ms=1",
          "--max-restarts=2",
          "--",
          process.execPath,
          "-e",
          script,
        ],
        {
          cwd: path.resolve("."),
          env: { ...process.env, WATCHDOG_TEST_MARKER: marker },
        }
      ),
    (err) => {
      assert.match(err.stderr, /non-restartable failure detected/);
      return true;
    }
  );

  assert.equal(await readFile(marker, "utf8"), "1");
});
