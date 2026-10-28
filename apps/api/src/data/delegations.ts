import { ensureDatabase } from "../db/init.ts";
import { newId, now } from "../ids.ts";

export type Delegation = {
  id: string;
  fromBotId: string;
  fromThreadId: string;
  toBotId: string;
  toThreadId: string;
  messageId: string;
  brief: string;

  status: "open" | "done" | "failed" | "cancelled";
  result: string | null;
  createdAt: string;
  finishedAt: string | null;

  nudgedAt: string | null;
  escalatedAt: string | null;

  parentId: string | null;

  resultMessageId: string | null;
};

type Row = {
  id: string;
  from_bot_id: string;
  from_thread_id: string;
  to_bot_id: string;
  to_thread_id: string;
  message_id: string;
  brief: string;
  status: Delegation["status"];
  result: string | null;
  created_at: string;
  finished_at: string | null;
  nudged_at: string | null;
  escalated_at: string | null;
  parent_id: string | null;
  result_message_id: string | null;
};

function toDelegation(row: Row): Delegation {
  return {
    id: row.id,
    fromBotId: row.from_bot_id,
    fromThreadId: row.from_thread_id,
    toBotId: row.to_bot_id,
    toThreadId: row.to_thread_id,
    messageId: row.message_id,
    brief: row.brief,
    status: row.status,
    result: row.result,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    nudgedAt: row.nudged_at,
    escalatedAt: row.escalated_at,
    parentId: row.parent_id,
    resultMessageId: row.result_message_id,
  };
}

export function createDelegation(
  input: Omit<Delegation, "id" | "status" | "result" | "createdAt" | "finishedAt" | "nudgedAt" | "escalatedAt" | "parentId" | "resultMessageId"> & { parentId?: string | null },
): Delegation {
  const id = newId("d");
  ensureDatabase()
    .query("INSERT INTO gond_delegations (id, from_bot_id, from_thread_id, to_bot_id, to_thread_id, message_id, brief, status, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
    .run(id, input.fromBotId, input.fromThreadId, input.toBotId, input.toThreadId, input.messageId, input.brief, now(), input.parentId ?? null);
  return getDelegation(id)!;
}

export function getDelegation(id: string): Delegation | null {
  const row = ensureDatabase().query("SELECT * FROM gond_delegations WHERE id = ?").get(id) as Row | null;
  return row ? toDelegation(row) : null;
}

function delegationForMessage(messageId: string): Delegation | null {
  const row = ensureDatabase().query("SELECT * FROM gond_delegations WHERE message_id = ? AND status = 'open'").get(messageId) as Row | null;
  return row ? toDelegation(row) : null;
}

export function handoffWorkedOn(messageId: string): Delegation | null {
  const brief = delegationForMessage(messageId);
  if (brief) return brief;
  const row = ensureDatabase()
    .query("SELECT p.* FROM gond_delegations c JOIN gond_delegations p ON p.id = c.parent_id WHERE c.result_message_id = ? AND p.status = 'open'")
    .get(messageId) as Row | null;
  return row ? toDelegation(row) : null;
}

export function isDelegationResult(messageId: string): boolean {
  return Boolean(ensureDatabase().query("SELECT 1 FROM gond_delegations WHERE result_message_id = ?").get(messageId));
}

export function openChildren(id: string): number {
  return (ensureDatabase().query("SELECT COUNT(*) AS n FROM gond_delegations WHERE parent_id = ? AND status = 'open'").get(id) as { n: number }).n;
}

export function finishDelegation(id: string, status: "done" | "failed" | "cancelled", result: string, resultMessageId: string | null = null) {
  ensureDatabase()
    .query("UPDATE gond_delegations SET status = ?, result = ?, finished_at = ?, result_message_id = ? WHERE id = ?")
    .run(status, result.slice(0, 20_000), now(), resultMessageId, id);
}

export function openDelegationsTo(threadId: string): Delegation[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_delegations WHERE status = 'open' AND to_thread_id = ? ORDER BY created_at").all(threadId) as Row[];
  return rows.map(toDelegation);
}

export function listOpenDelegations(fromBotId?: string): Delegation[] {
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_delegations WHERE status = 'open' ${fromBotId ? "AND from_bot_id = ?" : ""} ORDER BY created_at`)
    .all(...(fromBotId ? [fromBotId] : [])) as Row[];
  return rows.map(toDelegation);
}

export function openDelegationsFrom(threadId: string, since: string | null = null): Delegation[] {
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_delegations WHERE status = 'open' AND from_thread_id = ? ${since ? "AND created_at >= ?" : ""} ORDER BY created_at`)
    .all(...(since ? [threadId, since] : [threadId])) as Row[];
  return rows.map(toDelegation);
}

export function markNudged(id: string) {
  ensureDatabase().query("UPDATE gond_delegations SET nudged_at = ? WHERE id = ?").run(now(), id);
}

export function markEscalated(id: string) {
  ensureDatabase().query("UPDATE gond_delegations SET escalated_at = ? WHERE id = ?").run(now(), id);
}

export function listDelegationsForBot(botId: string, since: string, limit = 40): Delegation[] {
  const rows = ensureDatabase()
    .query(
      `SELECT * FROM gond_delegations WHERE (from_bot_id = ? OR to_bot_id = ?) AND (status = 'open' OR finished_at >= ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(botId, botId, since, limit) as Row[];
  return rows.map(toDelegation);
}

