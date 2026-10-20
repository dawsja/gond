import type { Approval, ApprovalStatus } from "@gond/shared";
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
};

function toApproval(row: Row): Approval {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(row.input) as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
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
  };
}

export function createApproval(input: { botId: string; threadId: string; tool: string; summary: string; input: Record<string, unknown> }): Approval {
  const id = newId("ap");
  ensureDatabase()
    .query("INSERT INTO gond_approvals (id, bot_id, thread_id, tool, summary, input, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
    .run(id, input.botId, input.threadId, input.tool, input.summary, JSON.stringify(input.input), now());
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

export function resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">, rule: string | null = null): Approval | null {
  const db = ensureDatabase();
  const changed = db.query("UPDATE gond_approvals SET status = ?, rule = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(status, rule, now(), id).changes;
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
