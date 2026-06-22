import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  extractZip,
  executableWorks,
  installUplinkFromHomebrewBottle,
  installUplinkWithHomebrew,
  platformArchiveNames,
  resolveHomebrewCommand,
  selectReleaseAssetUrls,
} from "../scripts/install-storj-uplink.js";

function writeU16(buffer, value, offset) {
  buffer.writeUInt16LE(value & 0xffff, offset);
}

function writeU32(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const payload = Buffer.from(content);
    const local = Buffer.alloc(30 + nameBuffer.length);
    writeU32(local, 0x04034b50, 0);
    writeU16(local, 20, 4);
    writeU16(local, 0, 6);
    writeU16(local, 0, 8);
    writeU32(local, 0, 14);
    writeU32(local, payload.length, 18);
    writeU32(local, payload.length, 22);
    writeU16(local, nameBuffer.length, 26);
    writeU16(local, 0, 28);
    nameBuffer.copy(local, 30);
    localParts.push(local, payload);

    const central = Buffer.alloc(46 + nameBuffer.length);
    writeU32(central, 0x02014b50, 0);
    writeU16(central, 20, 4);
    writeU16(central, 20, 6);
    writeU16(central, 0, 8);
    writeU16(central, 0, 10);
    writeU32(central, 0, 16);
    writeU32(central, payload.length, 20);
    writeU32(central, payload.length, 24);
    writeU16(central, nameBuffer.length, 28);
    writeU16(central, 0, 30);
    writeU16(central, 0, 32);
    writeU32(central, offset, 42);
    nameBuffer.copy(central, 46);
    centralParts.push(central);
    offset += local.length + payload.length;
  }

  const centralStart = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0x06054b50, 0);
  writeU16(eocd, entries.length, 8);
  writeU16(eocd, entries.length, 10);
  writeU32(eocd, centralDirectory.length, 12);
  writeU32(eocd, centralStart, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

test("storj installer selects an existing stable release asset before prerelease latest", () => {
  const urls = selectReleaseAssetUrls(
    [
      {
        tag_name: "v2-rc",
        prerelease: true,
        assets: [
          {
            name: "uplink_linux_amd64.zip",
            browser_download_url: "https://example.test/rc/uplink_linux_amd64.zip",
          },
        ],
      },
      {
        tag_name: "v1",
        prerelease: false,
        assets: [
          {
            name: "uplink_linux_amd64.zip",
            browser_download_url: "https://example.test/stable/uplink_linux_amd64.zip",
          },
        ],
      },
    ],
    ["uplink_linux_amd64.zip"]
  );

  assert.deepEqual(urls, ["https://example.test/stable/uplink_linux_amd64.zip"]);
});

test("storj installer can include prerelease assets when explicitly allowed", () => {
  const urls = selectReleaseAssetUrls(
    [
      {
        tag_name: "v2-rc",
        prerelease: true,
        assets: [
          {
            name: "uplink_windows_amd64.zip",
            browser_download_url: "https://example.test/rc/uplink_windows_amd64.zip",
          },
        ],
      },
    ],
    ["uplink_windows_amd64.zip"],
    { allowPrerelease: true }
  );

  assert.deepEqual(urls, ["https://example.test/rc/uplink_windows_amd64.zip"]);
});

test("storj installer keeps Windows on the official Windows uplink asset", () => {
  assert.deepEqual(platformArchiveNames({ platform: "win32", arch: "x64" }), [
    "uplink_windows_amd64.zip",
  ]);
});

test("storj installer falls back to Homebrew when release assets are missing on macOS", async () => {
  const calls = [];
  const result = await installUplinkWithHomebrew({
    platform: "darwin",
    commandWorks: async (command) => command === "brew",
    runCommand: async (command, args) => {
      calls.push([command, args]);
      return { stdout: args[0] === "--prefix" ? "/opt/homebrew/opt/storj-uplink" : "installed", stderr: "" };
    },
    executableWorks: async () => true,
    localPath: "/repo/tools/uplink/uplink",
    mkdir: async () => {},
    copyFile: async () => {},
    chmod: async () => {},
  });

  assert.equal(result.exePath, "/repo/tools/uplink/uplink");
  assert.equal(result.archiveName, "homebrew:storj-uplink");
  assert.deepEqual(calls, [
    ["brew", ["install", "storj-uplink"]],
    ["brew", ["--prefix", "storj-uplink"]],
  ]);
});

test("storj installer does not use Homebrew fallback off macOS", async () => {
  await assert.rejects(
    () =>
      installUplinkWithHomebrew({
        platform: "linux",
        commandWorks: async () => true,
        runCommand: async () => ({ stdout: "", stderr: "" }),
        executableWorks: async () => true,
        localPath: "/repo/tools/uplink/uplink",
      }),
    /Homebrew fallback is only supported on macOS/
  );
});

test("storj installer finds Homebrew in standard macOS paths when PATH omits brew", async () => {
  const command = await resolveHomebrewCommand({
    commandWorks: async (candidate) => candidate === "/usr/local/bin/brew",
    runCommand: async () => {
      throw new Error("not on PATH");
    },
  });

  assert.equal(command, "/usr/local/bin/brew");
});

test("storj installer probes Homebrew with --version instead of generic version arg", async () => {
  const calls = [];
  const command = await resolveHomebrewCommand({
    commandWorks: async () => false,
    runCommand: async (candidate, args) => {
      calls.push([candidate, args]);
      if (candidate === "/usr/local/bin/brew" && args[0] === "--version") return { stdout: "Homebrew 4", stderr: "" };
      throw new Error("not found");
    },
  });

  assert.equal(command, "/usr/local/bin/brew");
  assert.deepEqual(calls, [
    ["brew", ["--version"]],
    ["/opt/homebrew/bin/brew", ["--version"]],
    ["/usr/local/bin/brew", ["--version"]],
  ]);
});

test("storj installer can extract uplink from a fetched Homebrew bottle", async () => {
  const calls = [];
  const result = await installUplinkFromHomebrewBottle({
    brewCommand: "/usr/local/bin/brew",
    runCommand: async (command, args) => {
      calls.push([command, args]);
      if (command === "/usr/local/bin/brew" && args[0] === "fetch") return { stdout: "fetched", stderr: "" };
      if (command === "/usr/local/bin/brew" && args[0] === "--cache") return { stdout: "/cache/storj-uplink.bottle.tar.gz\n", stderr: "" };
      if (command === "tar" && args[0] === "-tzf") {
        return { stdout: "storj-uplink/1.157.5/bin/uplink\n", stderr: "" };
      }
      if (command === "tar" && args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error("unexpected command");
    },
    executableWorks: async () => true,
    localPath: "/repo/tools/uplink/uplink",
    mkdtemp: async () => "/tmp/storj-bottle-test",
    mkdir: async () => {},
    copyFile: async () => {},
    chmod: async () => {},
    rm: async () => {},
  });

  assert.equal(result.exePath, "/repo/tools/uplink/uplink");
  assert.equal(result.archiveName, "homebrew-bottle:storj-uplink");
  assert.deepEqual(calls, [
    ["/usr/local/bin/brew", ["fetch", "--force-bottle", "storj-uplink"]],
    ["/usr/local/bin/brew", ["--cache", "storj-uplink"]],
    ["tar", ["-tzf", "/cache/storj-uplink.bottle.tar.gz"]],
    ["tar", ["-xzf", "/cache/storj-uplink.bottle.tar.gz", "-C", "/tmp/storj-bottle-test", "storj-uplink/1.157.5/bin/uplink"]],
  ]);
});

test("storj installer probes executables with closed stdin", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-stdin-"));
  const executable = path.join(dir, "stdin-check");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "node -e \"const fs = require('fs'); process.exit(fs.fstatSync(0).isFIFO() ? 1 : 0)\"",
      "",
    ].join("\n")
  );
  await chmod(executable, 0o755);

  assert.equal(await executableWorks(executable), true);
});

test("storj installer extracts uplink zip without a system unzip dependency", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storj-install-"));
  const zipPath = path.join(dir, "uplink_linux_amd64.zip");
  const destinationDir = path.join(dir, "tools");
  await mkdir(destinationDir, { recursive: true });
  await writeFile(zipPath, storedZip([["nested/uplink", "fake-uplink"]]));

  const extractedPath = await extractZip(zipPath, {
    destinationDir,
    executableName: "uplink",
  });

  assert.equal(extractedPath, path.join(destinationDir, "uplink"));
  assert.equal(await readFile(extractedPath, "utf8"), "fake-uplink");
  const mode = (await stat(extractedPath)).mode & 0o777;
  assert.ok((mode & 0o111) !== 0);
});
