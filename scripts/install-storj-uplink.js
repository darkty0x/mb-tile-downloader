#!/usr/bin/env node
"use strict";

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const toolsDir = path.join(rootDir, "tools", "uplink");

function printUsage(exitCode = 0) {
  console.log(
    [
      "",
      "Install Storj Uplink CLI into this repo's tools/uplink directory.",
      "",
      "Usage: node scripts/install-storj-uplink.js [--if-missing]",
      "",
      "Options:",
      "  --if-missing  Skip install when local uplink or PATH uplink works.",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function platformArchiveNames() {
  const isArm = process.arch === "arm64";
  if (process.platform === "win32") return ["uplink_windows_amd64.zip"];
  if (process.platform === "darwin") {
    return isArm ? ["uplink_darwin_arm64.zip", "uplink_darwin_amd64.zip"] : ["uplink_darwin_amd64.zip", "uplink_darwin_arm64.zip"];
  }
  return isArm ? ["uplink_linux_arm64.zip", "uplink_linux_amd64.zip"] : ["uplink_linux_amd64.zip", "uplink_linux_arm64.zip"];
}

function localExecutablePath() {
  return path.join(toolsDir, process.platform === "win32" ? "uplink.exe" : "uplink");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio || "pipe",
      shell: options.shell || false,
      cwd: options.cwd || rootDir,
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function executableWorks(filePath) {
  try {
    await run(filePath, ["version"]);
    return true;
  } catch {
    return false;
  }
}

async function commandWorks(command) {
  try {
    await run(command, ["version"]);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed ${response.status}: ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fsp.writeFile(destination, Buffer.from(arrayBuffer));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function fetchStorjReleases() {
  const response = await fetch("https://api.github.com/repos/storj/storj/releases?per_page=30", {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "mb-tile-downloader-uplink-installer",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases API failed ${response.status}`);
  }
  return response.json();
}

function selectReleaseAssetUrls(releases, archiveNames, { allowPrerelease = false } = {}) {
  const urls = [];
  for (const release of releases || []) {
    if (release?.draft) continue;
    if (release?.prerelease && !allowPrerelease) continue;
    for (const archiveName of archiveNames) {
      const asset = (release.assets || []).find((candidate) => candidate.name === archiveName);
      if (asset?.browser_download_url) urls.push(asset.browser_download_url);
    }
  }
  return unique(urls);
}

async function downloadUrlsForArchiveNames(archiveNames) {
  const allowPrerelease = process.env.STORJ_UPLINK_ALLOW_PRERELEASE === "1";
  const latestUrls = archiveNames.map(
    (archiveName) => `https://github.com/storj/storj/releases/latest/download/${archiveName}`
  );

  try {
    const releases = await fetchStorjReleases();
    const releaseUrls = selectReleaseAssetUrls(releases, archiveNames, { allowPrerelease });
    return unique([...releaseUrls, ...latestUrls]);
  } catch (err) {
    console.warn(`Storj release discovery failed: ${err.message}; falling back to latest download URLs`);
    return latestUrls;
  }
}

async function downloadCompatibleUplinkArchive(localPath) {
  const candidates = platformArchiveNames();
  const urls = await downloadUrlsForArchiveNames(candidates);
  const errors = [];
  for (const url of urls) {
    const archiveName = path.basename(new URL(url).pathname);
    const zipPath = path.join(toolsDir, archiveName);
    try {
      await download(url, zipPath);
      await extractZip(zipPath);
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      const exePath = await findExtractedExecutable();
      if (exePath && (await executableWorks(exePath))) {
        if (exePath !== localPath) {
          await fsp.cp(exePath, localPath, { force: true });
          await fsp.rm(exePath).catch(() => {});
        }
        return { archiveName, exePath: localPath };
      }
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      await fsp.rm(exePath, { force: true }).catch(() => {});
      errors.push(`${url}: extracted but produced no working executable`);
    } catch (err) {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      errors.push(`${url}: ${err.message}`);
    }
  }
  if (urls.length === 0) {
    errors.push(`no release asset found for ${candidates.join(" or ")}`);
  }
  throw new Error(`Failed to install a working Uplink binary: ${errors.join("; ")}`);
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Invalid ZIP: end of central directory not found");
}

function findZipEntry(buffer, executableName) {
  const eocd = findEndOfCentralDirectory(buffer);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = centralOffset;

  for (let i = 0; i < entries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid ZIP: central directory entry not found");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const entryName = buffer.toString("utf8", nameStart, nameStart + nameLength);
    const normalizedName = entryName.replace(/\\/g, "/");
    if (path.basename(normalizedName) === executableName) {
      return { entryName: normalizedName, method, compressedSize, uncompressedSize, localOffset };
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  throw new Error(`Invalid ZIP: ${executableName} not found`);
}

async function extractZip(
  zipPath,
  {
    destinationDir = toolsDir,
    executableName = process.platform === "win32" ? "uplink.exe" : "uplink",
  } = {}
) {
  await fsp.mkdir(destinationDir, { recursive: true });
  const buffer = await fsp.readFile(zipPath);
  const entry = findZipEntry(buffer, executableName);
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error("Invalid ZIP: local file header not found");
  }

  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  let payload;
  if (entry.method === 0) payload = compressed;
  else if (entry.method === 8) payload = inflateRawSync(compressed);
  else throw new Error(`Invalid ZIP: unsupported compression method ${entry.method}`);

  if (payload.length !== entry.uncompressedSize) {
    throw new Error(
      `Invalid ZIP: extracted ${payload.length} bytes, expected ${entry.uncompressedSize}`
    );
  }

  const outputPath = path.join(destinationDir, executableName);
  await fsp.writeFile(outputPath, payload);
  if (process.platform !== "win32") await fsp.chmod(outputPath, 0o755).catch(() => {});
  return outputPath;
}

async function findExtractedExecutable() {
  const expected = localExecutablePath();
  if (fs.existsSync(expected)) return expected;

  const stack = [toolsDir];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.name === (process.platform === "win32" ? "uplink.exe" : "uplink")) {
        await fsp.copyFile(fullPath, expected);
        if (process.platform !== "win32") await fsp.chmod(expected, 0o755).catch(() => {});
        return expected;
      }
    }
  }
  return null;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) printUsage(0);
  const ifMissing = process.argv.includes("--if-missing");
  const localPath = localExecutablePath();

  const localWorks = fs.existsSync(localPath) && (await executableWorks(localPath));
  if (ifMissing && localWorks) {
    console.log(`Storj uplink already installed: ${localPath}`);
    return;
  }

  if (ifMissing && await commandWorks("uplink")) {
    console.log("Storj uplink already available on PATH");
    return;
  }

  console.log(`Installing Storj uplink locally`);
  const result = await downloadCompatibleUplinkArchive(localPath);
  console.log(`Storj uplink installed: ${result.exePath} (${result.archiveName})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

export {
  extractZip,
  findZipEntry,
  platformArchiveNames,
  selectReleaseAssetUrls,
};
