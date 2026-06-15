import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeDisk({ name, filesystem, mount, totalBytes, freeBytes }) {
  const total = toNumber(totalBytes);
  const free = toNumber(freeBytes);
  const used = Math.max(0, total - free);
  return {
    name,
    filesystem: filesystem || name,
    mount: mount || name,
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    percentUsed: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

export function parseDfOutput(output) {
  return output
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
      if (!match) return null;
      const [, filesystem, totalKb, usedKb, freeKb, percentUsed, mount] = match;
      return {
        name: filesystem,
        filesystem,
        mount,
        totalBytes: toNumber(totalKb) * 1024,
        freeBytes: toNumber(freeKb) * 1024,
        usedBytes: toNumber(usedKb) * 1024,
        percentUsed: toNumber(percentUsed),
      };
    })
    .filter(Boolean);
}

export function parseWindowsLogicalDiskJson(output) {
  if (!output.trim()) return [];
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => Number(row.DriveType) === 3)
    .map((row) =>
      normalizeDisk({
        name: row.DeviceID,
        filesystem: row.VolumeName || row.DeviceID,
        mount: row.DeviceID,
        totalBytes: row.Size,
        freeBytes: row.FreeSpace,
      })
    );
}

export async function collectDiskInfo({ platform = process.platform } = {}) {
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType | ConvertTo-Json",
    ]);
    return parseWindowsLogicalDiskJson(stdout);
  }

  const { stdout } = await execFileAsync("df", ["-kP"]);
  return parseDfOutput(stdout);
}
