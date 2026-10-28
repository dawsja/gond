import { ensureDatabase } from "../db/init.ts";
import { newId, now } from "../ids.ts";

type FollowUp = { id: string; botId: string; threadId: string; note: string; dueAt: string; createdAt: string; firedAt: string | null };

type Row = { id: string; bot_id: string; thread_id: string; note: string; due_at: string; created_at: string; fired_at: string | null };

function toFollowUp(row: Row): FollowUp {
  return { id: row.id, botId: row.bot_id, threadId: row.thread_id, note: row.note, dueAt: row.due_at, createdAt: row.created_at, firedAt: row.fired_at };
}

export function createFollowUp(input: { botId: string; threadId: string; note: string; dueAt: Date }): FollowUp {
  const id = newId("f");
  ensureDatabase()
    .query("INSERT INTO gond_follow_ups (id, bot_id, thread_id, note, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, input.botId, input.threadId, input.note, input.dueAt.toISOString(), now());
  return listFollowUps(input.botId).find((f) => f.id === id)!;
}

export function listFollowUps(botId: string): FollowUp[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_follow_ups WHERE bot_id = ? AND fired_at IS NULL ORDER BY due_at ASC").all(botId) as Row[];
  return rows.map(toFollowUp);
}

export function cancelFollowUp(id: string, botId: string): boolean {
  return ensureDatabase().query("DELETE FROM gond_follow_ups WHERE id = ? AND bot_id = ? AND fired_at IS NULL").run(id, botId).changes > 0;
}

export function cancelFollowUpsIn(threadId: string, since: string | null = null): number {
  return ensureDatabase()
    .query(`DELETE FROM gond_follow_ups WHERE thread_id = ? AND fired_at IS NULL ${since ? "AND created_at >= ?" : ""}`)
    .run(...(since ? [threadId, since] : [threadId])).changes;
}

export function claimDueFollowUps(at = new Date()): FollowUp[] {
  const db = ensureDatabase();
  const stamp = at.toISOString();
  const rows = db.query("SELECT * FROM gond_follow_ups WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at ASC").all(stamp) as Row[];
  for (const row of rows) db.query("UPDATE gond_follow_ups SET fired_at = ? WHERE id = ?").run(stamp, row.id);
  return rows.map((row) => toFollowUp({ ...row, fired_at: stamp }));
}
