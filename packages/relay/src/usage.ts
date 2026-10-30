import type { Sql } from "./mailbox.ts";
import { LIMITS, parseUsage, signedUsage, verifySignature, type UsageTotals } from "./protocol.ts";

/**
 * The public count of tokens Gond's bots used, from every Gond whose admin chose to share it. Each
 * Gond reports a running total; the relay keeps the last one per key and adds them up. Anyone can
 * make a key, so a report may grow its Gond's count only so fast (`usageTokensPerHour`), and a key
 * reports at most every `usageEveryMs`.
 */
export function createUsageStore(sql: Sql, now: () => number = Date.now) {
  sql.run(`CREATE TABLE IF NOT EXISTS relay_usage (
    key TEXT PRIMARY KEY,
    epoch TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    banked INTEGER NOT NULL DEFAULT 0,
    first_at INTEGER NOT NULL,
    at INTEGER NOT NULL
  )`);
  sql.run("CREATE TABLE IF NOT EXISTS relay_usage_days (day TEXT PRIMARY KEY, tokens INTEGER NOT NULL)");
  // What a report adds goes to the UTC day it came in, so the days add up to the total.
  const addToDay = (at: number, tokens: number) => {
    if (tokens > 0) sql.run("INSERT INTO relay_usage_days (day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens", new Date(at).toISOString().slice(0, 10), tokens);
  };

  return {
    now,
    /** Takes one checked report: its Gond's total so far, as far as it may have grown since the last. */
    report(key: string, epoch: string, tokens: number): "counted" | "too_soon" {
      const at = now();
      const row = sql.all("SELECT epoch, tokens, banked, at FROM relay_usage WHERE key = ?", key)[0] as { epoch: string; tokens: number; banked: number; at: number } | undefined;
      if (row && at - Number(row.at) < LIMITS.usageEveryMs) return "too_soon";
      const hours = row ? Math.max(1, (at - Number(row.at)) / 3_600_000) : 1;
      const most = Math.floor(LIMITS.usageTokensPerHour * hours);
      if (!row) {
        const counted = Math.min(tokens, most);
        sql.run("INSERT INTO relay_usage (key, epoch, tokens, banked, first_at, at) VALUES (?, ?, ?, 0, ?, ?)", key, epoch, counted, at, at);
        addToDay(at, counted);
        return "counted";
      }
      // A new epoch is sharing turned on again: what the last one counted stays in the total.
      const fresh = row.epoch !== epoch;
      const before = fresh ? 0 : Number(row.tokens);
      const banked = Number(row.banked) + (fresh ? Number(row.tokens) : 0);
      const next = before + Math.min(Math.max(tokens - before, 0), most);
      sql.run("UPDATE relay_usage SET epoch = ?, tokens = ?, banked = ?, at = ? WHERE key = ?", epoch, next, banked, at, key);
      addToDay(at, next - before);
      return "counted";
    },
    totals(): UsageTotals {
      const row = sql.all("SELECT COALESCE(SUM(tokens + banked), 0) AS tokens, COUNT(*) AS gonds, MIN(first_at) AS since FROM relay_usage")[0] ?? {};
      const from = new Date(now() - (LIMITS.usageDays - 1) * 86_400_000).toISOString().slice(0, 10);
      const days = sql.all("SELECT day, tokens FROM relay_usage_days WHERE day >= ? ORDER BY day", from).map((d) => ({ day: String(d.day), tokens: Number(d.tokens) }));
      return { tokens: Number(row.tokens ?? 0), gonds: Number(row.gonds ?? 0), since: row.since === null || row.since === undefined ? null : Number(row.since), days };
    },
  };
}

export type UsageStore = ReturnType<typeof createUsageStore>;

export type UsageAnswer = { status: number; body: { result: "counted" } | { error: string } };

/** One `/v1/usage` report: checked, signed by a Gond's key, then counted. */
export async function handleUsage(raw: unknown, store: UsageStore): Promise<UsageAnswer> {
  const report = parseUsage(raw);
  if (!report) return { status: 400, body: { error: "That isn't a version 1 usage report." } };
  if (Math.abs(store.now() - report.at) > LIMITS.pushSkewMs) return { status: 400, body: { error: "The report's time is too far from the relay's." } };
  const { sig, ...signed } = report;
  if (!(await verifySignature(report.from, sig, signedUsage(signed)))) return { status: 401, body: { error: "The report's signature doesn't match its sender." } };
  if (store.report(report.from, report.epoch, report.tokens) === "too_soon") return { status: 429, body: { error: `One report every ${LIMITS.usageEveryMs / 60_000} minutes.` } };
  return { status: 200, body: { result: "counted" } };
}

/** The totals as anyone may read them, from any site. */
export function usageJson(totals: UsageTotals): Response {
  return Response.json(totals, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" } });
}
