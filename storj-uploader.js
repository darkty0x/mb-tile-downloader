#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_UPLINK_BIN = path.join(
  __dirname,
  "tools",
  "uplink",
  process.platform === "win32" ? "uplink.exe" : "uplink"
);

function loadDotEnvIfPresent(envPath = path.join(__dirname, ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function printUsage(exitCode = 0) {
  const cmd = path.basename(process.argv[1] || "storj-uploader.js");
  console.log(
    [
      "",
      "Upload completed ZIP archives to Storj, then delete local ZIPs after remote verification.",
      "",
      `Usage: node ${cmd} [--archive-dir=path] [--bucket=name] [--prefix=path] [--access=grant] [--dry-run] [--keep-local]`,
      "",
      "Environment:",
      "  STORJ_BUCKET          required unless --bucket is provided",
      "  STORJ_PREFIX          remote folder/prefix",
      "  STORJ_ACCESS          required unless --access is provided",
      "",
      "Uplink binary:",
      "  Uses bundled tools/uplink/uplink.exe on Windows, or PATH uplink fallback.",
      "",
      "Behavior:",
      "  - uploads only completed .zip files",
      "  - skips upload when the same remote object already exists",
      "  - deletes the local zip only after the remote object is confirmed",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    archiveDir: path.join(__dirname, "archives"),
    bucket: null,
    prefix: null,
    access: null,
    dryRun: false,
    keepLocal: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") printUsage(0);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--keep-local") opts.keepLocal = true;
    else if (arg.startsWith("--archive-dir=")) opts.archiveDir = arg.slice("--archive-dir=".length);
    else if (arg.startsWith("--bucket=")) opts.bucket = arg.slice("--bucket=".length);
    else if (arg.startsWith("--prefix=")) opts.prefix = arg.slice("--prefix=".length);
    else if (arg.startsWith("--access=")) opts.access = arg.slice("--access=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  opts.archiveDir = path.resolve(opts.archiveDir);
  opts.bucket = opts.bucket || process.env.STORJ_BUCKET;
  opts.prefix = opts.prefix ?? process.env.STORJ_PREFIX ?? "";
  opts.access = opts.access || process.env.STORJ_ACCESS || process.env.STORJ_ACCESS_GRANT;
  return opts;
}

function normalizePrefix(prefix) {
  return String(prefix || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function remoteUrl(bucket, prefix, name) {
  const cleanPrefix = normalizePrefix(prefix);
  const encodedName = encodeURIComponent(name).replace(/%2F/gi, "/");
  return cleanPrefix
    ? `sj://${bucket}/${cleanPrefix}/${encodedName}`
    : `sj://${bucket}/${encodedName}`;
}

function uplinkArgs(args, access) {
  return access ? ["--access", access, ...args] : args;
}

function runUplink(args, { allowFailure = false, access = null } = {}) {
  const bin = fs.existsSync(LOCAL_UPLINK_BIN) ? LOCAL_UPLINK_BIN : "uplink";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, uplinkArgs(args, access), {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      const installHint =
        process.platform === "win32"
          ? "Install it with: winget install -e --id Storj.Uplink, then reopen PowerShell."
          : process.platform === "darwin"
            ? "Install it with: brew install storj-uplink."
            : "Install Storj Uplink CLI and make sure uplink is on PATH.";
      reject(
        new Error(
          `Failed to run ${bin}. ${installHint} Original error: ${err.message}`
        )
      );
    });
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${bin} ${args[0]} failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function remoteExists(url, access) {
  const result = await runUplink(["ls", url], { allowFailure: true, access });
  return result.code === 0;
}

async function listCompletedArchives(archiveDir) {
  const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    const filePath = path.join(archiveDir, entry.name);
    const stat = await fsp.stat(filePath);
    if (stat.size <= 0) continue;
    archives.push({ name: entry.name, filePath, size: stat.size });
  }
  archives.sort((a, b) => a.name.localeCompare(b.name));
  return archives;
}

async function uploadArchive({ archive, bucket, prefix, access, dryRun, keepLocal }) {
  const url = remoteUrl(bucket, prefix, archive.name);
  if (dryRun) {
    console.log(`DRY RUN upload: ${archive.filePath} -> ${url}`);
    return "dry-run";
  }

  if (await remoteExists(url, access)) {
    console.log(`SKIP remote exists: ${archive.name}`);
    if (!keepLocal) {
      await fsp.rm(archive.filePath, { force: true });
      console.log(`  deleted local: ${archive.filePath}`);
    }
    return "skipped";
  }

  console.log(`UPLOAD: ${archive.name} size=${archive.size} -> ${url}`);
  await runUplink(["cp", archive.filePath, url], { access });
  if (!(await remoteExists(url, access))) {
    throw new Error(`Remote verification failed after upload: ${url}`);
  }
  if (!keepLocal) {
    await fsp.rm(archive.filePath, { force: true });
    console.log(`  deleted local: ${archive.filePath}`);
  }
  return "uploaded";
}

async function main() {
  loadDotEnvIfPresent();
  const opts = parseArgs(process.argv);
  if (!opts.bucket) {
    throw new Error("STORJ_BUCKET is required, or pass --bucket=name");
  }
  if (!opts.access) {
    throw new Error("STORJ_ACCESS is required, or pass --access=grant");
  }

  const archives = await listCompletedArchives(opts.archiveDir);
  console.log(`Archive directory: ${opts.archiveDir}`);
  console.log(`Storj target: sj://${opts.bucket}/${normalizePrefix(opts.prefix)}`);
  console.log(`Completed ZIPs: ${archives.length}`);

  let uploaded = 0;
  let skipped = 0;
  for (const archive of archives) {
    const result = await uploadArchive({ archive, ...opts });
    if (result === "uploaded") uploaded++;
    else if (result === "skipped") skipped++;
  }

  console.log(`Done. uploaded=${uploaded} skipped=${skipped} remainingLocal=${opts.keepLocal ? archives.length : 0}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
