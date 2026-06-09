import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

export class TileStateDb {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 30000");
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_name TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS rows (
        job_name TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        layer TEXT NOT NULL,
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y_start INTEGER NOT NULL,
        y_end INTEGER NOT NULL,
        expected INTEGER NOT NULL,
        downloaded INTEGER NOT NULL DEFAULT 0,
        missing INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        verified_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (job_name, config_hash, layer, z, x, y_start, y_end)
      );

      CREATE TABLE IF NOT EXISTS ranges (
        job_name TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        layer TEXT NOT NULL,
        range_index INTEGER NOT NULL,
        label TEXT,
        expected INTEGER NOT NULL,
        present INTEGER NOT NULL DEFAULT 0,
        missing INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        verified_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (job_name, config_hash, layer, range_index)
      );

      CREATE TABLE IF NOT EXISTS mapbox_tokens (
        token TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  upsertJob({ jobName, provider, configHash }) {
    this.db
      .prepare(
        `INSERT INTO jobs (job_name, provider, config_hash, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(job_name) DO UPDATE SET
           provider=excluded.provider,
           config_hash=excluded.config_hash,
           updated_at=CURRENT_TIMESTAMP`
      )
      .run(jobName, provider, configHash);
  }

  rowKey({ jobName, configHash, layer, z, x, yStart, yEnd }) {
    return { jobName, configHash, layer, z, x, yStart, yEnd };
  }

  getRow(key) {
    return this.db
      .prepare(
        `SELECT * FROM rows
         WHERE job_name=? AND config_hash=? AND layer=? AND z=? AND x=? AND y_start=? AND y_end=?`
      )
      .get(
        key.jobName,
        key.configHash,
        key.layer,
        key.z,
        key.x,
        key.yStart,
        key.yEnd
      );
  }

  shouldSkipRow(key) {
    const row = this.getRow(key);
    return Boolean(row && row.status === "complete" && row.failed === 0);
  }

  shouldSkipRange({ jobName, configHash, layer, rangeIndex }) {
    const row = this.db
      .prepare(
        `SELECT status, missing FROM ranges
         WHERE job_name=? AND config_hash=? AND layer=? AND range_index=?`
      )
      .get(jobName, configHash, layer, rangeIndex);
    return Boolean(row && row.status === "verified" && row.missing === 0);
  }

  markRangeVerified(range) {
    this.db
      .prepare(
        `INSERT INTO ranges (
           job_name, config_hash, layer, range_index, label,
           expected, present, missing, status, verified_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(job_name, config_hash, layer, range_index)
         DO UPDATE SET
           label=excluded.label,
           expected=excluded.expected,
           present=excluded.present,
           missing=excluded.missing,
           status=excluded.status,
           verified_at=excluded.verified_at,
           updated_at=CURRENT_TIMESTAMP`
      )
      .run(
        range.jobName,
        range.configHash,
        range.layer,
        range.rangeIndex,
        range.label,
        range.expected,
        range.present,
        range.missing,
        range.missing === 0 ? "verified" : "partial",
        range.missing === 0 ? new Date().toISOString() : null
      );
  }

  markArchivedTiles(range) {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ranges (
             job_name, config_hash, layer, range_index, label,
             expected, present, missing, status, verified_at, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'archived', NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(job_name, config_hash, layer, range_index)
           DO UPDATE SET
             status='archived',
             present=0,
             missing=excluded.missing,
             verified_at=NULL,
             updated_at=CURRENT_TIMESTAMP`
        )
        .run(
          range.jobName,
          range.configHash,
          range.layer,
          range.rangeIndex,
          range.label,
          range.expected,
          range.expected
        );

      this.db
        .prepare(
          `UPDATE rows
           SET status='archived',
               failed=expected,
               verified_at=NULL,
               updated_at=CURRENT_TIMESTAMP
           WHERE job_name=?
             AND config_hash=?
             AND layer=?
             AND z=?
             AND x BETWEEN ? AND ?
             AND y_start=?
             AND y_end=?`
        )
        .run(
          range.jobName,
          range.configHash,
          range.layer,
          range.z,
          range.xStart,
          range.xEnd,
          range.yStart,
          range.yEnd
        );
    });
    tx();
  }

  markRowComplete(row) {
    this.#upsertRow({ ...row, status: "complete", verifiedAt: new Date().toISOString() });
  }

  markRowPartial(row) {
    this.#upsertRow({ ...row, status: "partial", verifiedAt: null });
  }

  markRowFailed(row) {
    this.#upsertRow({ ...row, status: "failed", verifiedAt: null });
  }

  #upsertRow(row) {
    this.db
      .prepare(
        `INSERT INTO rows (
           job_name, config_hash, layer, z, x, y_start, y_end,
           expected, downloaded, missing, failed, status, verified_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(job_name, config_hash, layer, z, x, y_start, y_end)
         DO UPDATE SET
           expected=excluded.expected,
           downloaded=excluded.downloaded,
           missing=excluded.missing,
           failed=excluded.failed,
           status=excluded.status,
           verified_at=excluded.verified_at,
           updated_at=CURRENT_TIMESTAMP`
      )
      .run(
        row.jobName,
        row.configHash,
        row.layer,
        row.z,
        row.x,
        row.yStart,
        row.yEnd,
        row.expected,
        row.downloaded,
        row.missing,
        row.failed,
        row.status,
        row.verifiedAt
      );
  }

  loadMapboxTokenState(tokens) {
    if (!tokens.length) return [];
    const stmt = this.db.prepare(
      `SELECT token, status, reason FROM mapbox_tokens WHERE token = ?`
    );
    return tokens.map((token) => stmt.get(token)).filter(Boolean);
  }

  saveMapboxTokenState(snapshot) {
    const stmt = this.db.prepare(
      `INSERT INTO mapbox_tokens (token, status, reason, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(token) DO UPDATE SET
         status=excluded.status,
         reason=excluded.reason,
         updated_at=CURRENT_TIMESTAMP`
    );
    const tx = this.db.transaction((tokens) => {
      for (const record of tokens) {
        stmt.run(record.token, record.status, record.reason);
      }
    });
    tx(snapshot.tokens);
  }

  clearMapboxTokenState() {
    this.db.prepare("DELETE FROM mapbox_tokens").run();
  }

  close() {
    this.db.close();
  }
}
