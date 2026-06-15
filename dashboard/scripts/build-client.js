import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.join(root, "src/client");
const distDir = path.join(clientDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(path.join(clientDir, "index.html"), path.join(distDir, "index.html"));
await cp(path.join(clientDir, "src"), path.join(distDir, "src"), { recursive: true });

console.log(`built dashboard client at ${path.relative(root, distDir)}`);
