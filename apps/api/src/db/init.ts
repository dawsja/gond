import type { Database } from "bun:sqlite";
import { reencryptOidcSecret } from "../data/oidc.ts";
import { now } from "../ids.ts";
import { encryptSecret, decryptSecret, SecretKeyError } from "../secrets.ts";
import { noteInterrupted } from "../resume.ts";
import { runMigrations } from "./migrations.ts";
import { dbPath, getDb } from "./sqlite.ts";

const holder = globalThis as typeof globalThis & { __gondDbReady?: string };

/**
 * At start nothing is running: the messages a turn had claimed go back to wait (marked as cut off, so
 * their next turn checks before redoing anything), and every card still open expires, since no turn
 * waits on it any more and it would otherwise hold its bot up for good.
 */
export function releaseClaims(db: Database): number {
  // A line still waiting on the router was never started, so it isn't cut off; released, it routes by the rules.
  const cut = db.query("SELECT id FROM gond_messages WHERE claimed_by IS NOT NULL AND claimed_by != 'routing' AND answered_at IS NULL").all() as { id: string }[];
  for (const { id } of cut) noteInterrupted(id);
  db.query("UPDATE gond_messages SET claimed_by = NULL WHERE claimed_by IS NOT NULL").run();
  const at = now();
  const cards =
    db.query("UPDATE gond_approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'").run(at).changes +
    db.query("UPDATE gond_secret_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending'").run(at).changes;
  // An export's job lived in memory too; the person starts it again.
  db.query("UPDATE gond_exports SET status = 'failed', error = ?, finished_at = ? WHERE status = 'preparing'").run("Gond restarted while it was being prepared. Start it again.", at);
  if (cut.length || cards) console.info(`[gond] Picking up after a restart: ${cut.length} message(s) to answer again, ${cards} open card(s) expired`);
  return cards;
}

const ENCRYPTED_COLUMNS = [
  ["gond_secrets", "value"],
  ["gond_providers", "api_key"],
  ["gond_mcp_servers", "oauth"],
  ["gond_composio_keys", "api_key"],
] as const;

export function rotateLegacySecrets(db: Database) {
  try {
    db.transaction(() => {
      for (const [table, column] of ENCRYPTED_COLUMNS) {
        const rows = db.query(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} LIKE 'v1.%'`).all() as { rid: number; value: string }[];
        for (const row of rows) {
          db.query(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(encryptSecret(decryptSecret(row.value)), row.rid);
        }
      }
      const settings = db.query("SELECT oidc FROM gond_settings WHERE id = 1").get() as { oidc: string | null } | null;
      const rotated = reencryptOidcSecret(settings?.oidc ?? null);
      if (rotated !== null) db.query("UPDATE gond_settings SET oidc = ? WHERE id = 1").run(rotated);
    }).immediate();
  } catch (error) {
    if (!(error instanceof SecretKeyError)) throw error;
    console.warn(`[gond] Stored secrets from before the rename were left as they are: ${error.message}`);
  }
}


export function ensureDatabase(): Database {
  const db = getDb();
  const key = dbPath();
  if (holder.__gondDbReady === key) return db;
  runMigrations(db);
  db.query("INSERT OR IGNORE INTO gond_settings (id, updated_at) VALUES (1, ?)").run(now());
  rotateLegacySecrets(db);
  releaseClaims(db);
  holder.__gondDbReady = key;
  return db;
}

export function transaction<T>(fn: (db: Database) => T): T {
  const db = ensureDatabase();
  return db.transaction(() => fn(db)).immediate();
}

export function resetDbReady() {
  holder.__gondDbReady = undefined;
}
