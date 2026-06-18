import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);

test("package upload script does not force a downloader config", async () => {
  const pkg = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.match(pkg.scripts.upload, /--env-file-if-exists=\.env/);
  assert.match(pkg.scripts.upload, /node storj-uploader\.js$/);
  assert.doesNotMatch(pkg.scripts.upload, /configs\//);
  assert.equal(pkg.scripts["storj-upload"], pkg.scripts.upload);
});

test("storj uploader defaults uploads into archives folder", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const archivePath = path.join(archivesDir, "tiles_vector_1_000000-000000_y000000-000000.zip");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(archivePath, "zip");

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "storj-uploader.js",
      `--archive-dir=${archivesDir}`,
      "--bucket=mapbox",
      "--dry-run",
    ],
    { cwd: path.resolve("."), env: { ...process.env, STORJ_PREFIX: "archives" } }
  );

  assert.match(
    stdout,
    /sj:\/\/mapbox\/archives\/tiles_vector_1_000000-000000_y000000-000000\.zip/
  );
});

test("storj uploader prints parseable archive result diagnostics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const archivePath = path.join(archivesDir, "tiles_vector_1_000000-000000_y000000-000000.zip");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(archivePath, "zip");

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "storj-uploader.js",
      `--archive-dir=${archivesDir}`,
      "--bucket=mapbox",
      "--dry-run",
    ],
    { cwd: path.resolve("."), env: { ...process.env, STORJ_PREFIX: "archives" } }
  );

  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("[storj-result] "));
  assert.ok(line, "expected a storj-result line");
  const result = JSON.parse(line.replace("[storj-result] ", ""));
  assert.deepEqual(result, {
    ok: true,
    status: "dry-run",
    bucket: "mapbox",
    remotePath: "archives/tiles_vector_1_000000-000000_y000000-000000.zip",
    remoteUrl: "sj://mapbox/archives/tiles_vector_1_000000-000000_y000000-000000.zip",
    localPath: archivePath,
    bytes: 3,
  });
});

test("storj uploader uses config jobName as remote folder when config is provided", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const configPath = path.join(dir, "13-mapbox-pbf.config.json");
  const archivePath = path.join(archivesDir, "tiles_vector_1_000000-000000_y000000-000000.zip");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(archivePath, "zip");
  await writeFile(configPath, JSON.stringify({ jobName: "13-mapbox-pbf" }));

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "storj-uploader.js",
      configPath,
      `--archive-dir=${archivesDir}`,
      "--bucket=mapbox",
      "--dry-run",
    ],
    { cwd: path.resolve("."), env: { ...process.env, STORJ_PREFIX: "archives" } }
  );

  assert.match(
    stdout,
    /sj:\/\/mapbox\/13-mapbox-pbf\/tiles_vector_1_000000-000000_y000000-000000\.zip/
  );
});

test("storj uploader filters local archives by downloader config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const configPath = path.join(dir, "13-esri-satellite.config.json");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(
    path.join(archivesDir, "tiles_esri-satellite_5_000027-000027_y000019-000019.zip"),
    "zip"
  );
  await writeFile(
    path.join(archivesDir, "tiles_satellite_5_000027-000027_y000019-000019.zip"),
    "wrong-provider"
  );
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "13-esri-satellite",
      provider: "esri",
      layer: "esri-satellite",
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
    })
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "storj-uploader.js",
      configPath,
      `--archive-dir=${archivesDir}`,
      "--bucket=mapbox",
      "--dry-run",
    ],
    { cwd: path.resolve("."), env: { ...process.env, STORJ_PREFIX: "archives" } }
  );

  assert.match(stdout, /Storj target: sj:\/\/mapbox\/13-esri-satellite/);
  assert.match(stdout, /Config ZIPs planned: 1/);
  assert.match(stdout, /Config ZIPs available: 1/);
  assert.match(stdout, /Config ZIPs missing: 0/);
  assert.match(
    stdout,
    /sj:\/\/mapbox\/13-esri-satellite\/tiles_esri-satellite_5_000027-000027_y000019-000019\.zip/
  );
  assert.doesNotMatch(stdout, /tiles_satellite_5_000027-000027_y000019-000019\.zip/);
});

test("storj uploader does not share incomplete config uploads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const configPath = path.join(dir, "13-esri-satellite.config.json");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "13-esri-satellite",
      provider: "esri",
      layer: "esri-satellite",
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
    })
  );

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          "storj-uploader.js",
          configPath,
          `--archive-dir=${archivesDir}`,
          "--bucket=mapbox",
          "--dry-run",
        ],
        { cwd: path.resolve(".") }
      ),
    (err) => {
      assert.match(err.stdout, /Config ZIPs missing: 1/);
      assert.match(err.stdout, /MISSING local archive: tiles_esri-satellite_5_000027-000027_y000019-000019\.zip/);
      assert.match(err.stdout, /Share link: skipped because config upload is incomplete/);
      assert.doesNotMatch(err.stdout, /dry-run skipped for sj:\/\/mapbox\/13-esri-satellite\//);
      return true;
    }
  );
});

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

