import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextClientDir = path.join(root, "client");
const distDir = path.join(root, "src/client/dist");
const nextBin = path.join(root, "node_modules/next/dist/bin/next");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        ...(options.env || {}),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await rm(path.join(nextClientDir, ".next"), { recursive: true, force: true });
await rm(path.join(nextClientDir, "out"), { recursive: true, force: true });
await run(process.execPath, [nextBin, "build", nextClientDir], { cwd: root });
await cp(path.join(nextClientDir, "out"), distDir, { recursive: true });

console.log(`built dashboard client at ${path.relative(root, distDir)}`);
