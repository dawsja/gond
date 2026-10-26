import type { Approval, ApprovalOutcome, ApprovalStatus } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { approvalsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";

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

function toApproval(row: Row): Approval {
  const input = parsed<Record<string, unknown>>(row.input, {});
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
    outcome: row.outcome ?? null,
    edited: Boolean(row.edited),
    note: row.note ?? null,
    revises: parsed<Approval["revises"]>(row.revises, null),
  };
}

export function createApproval(input: { botId: string; threadId: string; tool: string; summary: string; input: Record<string, unknown>; revises?: Approval["revises"] }): Approval {
  const id = newId("ap");
  ensureDatabase()
    .query("INSERT INTO gond_approvals (id, bot_id, thread_id, tool, summary, input, status, created_at, revises) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
    .run(id, input.botId, input.threadId, input.tool, input.summary, JSON.stringify(input.input), now(), input.revises ? JSON.stringify(input.revises) : null);
  approvalsChanged();
  return getApproval(id)!;
}

export function getApproval(id: string): Approval | null {
  const row = ensureDatabase().query("SELECT * FROM gond_approvals WHERE id = ?").get(id) as Row | null;
  return row ? toApproval(row) : null;
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
  const db = ensureDatabase();
  const changed = db
    .query("UPDATE gond_approvals SET status = ?, rule = ?, resolved_at = ?, outcome = ?, note = ?, edited = ?, input = COALESCE(?, input) WHERE id = ? AND status = 'pending'")
    .run(status, rule, now(), answer.outcome ?? null, answer.note ?? null, answer.input ? 1 : 0, answer.input ? JSON.stringify(answer.input) : null, id).changes;
  if (changed) approvalsChanged();
  return getApproval(id);
}

export function listRules(botId: string): string[] {
  const rows = ensureDatabase().query("SELECT rule FROM gond_approval_rules WHERE bot_id = ? ORDER BY created_at").all(botId) as { rule: string }[];
  return rows.map((r) => r.rule);
}

export function addRule(botId: string, rule: string) {
  ensureDatabase().query("INSERT OR IGNORE INTO gond_approval_rules (id, bot_id, rule, created_at) VALUES (?, ?, ?, ?)").run(newId("rule"), botId, rule, now());
  approvalsChanged();
}

export function removeRule(botId: string, rule: string) {
  ensureDatabase().query("DELETE FROM gond_approval_rules WHERE bot_id = ? AND rule = ?").run(botId, rule);
  approvalsChanged();
}
