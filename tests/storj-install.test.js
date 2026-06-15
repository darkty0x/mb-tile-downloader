import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractZip, selectReleaseAssetUrls } from "../scripts/install-storj-uplink.js";

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
