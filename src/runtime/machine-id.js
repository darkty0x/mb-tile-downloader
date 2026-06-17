export function normalizeMachineId(value) {
  return String(value || "").trim().toLowerCase();
}

export function requireMachineId(value, name = "machineId") {
  const machineId = normalizeMachineId(value);
  if (!machineId) throw new Error(`${name} is required`);
  return machineId;
}
