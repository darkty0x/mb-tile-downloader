import test from "node:test";
import assert from "node:assert/strict";

import { parseDfOutput, parseWindowsLogicalDiskJson } from "../src/agent/disk.js";

test("parses POSIX df -kP output into normalized byte counts", () => {
  const disks = parseDfOutput(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1 487350000 250000000 237350000 52% /
/dev/disk3s2 1000 250 750 25% /Volumes/Data Drive
`);

  assert.deepEqual(disks, [
    {
      name: "/dev/disk3s1",
      filesystem: "/dev/disk3s1",
      mount: "/",
      totalBytes: 487350000 * 1024,
      freeBytes: 237350000 * 1024,
      usedBytes: 250000000 * 1024,
      percentUsed: 52,
    },
    {
      name: "/dev/disk3s2",
      filesystem: "/dev/disk3s2",
      mount: "/Volumes/Data Drive",
      totalBytes: 1000 * 1024,
      freeBytes: 750 * 1024,
      usedBytes: 250 * 1024,
      percentUsed: 25,
    },
  ]);
});

test("parses Windows logical disk JSON object and array forms", () => {
  const single = parseWindowsLogicalDiskJson(
    JSON.stringify({
      DeviceID: "C:",
      VolumeName: "Windows",
      Size: "1000",
      FreeSpace: "250",
      DriveType: 3,
    })
  );
  const multiple = parseWindowsLogicalDiskJson(
    JSON.stringify([
      { DeviceID: "C:", Size: 1000, FreeSpace: 250, DriveType: 3 },
      { DeviceID: "D:", Size: 2000, FreeSpace: 1000, DriveType: 3 },
      { DeviceID: "Z:", Size: 3000, FreeSpace: 1500, DriveType: 4 },
    ])
  );

  assert.deepEqual(single[0], {
    name: "C:",
    filesystem: "Windows",
    mount: "C:",
    totalBytes: 1000,
    freeBytes: 250,
    usedBytes: 750,
    percentUsed: 75,
  });
  assert.equal(multiple.length, 2);
  assert.equal(multiple[1].name, "D:");
});
