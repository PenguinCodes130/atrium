import "server-only";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync } from "node:fs";
import path from "node:path";
import * as schema from "@/db/schema";
import { dataDir } from "./env";

export type Db = BetterSQLite3Database<typeof schema>;

let instance: { sqlite: Database.Database; db: Db } | undefined;

function open() {
  const sqlite = new Database(path.join(dataDir(), "atrium.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = path.resolve(process.cwd(), "src/db/migrations");
  if (existsSync(path.join(migrationsFolder, "meta/_journal.json"))) migrate(db, { migrationsFolder });
  return { sqlite, db };
}

export function db(): Db {
  if (!instance) instance = open();
  return instance.db;
}

// Raw handle for things Drizzle does not cover (for example the rate limiter's upserts).
export function sqlite(): Database.Database {
  if (!instance) instance = open();
  return instance.sqlite;
}

export function transaction<T>(fn: (tx: Db) => T): T {
  return db().transaction((tx) => fn(tx as unknown as Db));
}
