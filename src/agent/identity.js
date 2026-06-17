import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeMachineId } from "../runtime/machine-id.js";

export async function loadAgentIdentity({
  stateDir = ".tile-state",
  machineId = process.env.MACHINE_ID,
} = {}) {
  const normalizedMachineId = normalizeMachineId(machineId);
  if (!normalizedMachineId) {
    throw new Error("MACHINE_ID is required for dashboard agent");
  }

  await mkdir(stateDir, { recursive: true });
  const identityPath = path.join(stateDir, "agent-id.json");

  try {
    const parsed = JSON.parse(await readFile(identityPath, "utf8"));
    if (parsed.agentInstanceId) {
      return {
        machineId: normalizedMachineId,
        agentInstanceId: parsed.agentInstanceId,
        identityPath,
      };
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const agentInstanceId = randomUUID();
  await writeFile(identityPath, `${JSON.stringify({ agentInstanceId }, null, 2)}\n`);
  return {
    machineId: normalizedMachineId,
    agentInstanceId,
    identityPath,
  };
}
