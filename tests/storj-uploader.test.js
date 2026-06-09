import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);

test("storj uploader does not treat empty uplink ls output as remote existing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const toolsDir = path.join(path.resolve("."), "tools", "uplink");
  const archivePath = path.join(archivesDir, "tiles_vector_1_000000-000000_y000000-000000.zip");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(archivePath, "zip");

  const fakeUplink = path.join(toolsDir, process.platform === "win32" ? "uplink.exe" : "uplink");
  const original = path.join(toolsDir, process.platform === "win32" ? "uplink.exe.real-test" : "uplink.real-test");
  let renamed = false;
  try {
    await mkdir(toolsDir, { recursive: true });
    try {
      await stat(fakeUplink);
      await import("node:fs/promises").then(({ rename }) => rename(fakeUplink, original));
      renamed = true;
    } catch {}

    await writeFile(
      fakeUplink,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('import')) process.exit(0);",
        "if (args.includes('ls')) process.exit(0);",
        "if (args.includes('cp')) process.exit(2);",
        "process.exit(0);",
      ].join("\n"),
      { mode: 0o755 }
    );

    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "storj-uploader.js",
            `--archive-dir=${archivesDir}`,
            "--bucket=mapbox",
            "--access=1FakeSerializedAccessGrant",
          ],
          { cwd: path.resolve(".") }
        ),
      /cp failed/
    );

    await stat(archivePath);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(fakeUplink, { force: true }));
    if (renamed) {
      await import("node:fs/promises").then(({ rename }) => rename(original, fakeUplink));
    }
  }
});
