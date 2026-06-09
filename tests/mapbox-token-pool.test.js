import test from "node:test";
import assert from "node:assert/strict";

import {
  MapboxTokenPool,
  loadMapboxTokensFromEnv,
} from "../src/auth/mapbox-token-pool.js";

test("loads Mapbox tokens from comma list and numbered env vars", () => {
  const tokens = loadMapboxTokensFromEnv({
    MAPBOX_ACCESS_TOKENS: "a, b",
    MAPBOX_ACCESS_TOKEN_1: "c",
    MAPBOX_ACCESS_TOKEN_2: "b",
  });

  assert.deepEqual(tokens, ["a", "b", "c"]);
});

test("rotates immediately when a token is marked exhausted", () => {
  const pool = new MapboxTokenPool(["token-a", "token-b"]);

  assert.equal(pool.current(), "token-a");
  pool.markCurrentUnusable("exhausted", "HTTP 403 quota");

  assert.equal(pool.current(), "token-b");
  assert.equal(pool.snapshot().tokens[0].status, "exhausted");
});

test("throws immediately when all Mapbox tokens are unusable", () => {
  const pool = new MapboxTokenPool(["token-a"]);
  pool.markCurrentUnusable("invalid", "HTTP 401");

  assert.throws(() => pool.current(), /All Mapbox access tokens are unusable/);
});

test("marks the token that failed, not whichever token is current later", () => {
  const pool = new MapboxTokenPool(["token-a", "token-b", "token-c"]);
  const first = pool.current();

  pool.markTokenUnusable(first, "invalid", "HTTP 401");
  pool.markTokenUnusable(first, "invalid", "duplicate HTTP 401");

  assert.equal(pool.current(), "token-b");
  assert.deepEqual(
    pool.snapshot().tokens.map((record) => record.status),
    ["invalid", "active", "active"]
  );
});

test("ignores persisted state if it says every current token is unusable", () => {
  const pool = new MapboxTokenPool(["token-a", "token-b"], [
    { token: "token-a", status: "invalid", reason: "old failed run" },
    { token: "token-b", status: "exhausted", reason: "old failed run" },
  ]);

  assert.equal(pool.current(), "token-a");
  assert.deepEqual(
    pool.snapshot().tokens.map((record) => record.status),
    ["active", "active"]
  );
});

test("starts current env tokens as active even if persisted state is partially stale", () => {
  const pool = new MapboxTokenPool(["token-a", "token-b"], [
    { token: "token-a", status: "invalid", reason: "old failed run" },
  ]);

  assert.equal(pool.current(), "token-a");
  assert.deepEqual(
    pool.snapshot().tokens.map((record) => record.status),
    ["active", "active"]
  );
});
