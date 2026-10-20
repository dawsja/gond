import type { Message } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { now } from "../ids.ts";
import { getMessage } from "./threads.ts";

export type ThreadSummary = { summary: string; through: string; updatedAt: string };

const TRANSCRIPT_KINDS = "kind IN ('message', 'approval', 'signin')";

export function getSummary(threadId: string): ThreadSummary | null {
  const row = ensureDatabase().query("SELECT summary, through, updated_at FROM gond_thread_summaries WHERE thread_id = ?").get(threadId) as { summary: string; through: string; updated_at: string } | null;
  return row ? { summary: row.summary, through: row.through, updatedAt: row.updated_at } : null;
}

export function setSummary(threadId: string, summary: string, through: string) {
  ensureDatabase()
    .query("INSERT INTO gond_thread_summaries (thread_id, summary, through, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET summary = excluded.summary, through = excluded.through, updated_at = excluded.updated_at")
    .run(threadId, summary, through, now());
}

/**
 * The messages that have dropped out of the last `window` a prompt carries
 * and aren't in the summary yet, oldest first.
 */
export function unsummarized(threadId: string, window: number, through: string | null): Message[] {
  // By position, not by the window's first timestamp: messages can share a millisecond.
  const rows = ensureDatabase()
    .query(`SELECT id FROM gond_messages WHERE thread_id = ? AND ${TRANSCRIPT_KINDS} AND created_at > ? ORDER BY created_at ASC, rowid ASC`)
    .all(threadId, through ?? "") as { id: string }[];
  return rows
    .slice(0, Math.max(0, rows.length - window))
    .map((row) => getMessage(row.id))
    .filter((message): message is Message => message !== null);
}
