import { ensureDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { now } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

export function readComposioKey(userId: string): string | null {
  const row = ensureDatabase().query("SELECT api_key FROM gond_composio_keys WHERE user_id = ?").get(userId) as { api_key: string } | null;
  if (!row) return null;
  try {
    return decryptSecret(row.api_key);
  } catch {
    return null;
  }
}

export function hasComposioKey(userId: string): boolean {
  return Boolean(ensureDatabase().query("SELECT 1 FROM gond_composio_keys WHERE user_id = ?").get(userId));
}

export function setComposioKey(userId: string, apiKey: string): void {
  const key = apiKey.trim();
  if (!key || key.length > 500 || /\s/.test(key)) throw new Error("That doesn't look like a Composio API key");
  ensureDatabase()
    .query("INSERT INTO gond_composio_keys (user_id, api_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at")
    .run(userId, encryptSecret(key), now());
  settingsChanged();
}

export function clearComposioKey(userId: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_composio_keys WHERE user_id = ?").run(userId).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

export function allComposioKeys(): string[] {
  const rows = ensureDatabase().query("SELECT api_key FROM gond_composio_keys").all() as { api_key: string }[];
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(decryptSecret(row.api_key));
    } catch {
      /* an unreadable key can't leak either */
    }
  }
  return out;
}
