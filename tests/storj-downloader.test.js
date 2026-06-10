import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);

test("storj downloader places archives under configured range id folders", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-downloader-"));
  const downloadDir = path.join(dir, "download");
  const configPath = path.join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "13-mapbox-pbf",
      provider: "mapbox",
      layer: "vector",
      ranges: [
        {
          id: "mcs-range-001",
          zoom: 5,
          xStart: 27,
          xEnd: 27,
          yStart: 19,
          yEnd: 19,
        },
      ],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "storj-downloader.js",
      configPath,
      `--download-dir=${downloadDir}`,
      "--bucket=mapbox",
      "--dry-run",
    ],
    { cwd: path.resolve("."), env: { ...process.env, STORJ_PREFIX: "archives" } }
  );

  assert.match(
    stdout,
    /sj:\/\/mapbox\/13-mapbox-pbf\/tiles_vector_5_000027-000027_y000019-000019\.zip -> .*mcs-range-001.*tiles_vector_5_000027-000027_y000019-000019\.zip/
  );
});

test("storj downloader downloads missing local archive into range id folder", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-downloader-"));
  const downloadDir = path.join(dir, "download");
  const configPath = path.join(dir, "config.json");
  const toolsDir = path.join(path.resolve("."), "tools", "uplink");
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "restore-test",
      provider: "mapbox",
      layer: "vector",
      ranges: [
        {
          rangeId: "range-A",
          zoom: 5,
          xStart: 27,
          xEnd: 27,
          yStart: 19,
          yEnd: 19,
        },
      ],
    })
  );

  const fakeUplink = path.join(toolsDir, process.platform === "win32" ? "uplink.exe" : "uplink");
  const original = path.join(
    toolsDir,
    process.platform === "win32" ? "uplink.exe.real-test" : "uplink.real-test"
  );
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
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const args = process.argv.slice(2);",
        "if (args.includes('import')) process.exit(0);",
        "if (args.includes('ls')) { console.log('tiles_vector_5_000027-000027_y000019-000019.zip'); process.exit(0); }",
        "if (args.includes('cp')) { const dest = args[args.length - 1]; fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'zip'); process.exit(0); }",
        "process.exit(0);",
      ].join("\n"),
      { mode: 0o755 }
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "storj-downloader.js",
        configPath,
        `--download-dir=${downloadDir}`,
        "--bucket=mapbox",
        "--access=1FakeSerializedAccessGrant",
      ],
      { cwd: path.resolve(".") }
    );

    const localPath = path.join(
      downloadDir,
      "range-A",
      "tiles_vector_5_000027-000027_y000019-000019.zip"
    );
    assert.match(stdout, /Done\. downloaded=1 skipped=0 missing=0/);
    assert.equal(await readFile(localPath, "utf8"), "zip");
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(fakeUplink, { force: true }));
    if (renamed) {
      await import("node:fs/promises").then(({ rename }) => rename(original, fakeUplink));
    }
  }
});
