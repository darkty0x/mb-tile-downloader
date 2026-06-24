export function machineSortNumber(value) {
  const text = String(value || "").trim();
  const match = /(?:server|봉사기|agent|pc)?[\s_-]*0*(\d+)\b/i.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function compareMachineIds(left, right) {
  const leftNumber = machineSortNumber(left);
  const rightNumber = machineSortNumber(right);
  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== null && rightNumber === null) return -1;
  if (leftNumber === null && rightNumber !== null) return 1;
  return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true, sensitivity: "base" });
}
