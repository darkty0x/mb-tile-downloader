import { execFileSync } from "node:child_process";

let configured = false;

export function enableWindowsUtf8Console({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (configured || platform !== "win32") return false;
  configured = true;
  try {
    execFileSyncImpl("chcp.com", ["65001"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
