import type { Approval, ApprovalOutcome, ApprovalStatus } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { approvalsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { botOwner } from "./bots.ts";
import { threadOwner } from "./threads.ts";

type Row = {
  id: string;
  bot_id: string;
  thread_id: string;
  tool: string;
  summary: string;
  input: string;
  status: ApprovalStatus;
  rule: string | null;
  created_at: string;
  resolved_at: string | null;
  outcome: ApprovalOutcome | null;
  note: string | null;
  edited: number;
  revises: string | null;
};

function parsed<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * How long a paused card can still be answered, from when it was asked: long enough for "tonight" or
 * "first thing tomorrow", short enough that what the bot had found is still roughly true. It also
 * bounds every query for paused cards to the recent end of the (status, created_at) index.
 */
export const LATE_ANSWER_HOURS = 24;

function answerableSince(at = Date.now()): string {
  return new Date(at - LATE_ANSWER_HOURS * 3_600_000).toISOString();
}

function toApproval(row: Row): Approval {
  const input = parsed<Record<string, unknown>>(row.input, {});
  // A paused card asked too long ago reads as plainly expired, whether or not the sweep reached it yet.
  const lapsed = row.outcome === "paused" && row.created_at <= answerableSince();
  return {
    id: row.id,
    botId: row.bot_id,
    threadId: row.thread_id,
    tool: row.tool,
    summary: row.summary,
    input,
    status: row.status,
    rule: row.rule,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    outcome: lapsed ? null : (row.outcome ?? null),
    edited: Boolean(row.edited),
    // While a card waits or is paused, the column holds its turn's work (`CardWork`), which is Gond's own.
    note: row.status === "pending" || row.outcome === "paused" ? null : (row.note ?? null),
    revises: parsed<Approval["revises"]>(row.revises, null),
  };
}

function changedFor(rows: Pick<Row, "thread_id">[]) {
  for (const threadId of new Set(rows.map((row) => row.thread_id))) approvalsChanged(threadOwner(threadId));
}

/**
 * What the turn that posted a card was answering and had done by then. Kept with a card that may be
 * answered late, so the turn that starts again on a late answer is told, even after a restart.
 */
export type CardWork = { answering: string; done: string[] };

/** `work` marks a card that can be paused when nobody answers it in time (`pauseApproval`). */
export function createApproval(input: { botId: string; threadId: string; tool: string; summary: string; input: Record<string, unknown>; revises?: Approval["revises"]; work?: CardWork }): Approval {
  const id = newId("ap");
  ensureDatabase()
    .query("INSERT INTO gond_approvals (id, bot_id, thread_id, tool, summary, input, status, created_at, revises, note) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
    .run(id, input.botId, input.threadId, input.tool, input.summary, JSON.stringify(input.input), now(), input.revises ? JSON.stringify(input.revises) : null, input.work ? JSON.stringify(input.work) : null);
  approvalsChanged(threadOwner(input.threadId));
  return getApproval(id)!;
}

export function cardWork(id: string): CardWork | null {
  const row = ensureDatabase().query("SELECT note FROM gond_approvals WHERE id = ? AND (status = 'pending' OR outcome = 'paused')").get(id) as { note: string | null } | null;
  const work = parsed<Partial<CardWork> | null>(row?.note ?? null, null);
  return work && typeof work.answering === "string" ? { answering: work.answering, done: Array.isArray(work.done) ? work.done.filter((step): step is string => typeof step === "string") : [] } : null;
}

export function pauseApproval(id: string): boolean {
  const rows = ensureDatabase().query("UPDATE gond_approvals SET status = 'expired', outcome = 'paused', resolved_at = ? WHERE id = ? AND status = 'pending' AND note IS NOT NULL RETURNING thread_id").all(now(), id) as Pick<Row, "thread_id">[];
  changedFor(rows);
  return rows.length > 0;
}

export function pausedApprovals(threadId: string): Approval[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_approvals WHERE status = 'expired' AND created_at > ? AND thread_id = ? AND outcome = 'paused' ORDER BY created_at DESC").all(answerableSince(), threadId) as Row[];
  return rows.map(toApproval);
}

export function unpauseApprovals(where: { id?: string; threadId?: string; botId?: string }): Approval[] {
  const clauses = ["status = 'expired'", "created_at > ?", "outcome = 'paused'"];
  const params: string[] = [answerableSince()];
  for (const [clause, value] of [["id = ?", where.id], ["thread_id = ?", where.threadId], ["bot_id = ?", where.botId]] as const) {
    if (!value) continue;
    clauses.push(clause);
    params.push(value);
  }
  const rows = ensureDatabase().query(`UPDATE gond_approvals SET outcome = NULL, note = NULL WHERE ${clauses.join(" AND ")} RETURNING *`).all(...params) as Row[];
  changedFor(rows);
  return rows.map(toApproval);
}

/**
 * Paused cards that went past `LATE_ANSWER_HOURS` in the last day are put to rest, so their notices
 * can come off the phones. Older ones (a Gond that was off for days) already read as expired.
 */
export function lapsePausedApprovals(at = Date.now()): Approval[] {
  const rows = ensureDatabase()
    .query("UPDATE gond_approvals SET outcome = NULL, note = NULL WHERE status = 'expired' AND created_at > ? AND created_at <= ? AND outcome = 'paused' RETURNING *")
    .all(answerableSince(at - 24 * 3_600_000), answerableSince(at)) as Row[];
  changedFor(rows);
  return rows.map(toApproval);
}

export function resolvePaused(id: string, status: "allowed" | "denied", rule: string | null, answer: { outcome?: ApprovalOutcome | null; note?: string | null; input?: Record<string, unknown> } = {}): Approval | null {
  const row = ensureDatabase()
    .query("UPDATE gond_approvals SET status = ?, rule = ?, resolved_at = ?, outcome = ?, note = ?, edited = ?, input = COALESCE(?, input) WHERE id = ? AND status = 'expired' AND outcome = 'paused' AND created_at > ? RETURNING *")
    .get(status, rule, now(), answer.outcome ?? null, answer.note ?? null, answer.input ? 1 : 0, answer.input ? JSON.stringify(answer.input) : null, id, answerableSince()) as Row | null;
  if (!row) return null;
  changedFor([row]);
  return toApproval(row);
}

export function getApproval(id: string): Approval | null {
  const row = ensureDatabase().query("SELECT * FROM gond_approvals WHERE id = ?").get(id) as Row | null;
  return row ? toApproval(row) : null;
}

export function getApprovals(ids: string[], userId?: string): Approval[] {
  if (!ids.length) return [];
  const owned = userId === undefined ? "" : "AND thread_id IN (SELECT id FROM gond_threads WHERE user_id = ?)";
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_approvals WHERE id IN (SELECT value FROM json_each(?)) ${owned}`)
    .all(...(userId === undefined ? [JSON.stringify(ids)] : [JSON.stringify(ids), userId])) as Row[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toApproval(row)] : [];
  });
}

export function listApprovals(options: { status?: ApprovalStatus; threadId?: string; limit?: number } = {}): Approval[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  if (options.threadId) {
    where.push("thread_id = ?");
    params.push(options.threadId);
  }
  params.push(Math.min(options.limit ?? 100, 500));
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_approvals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as Row[];
  return rows.map(toApproval);
}

export function resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">, rule: string | null = null, answer: { outcome?: ApprovalOutcome | null; note?: string | null; input?: Record<string, unknown> } = {}): Approval | null {
  const row = ensureDatabase()
    .query("UPDATE gond_approvals SET status = ?, rule = ?, resolved_at = ?, outcome = ?, note = ?, edited = ?, input = COALESCE(?, input) WHERE id = ? AND status = 'pending' RETURNING *")
    .get(status, rule, now(), answer.outcome ?? null, answer.note ?? null, answer.input ? 1 : 0, answer.input ? JSON.stringify(answer.input) : null, id) as Row | null;
  if (!row) return getApproval(id);
  changedFor([row]);
  return toApproval(row);
}

export function listRules(botId: string): string[] {
  const rows = ensureDatabase().query("SELECT rule FROM gond_approval_rules WHERE bot_id = ? ORDER BY created_at").all(botId) as { rule: string }[];
  return rows.map((r) => r.rule);
}

export function addRule(botId: string, rule: string) {
  ensureDatabase().query("INSERT OR IGNORE INTO gond_approval_rules (id, bot_id, rule, created_at) VALUES (?, ?, ?, ?)").run(newId("rule"), botId, rule, now());
  approvalsChanged(botOwner(botId));
}

/** Forgets a saved rule, and the cards that saved it stop saying "From now on", since it no longer holds. */
export function removeRule(botId: string, rule: string) {
  const db = ensureDatabase();
  db.query("DELETE FROM gond_approval_rules WHERE bot_id = ? AND rule = ?").run(botId, rule);
  db.query("UPDATE gond_approvals SET rule = NULL WHERE bot_id = ? AND rule = ?").run(botId, rule);
  approvalsChanged(botOwner(botId));
}
