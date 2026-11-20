import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { dataDir, ensureDataDir } from "../config.ts";

const DB_FILE = "gond.db";

export function dbPath() {
  return path.join(dataDir(), DB_FILE);
}

type DbCache = { path: string; db: Database };
const holder = globalThis as typeof globalThis & { __gondSqlite?: DbCache };

/** Release the cached connection before removing a test database or switching its directory. */
export function closeDb() {
  holder.__gondSqlite?.db.close();
  holder.__gondSqlite = undefined;
}

/** Flush the WAL file and optimize query planner stats before closing on graceful shutdown. */
export function checkpointAndCloseDb() {
  const cached = holder.__gondSqlite;
  if (!cached) return;
  try {
    cached.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    cached.db.exec("PRAGMA optimize");
  } catch (error) {
    console.warn(`[gond] couldn't checkpoint database on shutdown: ${error instanceof Error ? error.message : error}`);
  } finally {
    cached.db.close();
    holder.__gondSqlite = undefined;
  }
}

export function getDb(): Database {
  const file = dbPath();
  const cached = holder.__gondSqlite;
  if (cached && cached.path === file) return cached.db;

  ensureDataDir();
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);

  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  holder.__gondSqlite = { path: file, db };
  return db;
}

