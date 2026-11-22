import type { Approval, Message } from "@gond/shared";
import { keep } from "@/lib/keep";

/** At most this many approvals are asked for in one request (`GET /api/approvals?ids=`). */
export const APPROVALS_PER_REQUEST = 100;

export function mergeMessages(current: Message[], page: readonly Message[]): Message[] {
  if (!page.length) return current;
  const seen = new Set(current.map((m) => m.id));
  const fresh = page.filter((m) => !seen.has(m.id) && seen.add(m.id));
  if (!fresh.length) return current;
  // Both lists are in time order, so one pass merges them; among equal times what was shown stays first.
  const out: Message[] = [];
  let i = 0;
  let j = 0;
  while (i < current.length && j < fresh.length) out.push(fresh[j]!.createdAt < current[i]!.createdAt ? fresh[j++]! : current[i++]!);
  while (i < current.length) out.push(current[i++]!);
  while (j < fresh.length) out.push(fresh[j++]!);
  return out;
}

/**
 * Where the next catch-up starts: the newest time a page from the server reached. A line added
 * here (a send) never moves it, or a bot's line written just before it would be skipped.
 */
export function newestOf(cursor: string | null, page: readonly Message[]): string | null {
  const last = page.at(-1)?.createdAt ?? null;
  return last && (!cursor || last > cursor) ? last : cursor;
}

export function hasEarlier(page: readonly Message[], limit: number): boolean {
  return page.length >= limit;
}

export function approvalBatches(messages: readonly Message[], asked: ReadonlySet<string>, size = APPROVALS_PER_REQUEST): string[][] {
  const ids = [...new Set(messages.flatMap((m) => (m.kind === "approval" && m.approvalId && !asked.has(m.approvalId) ? [m.approvalId] : [])))];
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += size) batches.push(ids.slice(at, at + size));
  return batches;
}

export function putApprovals(current: ReadonlyMap<string, Approval | null>, approvals: readonly Approval[]): ReadonlyMap<string, Approval | null> {
  let next: Map<string, Approval | null> | null = null;
  for (const approval of approvals) {
    const before = current.get(approval.id);
    const kept = before ? keep(before, approval) : approval;
    if (kept === before) continue;
    next ??= new Map(current);
    next.set(approval.id, kept);
  }
  return next ?? current;
}

export function markGone(current: ReadonlyMap<string, Approval | null>, ids: readonly string[]): ReadonlyMap<string, Approval | null> {
  const fresh = ids.filter((id) => !current.has(id));
  if (!fresh.length) return current;
  const next = new Map(current);
  for (const id of fresh) next.set(id, null);
  return next;
}
