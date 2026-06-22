import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("postgres schema migrates machine job updated timestamps", async () => {
  const schema = await readFile(new URL("../dashboard/src/server/schema.sql", import.meta.url), "utf8");
  const machineJobsTable = /CREATE TABLE IF NOT EXISTS machine_jobs \(([\s\S]*?)\);/.exec(schema)?.[1] || "";

  assert.match(machineJobsTable, /updated_at\s+timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/);
  assert.match(schema, /ALTER TABLE machine_jobs\s+ADD COLUMN IF NOT EXISTS updated_at\s+timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/);
});
