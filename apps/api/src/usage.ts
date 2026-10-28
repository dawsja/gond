import { ENGINE_LABELS, GROK_API_URL, isCliEngine, type PlanWindow, type UsageRange, type UsageReport, type UsageSource } from "@gond/shared";
import { getAi } from "./data/ai.ts";
import { userTimezone } from "./data/prefs.ts";
import { providerBaseUrl } from "./data/providers.ts";
import { botTotals, planLimits, rangeStart, recordUsage, savePlanLimits, sourceTotals, type ModelUsage } from "./data/usage.ts";
import { providerFor, type EngineRun } from "./engines.ts";
import { GROK_PLAN_HEADERS, grokAccessToken } from "./grok.ts";

function usageSourceOf(run: Pick<EngineRun, "access" | "native">): UsageSource {
  if (run.native) return run.native.kind;
  return run.access.kind === "api" ? "anthropic" : "claude";
}

/** Records what one call on `run` used, for the bot and conversation it was for. */
export function usageRecorder(userId: string, botId: string | null, threadId: string | null, run: Pick<EngineRun, "access" | "native">) {
  const source = usageSourceOf(run);
  return (usage: ModelUsage) => recordUsage({ userId, botId, threadId, source, ...usage });
}

/** A Claude plan's windows from Claude Code's rate limit event: the share used, 0 to 1. */
export function claudeWindows(limits: Record<string, { used: number; resetsAt: string }>): PlanWindow[] {
  const out: PlanWindow[] = [];
  for (const name of ["session", "weekly"] as const) {
    const window = limits[name];
    if (window && Number.isFinite(window.used)) out.push({ name, left: Math.round(Math.max(0, Math.min(1, 1 - window.used)) * 100), resetsAt: window.resetsAt || null });
  }
  return out;
}

export function saveClaudeLimits(userId: string, limits: Record<string, { used: number; resetsAt: string }>) {
  const windows = claudeWindows(limits);
  if (windows.length) savePlanLimits(userId, "claude", windows);
}

const GROK_READ_MS = 5 * 60_000;
const GROK_TIMEOUT_MS = 8_000;

type Billing = { config?: { monthlyLimit?: { val?: unknown }; used?: { val?: unknown }; billingPeriodEnd?: unknown; currentPeriod?: { type?: unknown }; creditUsagePercent?: unknown } };

const isoOrNull = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
const percentLeft = (used: number) => Math.round(Math.max(0, Math.min(100, 100 - used)));

/**
 * A Grok plan's windows from the Grok CLI's proxy: `/billing` is the month's credits, `/billing?format=credits`
 * the week's share when the plan has one (it leaves the share out at a fresh week's start).
 */
export function grokWindows(monthly: Billing | null, weekly: Billing | null): PlanWindow[] {
  const out: PlanWindow[] = [];
  const week = weekly?.config;
  if (week?.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY") {
    const used = typeof week.creditUsagePercent === "number" && Number.isFinite(week.creditUsagePercent) ? week.creditUsagePercent : 0;
    out.push({ name: "weekly", left: percentLeft(used), resetsAt: isoOrNull(week.billingPeriodEnd) });
  }
  const month = monthly?.config;
  const limit = month?.monthlyLimit?.val;
  const used = month?.used?.val;
  if (typeof limit === "number" && limit > 0 && typeof used === "number" && Number.isFinite(used)) {
    out.push({ name: "monthly", left: percentLeft((used / limit) * 100), resetsAt: isoOrNull(month?.billingPeriodEnd) });
  }
  return out;
}

const reading = new Map<string, Promise<void>>();

async function readGrok(userId: string): Promise<void> {
  const token = await grokAccessToken(userId);
  if (!token) return;
  const get = async (path: string): Promise<Billing | null> => {
    const res = await fetch(`${GROK_API_URL}/${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...GROK_PLAN_HEADERS }, redirect: "manual", signal: AbortSignal.timeout(GROK_TIMEOUT_MS) }).catch(() => null);
    return res?.ok ? ((await res.json().catch(() => null)) as Billing | null) : null;
  };
  const [monthly, weekly] = await Promise.all([get("billing"), get("billing?format=credits")]);
  const windows = grokWindows(monthly, weekly);
  if (windows.length) savePlanLimits(userId, "grok", windows);
}

/** Reads the plan again when the last reading is old, one read at a time per person. */
async function freshGrok(userId: string): Promise<void> {
  const last = planLimits(userId, "grok");
  if (last && Date.now() - Date.parse(last.checkedAt) < GROK_READ_MS) return;
  let pending = reading.get(userId);
  if (!pending) {
    pending = readGrok(userId).finally(() => reading.delete(userId));
    reading.set(userId, pending);
  }
  await pending;
}

/** What the person's bots run on now, read without failing when it isn't set up. */
function currentSource(userId: string): UsageSource {
  const ai = getAi(userId);
  if (isCliEngine(ai.engine)) return ai.engines[ai.engine].access === "api" ? "anthropic" : "claude";
  const config = ai.engines[ai.engine];
  const info = ENGINE_LABELS[ai.engine];
  return config.provider && info.providers.includes(config.provider) ? config.provider : providerFor(ai.engine, userId);
}

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

export async function usageReport(userId: string, range: UsageRange): Promise<UsageReport> {
  const source = currentSource(userId);
  const timezone = userTimezone(userId);
  if (source === "grok") await freshGrok(userId);
  const limits = source === "claude" || source === "grok" ? planLimits(userId, source) : null;
  const host = source === "claude" ? null : hostOf(providerBaseUrl(userId, source));
  // A plan says how much is left even before its first reading, when it will; the others never do.
  const windows = limits?.windows ?? (source === "claude" || source === "grok" ? [] : null);
  return {
    source,
    host,
    windows,
    checkedAt: limits?.checkedAt ?? null,
    month: sourceTotals(userId, source, rangeStart("month", timezone)),
    range,
    bots: botTotals(userId, rangeStart(range, timezone)),
  };
}
