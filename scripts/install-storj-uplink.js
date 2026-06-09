#!/usr/bin/env node
"use strict";

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function platformArchiveName() {
  if (process.platform === "win32") return "uplink_windows_amd64.zip";
  if (process.platform === "darwin") return "uplink_darwin_amd64.zip";
  return "uplink_linux_amd64.zip";
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

async function extractZip(zipPath) {
  await fsp.mkdir(toolsDir, { recursive: true });
  if (process.platform === "win32") {
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(toolsDir)} -Force`,
      ],
      { shell: false }
    );
    return;
  }

  await run("unzip", ["-o", zipPath, "-d", toolsDir]);
  await fsp.chmod(localExecutablePath(), 0o755).catch(() => {});
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

  if (await executableWorks(localPath)) {
    console.log(`Storj uplink already installed: ${localPath}`);
    return;
  }

  if (ifMissing && await commandWorks("uplink")) {
    console.log("Storj uplink already available on PATH");
    return;
  }

  const archiveName = platformArchiveName();
  const url = `https://github.com/storj/storj/releases/latest/download/${archiveName}`;
  const zipPath = path.join(toolsDir, archiveName);

  console.log(`Installing Storj uplink locally: ${url}`);
  await fsp.mkdir(toolsDir, { recursive: true });
  await download(url, zipPath);
  await extractZip(zipPath);
  await fsp.rm(zipPath, { force: true }).catch(() => {});

  const exePath = await findExtractedExecutable();
  if (!exePath || !(await executableWorks(exePath))) {
    throw new Error(`Storj uplink install did not produce a working executable at ${localPath}`);
  }

  console.log(`Storj uplink installed: ${exePath}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
