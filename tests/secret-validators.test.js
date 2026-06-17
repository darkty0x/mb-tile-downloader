import test from "node:test";
import assert from "node:assert/strict";

import { createSecretValidator } from "../dashboard/src/server/secret-validators.js";

function response({ status = 200, body = "ok" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return Buffer.from(body);
    },
    async text() {
      return body;
    },
  };
}

test("Mapbox validator checks a known tile endpoint and maps authorization errors to invalid", async () => {
  const calls = [];
  const validator = createSecretValidator({
    timeoutMs: 1000,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return response({ status: 401 });
    },
  });

  const result = await validator.validateSecret({
    secretType: "mapbox_token",
    value: "pk.bad-token",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.match(calls[0].url, /mapbox\.mapbox-streets-v8\/0\/0\/0\.vector\.pbf/);
  assert.match(calls[0].url, /access_token=pk\.bad-token/);
});

test("proxy validator sends the check through a proxy dispatcher", async () => {
  const calls = [];
  const validator = createSecretValidator({
    timeoutMs: 1000,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return response({ status: 200, body: "203.0.113.10" });
    },
  });

  const result = await validator.validateSecret({
    secretType: "proxy_txt",
    value: "proxy.example:8080",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "active");
  assert.equal(calls[0].url, "https://api.ipify.org?format=text");
  assert.ok(calls[0].init.dispatcher);
});
