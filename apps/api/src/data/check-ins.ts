import { DEFAULT_CHECK_INS, isCheckInHours, type CheckIns } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { now } from "../ids.ts";

type Row = {
  user_id: string;
  enabled: number;
  every_hours: number;
  quiet_from: number;
  quiet_to: number;
  email: number;
  offered_at: string | null;
  last_run_at: string | null;
  last_looked_at: string | null;
  last_seen: string | null;
};

/** A profile's check-ins with when they last ran; a profile with no row has them on, as they come. */
export type CheckInState = CheckIns & { offeredAt: string | null; lastRunAt: string | null; lastLookedAt: string | null; lastSeen: string | null };

function rowOf(userId: string): Row | null {
  return ensureDatabase().query("SELECT * FROM gond_check_ins WHERE user_id = ?").get(userId) as Row | null;
}

export function checkInsOf(userId: string): CheckInState {
  const row = rowOf(userId);
  if (!row) return { ...DEFAULT_CHECK_INS, offeredAt: null, lastRunAt: null, lastLookedAt: null, lastSeen: null };
  return {
    enabled: row.enabled === 1,
    everyHours: isCheckInHours(row.every_hours) ? row.every_hours : DEFAULT_CHECK_INS.everyHours,
    quietFrom: row.quiet_from,
    quietTo: row.quiet_to,
    email: row.email === 1,
    offeredAt: row.offered_at,
    lastRunAt: row.last_run_at,
    lastLookedAt: row.last_looked_at,
    lastSeen: row.last_seen,
  };
}

function ensureRow(userId: string) {
  ensureDatabase().query("INSERT OR IGNORE INTO gond_check_ins (user_id) VALUES (?)").run(userId);
}

export function setCheckIns(userId: string, change: Partial<CheckIns>): CheckIns {
  const next = { ...checkInsOf(userId), ...change };
  ensureRow(userId);
  ensureDatabase()
    .query("UPDATE gond_check_ins SET enabled = ?, every_hours = ?, quiet_from = ?, quiet_to = ?, email = ? WHERE user_id = ?")
    .run(next.enabled ? 1 : 0, next.everyHours, next.quietFrom, next.quietTo, next.email ? 1 : 0, userId);
  const { enabled, everyHours, quietFrom, quietTo, email } = checkInsOf(userId);
  return { enabled, everyHours, quietFrom, quietTo, email };
}

/** Claims the one offer a profile gets; false when it was already made, so two callers can't both post it. */
export function claimOffer(userId: string): boolean {
  ensureRow(userId);
  return ensureDatabase().query("UPDATE gond_check_ins SET offered_at = ? WHERE user_id = ? AND offered_at IS NULL").run(now(), userId).changes === 1;
}

export function markRun(userId: string, looked: { seen: string } | null) {
  ensureRow(userId);
  const at = now();
  if (looked) ensureDatabase().query("UPDATE gond_check_ins SET last_run_at = ?, last_looked_at = ?, last_seen = ? WHERE user_id = ?").run(at, at, looked.seen, userId);
  else ensureDatabase().query("UPDATE gond_check_ins SET last_run_at = ? WHERE user_id = ?").run(at, userId);
}

/** Every profile with a primary bot, the ones check-ins can run for. */
export function primaryOwners(): { userId: string; botId: string }[] {
  return ensureDatabase().query("SELECT user_id AS userId, id AS botId FROM gond_bots WHERE is_primary = 1 AND hidden = 0 AND user_id IS NOT NULL").all() as { userId: string; botId: string }[];
}

/** How many lines the person wrote to a conversation, and how many of those no turn has answered yet. */
export function personLinesIn(threadId: string): { said: number; waiting: number } {
  const row = ensureDatabase()
    .query("SELECT COUNT(*) AS said, COUNT(CASE WHEN answered_at IS NULL THEN 1 END) AS waiting FROM gond_messages WHERE thread_id = ? AND author = 'you' AND kind = 'message' AND spoken = 0")
    .get(threadId) as { said: number; waiting: number };
  return { said: Number(row.said), waiting: Number(row.waiting) };
}

export type PersonLine = { threadId: string; body: string; at: string };

/** What the person said anywhere since a moment, newest first: where a promise of theirs would be. */
export function personLinesSince(userId: string, since: string, limit = 30): PersonLine[] {
  return ensureDatabase()
    .query(
      "SELECT m.thread_id AS threadId, m.body, m.created_at AS at FROM gond_messages m JOIN gond_threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.author = 'you' AND m.kind = 'message' AND m.spoken = 0 AND m.created_at > ? ORDER BY m.created_at DESC LIMIT ?",
    )
    .all(userId, since, limit) as PersonLine[];
}

/** The primary bot's latest check-ins, newest first. */
export function earlierCheckIns(threadId: string, limit = 3): { body: string; at: string }[] {
  return ensureDatabase().query("SELECT body, created_at AS at FROM gond_messages WHERE thread_id = ? AND check_in = 1 ORDER BY created_at DESC LIMIT ?").all(threadId, limit) as { body: string; at: string }[];
}

/** Whether a bot has answered in a conversation at all, a sign its AI works. */
export function botHasAnswered(threadId: string, botId: string): boolean {
  return Boolean(ensureDatabase().query("SELECT 1 FROM gond_messages WHERE thread_id = ? AND author = ? AND kind = 'message' AND check_in = 0 LIMIT 1").get(threadId, botId));
}
