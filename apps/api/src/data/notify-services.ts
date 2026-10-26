import { isNotifyServiceKind, NOTIFY_SERVICES, type NotifyService, type NotifyServiceKind } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { now } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

type Row = { user_id: string; kind: string; settings: string; secrets: string; enabled: number; last_sent_at: string | null; last_error: string | null; created_at: string; updated_at: string };

/** A service with its secrets opened, for sending and nothing else. */
export type StoredService = { kind: NotifyServiceKind; enabled: boolean; settings: Record<string, string>; secrets: Record<string, string> };

function row(userId: string): Row | null {
  return ensureDatabase().query("SELECT * FROM gond_notify_services WHERE user_id = ?").get(userId) as Row | null;
}

function parse(text: string): Record<string, string> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  } catch {
    return {};
  }
}

export function getNotifyService(userId: string): NotifyService | null {
  const r = row(userId);
  if (!r || !isNotifyServiceKind(r.kind)) return null;
  const secrets = storedSecrets(userId) ?? {};
  return {
    kind: r.kind,
    enabled: r.enabled === 1,
    details: parse(r.settings),
    saved: NOTIFY_SERVICES[r.kind].fields.filter((f) => f.secret && secrets[f.key]).map((f) => f.key),
    lastSentAt: r.last_sent_at,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  };
}

/** The person's service with its keys decrypted, to send with. Never returned by a route. */
export function readNotifyService(userId: string): StoredService | null {
  const r = row(userId);
  if (!r || !isNotifyServiceKind(r.kind)) return null;
  return { kind: r.kind, enabled: r.enabled === 1, settings: parse(r.settings), secrets: storedSecrets(userId) ?? {} };
}

function storedSecrets(userId: string): Record<string, string> | null {
  const r = row(userId);
  if (!r) return null;
  try {
    return parse(decryptSecret(r.secrets));
  } catch {
    return {};
  }
}

/** Replaces the person's one service: a new kind forgets the old one, keys and all. */
export function saveNotifyService(userId: string, kind: NotifyServiceKind, settings: Record<string, string>, secrets: Record<string, string>, enabled = true): void {
  const at = now();
  ensureDatabase()
    .query(
      `INSERT INTO gond_notify_services (user_id, kind, settings, secrets, enabled, last_sent_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, settings = excluded.settings, secrets = excluded.secrets, enabled = excluded.enabled, last_error = NULL, updated_at = excluded.updated_at`,
    )
    .run(userId, kind, JSON.stringify(settings), encryptSecret(JSON.stringify(secrets)), enabled ? 1 : 0, at, at);
}

export function setNotifyServiceEnabled(userId: string, enabled: boolean): boolean {
  return ensureDatabase().query("UPDATE gond_notify_services SET enabled = ?, updated_at = ? WHERE user_id = ?").run(enabled ? 1 : 0, now(), userId).changes > 0;
}

export function deleteNotifyService(userId: string): boolean {
  return ensureDatabase().query("DELETE FROM gond_notify_services WHERE user_id = ?").run(userId).changes > 0;
}

/** How the last send went, so Settings can say "Last sent 5 minutes ago" or what went wrong. */
export function recordNotifyResult(userId: string, error: string | null): void {
  if (error) ensureDatabase().query("UPDATE gond_notify_services SET last_error = ? WHERE user_id = ?").run(error.slice(0, 300), userId);
  else ensureDatabase().query("UPDATE gond_notify_services SET last_sent_at = ?, last_error = NULL WHERE user_id = ?").run(now(), userId);
}
