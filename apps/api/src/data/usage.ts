import type { PlanWindow, UsageRange, UsageSource } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** One model's share of a turn: its tokens, and what the provider says it billed, when it says. */
export type ModelUsage = { model: string; tokens: Tokens; cost: number | null };

export type StepUsage = Omit<ModelUsage, "model">;

export function tokenTotal(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

export function recordUsage(entry: { userId: string; botId: string | null; threadId: string | null; source: UsageSource } & ModelUsage): void {
  const tokens = { input: whole(entry.tokens.input), output: whole(entry.tokens.output), cacheRead: whole(entry.tokens.cacheRead), cacheWrite: whole(entry.tokens.cacheWrite) };
  const cost = entry.cost !== null && Number.isFinite(entry.cost) && entry.cost >= 0 ? entry.cost : null;
  if (!tokenTotal(tokens) && !cost) return;
  ensureDatabase()
    .query("INSERT INTO gond_usage (user_id, bot_id, thread_id, source, model, input, output, cache_read, cache_write, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(entry.userId, entry.botId, entry.threadId, entry.source, entry.model.slice(0, 200), tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, cost, now());
  emit({ topic: "usage", userId: entry.userId });
}

const TOKENS_SQL = "COALESCE(SUM(input + output + cache_read + cache_write), 0)";

export function sourceTotals(userId: string, source: UsageSource, since: Date): { tokens: number; cost: number | null } {
  const row = ensureDatabase()
    .query(`SELECT ${TOKENS_SQL} AS tokens, SUM(cost) AS cost FROM gond_usage WHERE user_id = ? AND source = ? AND created_at >= ?`)
    .get(userId, source, since.toISOString()) as { tokens: number; cost: number | null };
  return { tokens: row.tokens, cost: row.cost };
}

export function botTotals(userId: string, since: Date): { botId: string | null; tokens: number; cost: number | null }[] {
  return ensureDatabase()
    .query(`SELECT bot_id AS botId, ${TOKENS_SQL} AS tokens, SUM(cost) AS cost FROM gond_usage WHERE user_id = ? AND created_at >= ? GROUP BY bot_id ORDER BY tokens DESC`)
    .all(userId, since.toISOString()) as { botId: string | null; tokens: number; cost: number | null }[];
}

export function savePlanLimits(userId: string, source: UsageSource, windows: PlanWindow[]): void {
  ensureDatabase()
    .query("INSERT INTO gond_plan_limits (user_id, source, windows, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, source) DO UPDATE SET windows = excluded.windows, checked_at = excluded.checked_at")
    .run(userId, source, JSON.stringify(windows), now());
  emit({ topic: "usage", userId });
}

/** The windows as last read; one whose reset has passed is full again, until a reading says when it ends. */
export function planLimits(userId: string, source: UsageSource, at = Date.now()): { windows: PlanWindow[]; checkedAt: string } | null {
  const row = ensureDatabase().query("SELECT windows, checked_at FROM gond_plan_limits WHERE user_id = ? AND source = ?").get(userId, source) as { windows: string; checked_at: string } | null;
  if (!row) return null;
  try {
    const windows = (JSON.parse(row.windows) as PlanWindow[]).map((w) => (w.resetsAt && Date.parse(w.resetsAt) <= at ? { ...w, left: 100, resetsAt: null } : w));
    return { windows, checkedAt: row.checked_at };
  } catch {
    return null;
  }
}

function zoned(at: Date, timeZone: string) {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hourCycle: "h23" });
  } catch {
    format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hourCycle: "h23" });
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: String(parts.weekday) };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Midnight where the person is: today's, this Monday's or the first of this month's. */
export function rangeStart(range: UsageRange, timeZone: string, at = new Date()): Date {
  const local = zoned(at, timeZone);
  const back = range === "week" ? Math.max(0, WEEKDAYS.indexOf(local.weekday)) : 0;
  const day = range === "month" ? 1 : local.day - back;
  const wall = Date.UTC(local.year, local.month - 1, day);
  // The zone's offset from UTC at that midnight, read back from how the zone writes it.
  const offsetAt = (ms: number) => {
    const z = zoned(new Date(ms), timeZone);
    return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - ms;
  };
  const guess = wall - offsetAt(wall);
  return new Date(wall - offsetAt(guess));
}
