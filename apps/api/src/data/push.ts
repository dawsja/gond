import { ALL_NOTICES, type DeviceNotices, type PushSubscriptionInput } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { now } from "../ids.ts";

export type StoredSubscription = PushSubscriptionInput & { userAgent: string; createdAt: string; notices: DeviceNotices };

type Row = { endpoint: string; p256dh: string; auth: string; user_agent: string; created_at: string; muted_bots: string; other: number };

function readMuted(json: string): string[] {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function listSubscriptions(userId: string): StoredSubscription[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_push_subscriptions WHERE user_id = ? ORDER BY created_at").all(userId) as Row[];
  return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth }, userAgent: r.user_agent, createdAt: r.created_at, notices: { mutedBots: readMuted(r.muted_bots), other: r.other !== 0 } }));
}

/** What this subscription of the person's is told about; everything when it isn't theirs or isn't known. */
export function subscriptionNotices(endpoint: string, userId: string): DeviceNotices | null {
  const row = ensureDatabase().query("SELECT muted_bots, other FROM gond_push_subscriptions WHERE endpoint = ? AND user_id = ?").get(endpoint, userId) as Pick<Row, "muted_bots" | "other"> | null;
  return row ? { mutedBots: readMuted(row.muted_bots), other: row.other !== 0 } : null;
}

export function setSubscriptionNotices(endpoint: string, userId: string, notices: DeviceNotices = ALL_NOTICES): boolean {
  return ensureDatabase().query("UPDATE gond_push_subscriptions SET muted_bots = ?, other = ? WHERE endpoint = ? AND user_id = ?").run(JSON.stringify(notices.mutedBots), notices.other ? 1 : 0, endpoint, userId).changes > 0;
}

export function saveSubscription(input: PushSubscriptionInput, userId: string, userAgent = ""): void {
  ensureDatabase()
    .query("INSERT INTO gond_push_subscriptions (endpoint, p256dh, auth, user_agent, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, user_id = excluded.user_id")
    .run(input.endpoint, input.keys.p256dh, input.keys.auth, userAgent.slice(0, 300), userId, now());
}

export function removeSubscription(endpoint: string, userId?: string): boolean {
  const db = ensureDatabase();
  const changes = userId ? db.query("DELETE FROM gond_push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId).changes : db.query("DELETE FROM gond_push_subscriptions WHERE endpoint = ?").run(endpoint).changes;
  return changes > 0;
}

export function countSubscriptions(userId: string): number {
  return Number((ensureDatabase().query("SELECT COUNT(*) AS n FROM gond_push_subscriptions WHERE user_id = ?").get(userId) as { n: number }).n);
}
