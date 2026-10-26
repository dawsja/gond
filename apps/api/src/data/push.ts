import type { PushSubscriptionInput } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { now } from "../ids.ts";

export type StoredSubscription = PushSubscriptionInput & { userAgent: string; createdAt: string };

type Row = { endpoint: string; p256dh: string; auth: string; user_agent: string; created_at: string };

export function listSubscriptions(userId: string): StoredSubscription[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_push_subscriptions WHERE user_id = ? ORDER BY created_at").all(userId) as Row[];
  return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth }, userAgent: r.user_agent, createdAt: r.created_at }));
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
