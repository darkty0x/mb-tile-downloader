import test from "node:test";
import assert from "node:assert/strict";

import { buildPlatformProfile } from "../src/runtime/platform-profile.js";

test("caps Linux concurrency below V8 heap-risk levels", () => {
  const profile = buildPlatformProfile({
    platform: "linux",
    cpuCount: 16,
    requestedConcurrency: 4096,
    requestedRows: 64,
  });

  assert.equal(profile.os, "linux");
  assert.equal(profile.maxConcurrentRequests, 1024);
  assert.equal(profile.maxRowsInFlight, 1);
  assert.equal(profile.wasConcurrencyCapped, true);
});

test("uses safer macOS defaults to avoid descriptor pressure", () => {
  const profile = buildPlatformProfile({
    platform: "darwin",
    cpuCount: 10,
    requestedConcurrency: 4096,
    requestedRows: 32,
  });

  assert.equal(profile.os, "macos");
  assert.equal(profile.maxConcurrentRequests, 4096);
  assert.equal(profile.maxRowsInFlight, 1);
});

test("uses conservative Windows filesystem concurrency", () => {
  const profile = buildPlatformProfile({
    platform: "win32",
    cpuCount: 12,
    requestedConcurrency: 2048,
    requestedRows: 32,
  });

  assert.equal(profile.os, "windows");
  assert.equal(profile.maxConcurrentRequests, 2048);
  assert.equal(profile.maxRowsInFlight, 1);
  assert.equal(profile.pathFlavor, "windows");
});

test("caps Esri concurrency below public ArcGIS block thresholds", () => {
  const profile = buildPlatformProfile({
    platform: "win32",
    provider: "esri",
    cpuCount: 12,
    requestedConcurrency: 4096,
    requestedRows: 1,
    env: {},
  });

  assert.equal(profile.maxConcurrentRequests, 64);
  assert.equal(profile.perRowConcurrency, 64);
  assert.equal(profile.wasConcurrencyCapped, true);
});

test("keeps Mapbox platform concurrency uncapped by Esri limits", () => {
  const profile = buildPlatformProfile({
    platform: "win32",
    provider: "mapbox",
    cpuCount: 12,
    requestedConcurrency: 4096,
    requestedRows: 1,
    env: {},
  });

  assert.equal(profile.maxConcurrentRequests, 4096);
  assert.equal(profile.perRowConcurrency, 4096);
});

test("allows generic concurrency override for any provider", () => {
  const profile = buildPlatformProfile({
    platform: "linux",
    provider: "mapbox",
    cpuCount: 16,
    requestedConcurrency: 4096,
    requestedRows: 1,
    env: { TILE_DOWNLOADER_MAX_CONCURRENT_REQUESTS: "192" },
  });

  assert.equal(profile.maxConcurrentRequests, 192);
  assert.equal(profile.perRowConcurrency, 192);
});

test("allows explicit Esri concurrency override from environment", () => {
  const profile = buildPlatformProfile({
    platform: "linux",
    provider: "esri",
    cpuCount: 16,
    requestedConcurrency: 4096,
    requestedRows: 1,
    env: { TILE_DOWNLOADER_ESRI_MAX_CONCURRENCY: "128" },
  });

  assert.equal(profile.maxConcurrentRequests, 128);
  assert.equal(profile.perRowConcurrency, 128);
});
