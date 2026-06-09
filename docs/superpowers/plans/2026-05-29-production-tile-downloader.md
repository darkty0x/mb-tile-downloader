# Production Tile Downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated tile downloaders with one production-ready, cross-platform downloader that resumes efficiently, rotates Mapbox tokens correctly, and keeps memory bounded.

**Architecture:** A single CLI loads a provider-specific config, computes a platform profile, schedules row-level work, streams tile downloads to disk, and records durable row/token state in SQLite. Provider modules own URL building and HTTP response classification. Verification trusts SQLite only when the config hash matches and row completion was proven against the filesystem.

**Tech Stack:** Node.js ESM, built-in `node:test`, `better-sqlite3`, `undici` global dispatcher, filesystem streaming, SQLite state.

---

### Task 1: Tests First

**Files:**
- Create: `tests/config.test.js`
- Create: `tests/platform-profile.test.js`
- Create: `tests/mapbox-token-pool.test.js`
- Create: `tests/state-db.test.js`

- [ ] Test config normalization, required provider fields, and config hashing.
- [ ] Test OS-specific concurrency caps for macOS, Linux, and Windows.
- [ ] Test Mapbox token rotation on auth/quota failure and fatal behavior when all tokens are exhausted.
- [ ] Test row state persistence and complete-row skipping when the config hash matches.

### Task 2: Runtime And Config Modules

**Files:**
- Create: `src/runtime/platform-profile.js`
- Create: `src/config/config-loader.js`

- [ ] Implement platform detection without Linux-only guards.
- [ ] Implement safe platform caps and log when user-requested concurrency is capped.
- [ ] Implement config loading with provider defaults and minimal validated fields.
- [ ] Implement deterministic config hash from effective provider/ranges/output settings.

### Task 3: State And Token Modules

**Files:**
- Create: `src/state/state-db.js`
- Create: `src/auth/mapbox-token-pool.js`

- [ ] Implement SQLite schema for jobs, rows, and Mapbox tokens.
- [ ] Implement row upsert, complete marking, partial marking, and skip checks.
- [ ] Implement Mapbox token loading from `MAPBOX_ACCESS_TOKENS` and numbered env vars.
- [ ] Mark exhausted/invalid tokens and throw immediately when all tokens are unusable.

### Task 4: Provider Modules

**Files:**
- Create: `src/providers/mapbox.js`
- Create: `src/providers/esri.js`

- [ ] Mapbox supports vector PBF, satellite raster, DEM raster, arbitrary tilesets/templates, hosts, and token interpolation.
- [ ] Esri supports URL template rendering, TMS/XYZ y schemes, unavailable placeholder hashes, and raster output extension.
- [ ] Providers classify `downloaded`, `missing`, `retry`, `token-exhausted`, `token-invalid`, and `fatal`.

### Task 5: Unified Engine And CLI

**Files:**
- Create: `src/engine/downloader-engine.js`
- Replace: `downloader.js`

- [ ] Stream responses to `.tmp` files and atomically rename.
- [ ] Schedule by row with bounded request and row concurrency.
- [ ] Resume from SQLite row states and scan only partial rows.
- [ ] Verify rows before marking complete.
- [ ] Stop immediately when all Mapbox tokens are exhausted.
- [ ] Add `--validate`, `--dry-run`, `--force-verify`, `--state-db`, and config path support.

### Task 6: Config And Script Cleanup

**Files:**
- Create: `configs/mapbox-pbf.config.json`
- Create: `configs/esri-satellite.config.json`
- Create: `configs/mapbox-satellite.config.json`
- Create: `configs/mapbox-dem.config.json`
- Replace: `package.json`
- Replace: `range-archiver.js` with `zip-maker.js`
- Keep: `directory-maker.js`
- Delete obsolete duplicated runtime files after replacement.

- [ ] Keep config files separate by provider/job.
- [ ] Keep runtime scripts cross-platform.
- [ ] Remove duplicated `downloader-mac.js`, `esri-downloader.js`, `download-runner.js`, and `ubuntu-runtime.js`.

### Task 7: Verification

- [ ] Run `npm test`.
- [ ] Run `node downloader.js --dry-run configs/mapbox-pbf.config.json`.
- [ ] Run `node downloader.js --dry-run configs/esri-satellite.config.json`.
- [ ] Run `node zip-maker.js --help`.
- [ ] Run `node directory-maker.js --help` or a small safe temp-directory smoke test.
