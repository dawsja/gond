import type { EngineProviderKind } from "./ai.ts";

/** Where a turn's tokens came from: "claude" is Claude Code on the person's Claude plan, the rest a provider. */
export type UsageSource = "claude" | EngineProviderKind;

export const USAGE_RANGES = ["month", "week", "today"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export function isUsageRange(value: unknown): value is UsageRange {
  return typeof value === "string" && (USAGE_RANGES as readonly string[]).includes(value);
}

/** A plan's window: what share of it is left, 0 to 100, and when it starts again. */
export type PlanWindow = { name: "session" | "weekly" | "monthly"; left: number; resetsAt: string | null };

/**
 * Settings → Usage → Share usage, the admin's: while on, this server's total tokens since `since` go
 * to api.gond.io about once an hour, adding to the public count at gond.io/usage. Only that number.
 */
export type UsageSharing = { on: boolean; since: string | null; tokens: number };
export const USAGE_SHARING_URL = "https://gond.io/usage";

export type UsageReport = {
  /** What the bots run on now, and the host of its key when it is one. */
  source: UsageSource;
  host: string | null;
  windows: PlanWindow[] | null;
  checkedAt: string | null;
  /** This month on what the bots run on now; cost only where the provider says what it billed. */
  month: { tokens: number; cost: number | null };
  range: UsageRange;
  /** Each bot in the range, every source together; a bot since deleted keeps its id. */
  bots: { botId: string | null; tokens: number; cost: number | null }[];
};
