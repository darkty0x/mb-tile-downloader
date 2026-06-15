import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pool = null;

async function loadPg() {
  const pg = await import("pg");
  return pg.Pool;
}

export async function createPgDb({ databaseUrl = process.env.DATABASE_URL } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const Pool = await loadPg();
  pool = new Pool({ connectionString: databaseUrl });
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");
  await pool.query(await readFile(schemaPath, "utf8"));
  return {
    query(sql, params = []) {
      return pool.query(sql, params);
    },
    async close() {
      await pool.end();
    },
  };
}