test("storj uploader configures api-key credentials without interactive setup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const toolsDir = path.join(path.resolve("."), "tools", "uplink");
  const callsPath = path.join(dir, "uplink-calls.txt");
  const archivePath = path.join(archivesDir, "tiles_vector_1_000000-000000_y000000-000000.zip");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(archivePath, "zip");

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
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.UPLINK_CALLS_PATH, args.join(' ') + '\\n');",
        "if (args.includes('setup')) process.exit(9);",
        "if (args.includes('create')) process.exit(0);",
        "if (args.includes('ls')) { console.log('tiles_vector_1_000000-000000_y000000-000000.zip'); console.log('archives-manifest.json'); process.exit(0); }",
        "if (args.includes('cp')) process.exit(0);",
        "process.exit(0);",
      ].join("\n"),
      { mode: 0o755 }
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "storj-uploader.js",
        `--archive-dir=${archivesDir}`,
        "--bucket=mapbox",
        "--access=121Test@ap1.storj.io:7777 1ApiKey",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          STORJ_PASSPHRASE: "test-passphrase",
          UPLINK_CALLS_PATH: callsPath,
        },
      }
    );

    const calls = await import("node:fs/promises").then(({ readFile }) =>
      readFile(callsPath, "utf8")
    );
    assert.match(calls, /access create .*--passphrase-stdin .*--import-as mb-tile-downloader .*--force .*--use/);
    assert.doesNotMatch(calls, /\bsetup\b/);
    assert.match(stdout, /SKIP remote exists/);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(fakeUplink, { force: true }));
    if (renamed) {
      await import("node:fs/promises").then(({ rename }) => rename(original, fakeUplink));
    }
  }
});

test("storj uploader removes legacy manifest for config run with no local zips", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const configPath = path.join(dir, "13-esri-satellite.config.json");
  const toolsDir = path.join(path.resolve("."), "tools", "uplink");
  const callsPath = path.join(dir, "uplink-calls.txt");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      jobName: "13-esri-satellite",
      provider: "esri",
      layer: "esri-satellite",
      ranges: [{ zoom: 5, xStart: 27, xEnd: 27, yStart: 19, yEnd: 19 }],
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
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.UPLINK_CALLS_PATH, args.join(' ') + '\\n');",
        "if (args.includes('import')) process.exit(0);",
        "if (args.includes('ls')) { console.log('archives-manifest.json'); process.exit(0); }",
        "if (args.includes('rm')) process.exit(0);",
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
            configPath,
            `--archive-dir=${archivesDir}`,
            "--bucket=mapbox",
            "--access=1FakeSerializedAccessGrant",
          ],
          {
            cwd: path.resolve("."),
            env: { ...process.env, UPLINK_CALLS_PATH: callsPath },
          }
        ),
      /Command failed/
    );

    const calls = await readFile(callsPath, "utf8");
    assert.match(calls, /rm sj:\/\/mapbox\/13-esri-satellite\/archives-manifest\.json/);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(fakeUplink, { force: true }));
    if (renamed) {
      await import("node:fs/promises").then(({ rename }) => rename(original, fakeUplink));
    }
  }
});

test("storj uploader prints share link after upload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-uploader-"));
  const archivesDir = path.join(dir, "archives");
  const configPath = path.join(dir, "13-mapbox-pbf.config.json");
  const toolsDir = path.join(path.resolve("."), "tools", "uplink");
  const callsPath = path.join(dir, "uplink-calls.txt");
  const archivePath = path.join(archivesDir, "tiles_vector_1_000000-000000_y000000-000000.zip");
  await mkdir(archivesDir, { recursive: true });
  await writeFile(archivePath, "zip");
  await writeFile(configPath, JSON.stringify({ jobName: "13-mapbox-pbf" }));

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
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.UPLINK_CALLS_PATH, args.join(' ') + '\\n');",
        "if (args.includes('import')) process.exit(0);",
        "if (args.includes('ls')) { console.log('tiles_vector_1_000000-000000_y000000-000000.zip'); console.log('archives-manifest.json'); process.exit(0); }",
        "if (args.includes('cp')) process.exit(0);",
        "if (args.includes('share')) { console.log('URL       : https://link.storjshare.io/s/testshare/mapbox/13-mapbox-pbf/'); process.exit(0); }",
        "process.exit(0);",
      ].join("\n"),
      { mode: 0o755 }
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "storj-uploader.js",
        configPath,
        `--archive-dir=${archivesDir}`,
        "--bucket=mapbox",
        "--access=1FakeSerializedAccessGrant",
      ],
      {
        cwd: path.resolve("."),
        env: { ...process.env, UPLINK_CALLS_PATH: callsPath },
      }
    );

    const calls = await import("node:fs/promises").then(({ readFile }) =>
      readFile(callsPath, "utf8")
    );
    assert.match(calls, /share --url --readonly --not-after=none sj:\/\/mapbox\/13-mapbox-pbf\//);
    assert.match(stdout, /Share link: https:\/\/link\.storjshare\.io\/s\/testshare\/mapbox\/13-mapbox-pbf\//);
    assert.match(stdout, /Raw link prefix: https:\/\/link\.storjshare\.io\/raw\/testshare\/mapbox\/13-mapbox-pbf\//);
    const shareResultLine = stdout
      .split(/\r?\n/)
      .find((item) => item.startsWith("[storj-result] ") && item.includes('"status":"shared"'));
    assert.ok(shareResultLine, "expected a structured storj share result");
    const shareResult = JSON.parse(shareResultLine.replace("[storj-result] ", ""));
    assert.equal(shareResult.shareUrl, "https://link.storjshare.io/s/testshare/mapbox/13-mapbox-pbf/");
    assert.equal(shareResult.rawLinkPrefix, "https://link.storjshare.io/raw/testshare/mapbox/13-mapbox-pbf/");
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(fakeUplink, { force: true }));
    if (renamed) {
      await import("node:fs/promises").then(({ rename }) => rename(original, fakeUplink));
    }
  }
});
