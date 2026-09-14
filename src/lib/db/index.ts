import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

type DB = BetterSQLite3Database<typeof schema>;
const DB_PATH = process.env.WARDEN_DB_PATH ?? join(process.cwd(), "var", "warden.db");

function init(): DB {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  const database = drizzle(sqlite, { schema });
  try {
    migrate(database, { migrationsFolder: join(process.cwd(), "drizzle") });
  } catch (err) {
    console.error("[db] migration failed:", err);
  }
  return database;
}

const g = globalThis as unknown as { __wardenDb?: DB };
export const db: DB = g.__wardenDb ?? (g.__wardenDb = init());
export { schema };
