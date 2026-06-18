import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PRESERVED_NAMES = new Set(["MAPBOX_ACCESS_TOKENS"]);
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnvLines(text) {
  const values = new Map();
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) throw new Error(`invalid .env line: ${rawLine}`);
    const name = line.slice(0, index).trim();
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`invalid .env name: ${name}`);
    values.set(name, line.slice(index + 1));
  }
  return values;
}

async function readExistingEnv(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

export async function writeRootEnvFile({ projectDir = process.cwd(), envText = "" } = {}) {
  const envPath = path.resolve(projectDir, ".env");
  const incoming = parseEnvLines(envText);
  const existing = parseEnvLines(await readExistingEnv(envPath));
  for (const name of PRESERVED_NAMES) {
    if (!incoming.has(name) && existing.has(name)) incoming.set(name, existing.get(name));
  }
  const lines = [...incoming.entries()].map(([name, value]) => `${name}=${value}`);
  const tmpPath = `${envPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
  await rename(tmpPath, envPath);
  return {
    envPath,
    variableCount: incoming.size,
    preserved: [...PRESERVED_NAMES].filter((name) => existing.has(name) && incoming.has(name)),
  };
}
