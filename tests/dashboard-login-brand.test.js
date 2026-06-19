import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shellSource = readFileSync(new URL("../dashboard/client/components/dashboard-shell.jsx", import.meta.url), "utf8");

test("login screen renders the shared PTG logo instead of a literal PTG heading", () => {
  const loginScreenSource = shellSource.slice(
    shellSource.indexOf("export function LoginScreen"),
    shellSource.indexOf("export function AuthCheckingScreen"),
  );

  assert.match(loginScreenSource, /<LogoMark\s+[^>]*variant="login"/);
  assert.doesNotMatch(loginScreenSource, />PTG 관리체계<\/h1>/);
});
