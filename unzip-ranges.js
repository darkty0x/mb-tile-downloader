#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT =
  "/Volumes/Share/2.본사자료조사/MB/Ranges/SK-MIL-30";

function printUsage(exitCode = 0) {
  const cmd = path.basename(process.argv[1] || "unzip-ranges.js");
  console.log(
    [
      "",
      "Unzip all tile ZIP archives under a ranges directory into each ZIP's own folder.",
      "",
      `Usage: node ${cmd} [rootDir] [--concurrency=N] [--dry-run] [--force]`,
      "",
      "Defaults:",
      `  rootDir: ${DEFAULT_ROOT}`,
      "",
      "Behavior:",
      "  - finds .zip files recursively",
      "  - extracts every zip into the folder where that zip already exists",
      "  - uses unzip -n, so existing tile files are not overwritten",
      "  - writes .unzip-state markers only after successful extraction",
      "  - resumes by skipping zips with matching completed markers",
      "  - keeps original zip files",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    rootDir: DEFAULT_ROOT,
    concurrency: 5,
    dryRun: false,
    force: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") printUsage(0);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--force") opts.force = true;
    else if (arg.startsWith("--concurrency=")) {
      opts.concurrency = parsePositiveInteger(arg.slice("--concurrency=".length), "--concurrency");
    } else if (!arg.startsWith("-") && opts.rootDir === DEFAULT_ROOT) {
      opts.rootDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  opts.rootDir = path.resolve(opts.rootDir);
  return opts;
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkZipFiles(rootDir) {
  const result = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".unzip-state") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        result.push(fullPath);
      }
    }
  }

  return result.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function statePathFor(rootDir, zipPath) {
  const rel = path.relative(rootDir, zipPath).replace(/\\/g, "/");
  return path.join(rootDir, ".unzip-state", `${rel.replaceAll("/", "__")}.json`);
}

async function readMarker(markerPath) {
  try {
    return JSON.parse(await fsp.readFile(markerPath, "utf8"));
  } catch {
    return null;
  }
}

async function zipFingerprint(zipPath) {
  const stat = await fsp.stat(zipPath);
  return {
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

function runUnzip(zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-q", "-n", zipPath, "-d", outputDir], {
      stdio: ["ignore", "pipe", "pipe"],
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
      reject(
        new Error(
          `Failed to run unzip. Install Info-ZIP unzip or run on macOS/Linux with unzip available. Original error: ${err.message}`
        )
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`unzip failed code=${code} zip=${zipPath}\n${stderr || stdout}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function isEmptyZipFailure(err, fingerprint) {
  if (fingerprint.size === 0) return true;
  return /zipfile is empty/i.test(`${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`);
}

async function writeMarker(markerPath, payload) {
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n");
  await fsp.rename(tmpPath, markerPath);
}

async function unzipOne({ rootDir, zipPath, force, dryRun }) {
  const rel = path.relative(rootDir, zipPath);
  let fingerprint;
  try {
    fingerprint = await zipFingerprint(zipPath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { status: "missing", rel };
    }
    throw err;
  }
  const markerPath = statePathFor(rootDir, zipPath);
  const marker = await readMarker(markerPath);

  if (
    !force &&
    (marker?.status === "complete" || marker?.status === "ignored-empty") &&
    marker?.size === fingerprint.size &&
    marker?.mtimeMs === fingerprint.mtimeMs
  ) {
    return { status: "skipped", rel };
  }

  if (dryRun) return { status: "planned", rel };

  const outputDir = path.dirname(zipPath);
  try {
    await runUnzip(zipPath, outputDir);
  } catch (err) {
    if (!isEmptyZipFailure(err, fingerprint)) throw err;
    await writeMarker(markerPath, {
      status: "ignored-empty",
      zip: rel.replace(/\\/g, "/"),
      outputDir: path.relative(rootDir, outputDir).replace(/\\/g, "/") || ".",
      size: fingerprint.size,
      mtimeMs: fingerprint.mtimeMs,
      ignoredAt: new Date().toISOString(),
      reason: "empty zip archive",
    });
    return { status: "ignored-empty", rel };
  }
  await writeMarker(markerPath, {
    status: "complete",
    zip: rel.replace(/\\/g, "/"),
    outputDir: path.relative(rootDir, outputDir).replace(/\\/g, "/") || ".",
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    completedAt: new Date().toISOString(),
  });
  return { status: "unzipped", rel };
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    const results = [];
    while (next < items.length) {
      const item = items[next++];
      results.push(await worker(item));
    }
    return results;
  });
  return (await Promise.all(workers)).flat();
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!(await pathExists(opts.rootDir))) {
    throw new Error(`Root directory does not exist: ${opts.rootDir}`);
  }

  const zipFiles = await walkZipFiles(opts.rootDir);
  console.log(`Root: ${opts.rootDir}`);
  console.log(`ZIP files found: ${zipFiles.length}`);
  console.log(`Concurrency: ${opts.concurrency}`);
  if (opts.dryRun) console.log("Mode: dry-run");
  if (opts.force) console.log("Mode: force");

  let done = 0;
  const counts = { planned: 0, skipped: 0, unzipped: 0, "ignored-empty": 0, missing: 0 };
  const startedAt = Date.now();

  const results = await runPool(zipFiles, opts.concurrency, async (zipPath) => {
    const result = await unzipOne({ ...opts, zipPath });
    counts[result.status] += 1;
    done += 1;
    if (done === 1 || done === zipFiles.length || done % 25 === 0) {
      const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
      const rate = done / elapsedSec;
      console.log(
        `${done}/${zipFiles.length} ${result.status}: ${result.rel} rate=${rate.toFixed(1)} zip/s`
      );
    }
    return result;
  });

  console.log("Summary:");
  console.log(`  Planned: ${counts.planned}`);
  console.log(`  Skipped: ${counts.skipped}`);
  console.log(`  Unzipped: ${counts.unzipped}`);
  console.log(`  Ignored empty: ${counts["ignored-empty"]}`);
  console.log(`  Missing: ${counts.missing}`);
  console.log(`  Total: ${results.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

export { unzipOne };
