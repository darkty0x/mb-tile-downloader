import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

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

function isUsefulPosixDisk(disk) {
  const mount = String(disk.mount || "");
  const filesystem = String(disk.filesystem || "");
  if (!mount || !filesystem) return false;
  if (filesystem === "devfs" || filesystem === "map" || filesystem === "tmpfs") return false;
  if (/^(devfs|tmpfs|autofs|procfs|sysfs|overlay)$/i.test(filesystem)) return false;
  if (mount === "/dev") return false;
  if (mount.startsWith("/System/Volumes/")) return false;
  if (mount.startsWith("/private/var/")) return false;
  if (mount.startsWith("/run/") || mount.startsWith("/snap/")) return false;
  return mount === "/" || mount.startsWith("/Volumes/") || mount.startsWith("/mnt/") || mount.startsWith("/media/");
}

function diskContainsProject(disk, projectDir, platform = process.platform) {
  if (!projectDir) return false;
  const mount = String(disk.mount || disk.name || "");
  if (platform === "win32") {
    const resolvedProject = path.win32.resolve(projectDir).toLowerCase();
    const resolvedMount = path.win32.resolve(`${mount}\\`).toLowerCase();
    if (resolvedProject === resolvedMount.replace(/\\$/, "")) return true;
    return resolvedProject.toLowerCase().startsWith(`${mount.toLowerCase()}\\`);
  }
  const resolvedProject = path.resolve(projectDir);
  const resolvedMount = path.resolve(mount);
  return resolvedProject === resolvedMount || resolvedProject.startsWith(`${resolvedMount}${path.sep}`);
}

function markProjectDisk(disks, { projectDir, platform = process.platform } = {}) {
  return disks.map((disk) => ({
    ...disk,
    ...(diskContainsProject(disk, projectDir, platform) ? { containsProject: true } : {}),
  }));
}

export function parseDfOutput(output, { projectDir, platform = process.platform } = {}) {
  const disks = output
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
    .filter(Boolean)
    .filter(isUsefulPosixDisk);
  return markProjectDisk(disks, { projectDir, platform });
}

export function parseWindowsLogicalDiskJson(output, { projectDir, platform = "win32" } = {}) {
  if (!output.trim()) return [];
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const disks = rows
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
  return markProjectDisk(disks, { projectDir, platform });
}

export async function collectDiskInfo({ platform = process.platform, projectDir = process.cwd() } = {}) {
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType | ConvertTo-Json",
    ]);
    return parseWindowsLogicalDiskJson(stdout, { projectDir, platform });
  }

  const { stdout } = await execFileAsync("df", ["-kP"]);
  return parseDfOutput(stdout, { projectDir, platform });
}
