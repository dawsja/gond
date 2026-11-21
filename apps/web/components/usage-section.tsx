"use client";

import { CHATGPT_USAGE_URL, USAGE_RANGES, USAGE_SHARING_URL, type Bot, type PlanWindow, type UsageRange, type UsageReport, type UsageSharing, type UsageSource } from "@gond/shared";
import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { failed } from "@/components/failed";
import { InfoTip } from "@/components/info-tip";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { useSingleFlight, useStore } from "@/components/store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";

const RANGE_LABELS: Record<UsageRange, string> = { month: "This month", week: "This week", today: "Today" };
const WINDOW_LABELS: Record<PlanWindow["name"], string> = { session: "5-hour limit", weekly: "Weekly limit", monthly: "Monthly limit" };
const PLANS = new Set<UsageSource>(["claude", "chatgpt", "grok"]);
// Amber from this share used on.
const HIGH = 80;

const tokens = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const dollars = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);

function resets(iso: string | null): string {
  if (!iso) return "Full again";
  const at = new Date(iso);
  const days = (at.getTime() - Date.now()) / 86_400_000;
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return `Resets at ${time}`;
  if (days < 6) return `Resets ${at.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  return `Resets ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The plan or key by name, and what about it the person would recognise. */
function planName(report: UsageReport): { name: string; detail: string } {
  switch (report.source) {
    case "claude":
      return { name: "Claude plan", detail: "Claude Code on your plan" };
    case "chatgpt":
      return { name: "ChatGPT plan", detail: "Signed in with ChatGPT" };
    case "grok":
      return { name: "Grok plan", detail: "Signed in with Grok" };
    case "anthropic":
      return { name: "Anthropic-compatible key", detail: report.host ? `Your key at ${report.host}` : "Your API key" };
    case "openai":
      return { name: "OpenAI-compatible key", detail: report.host ? `Your key at ${report.host}` : "Your API key" };
  }
}

/** Why there is no meter, and where to look instead. */
function notShared(report: UsageReport): { text: string; link: { href: string; label: string } | null } {
  if (report.source === "claude") return { text: "Shows here after your bots' next reply.", link: null };
  if (report.source === "grok") return { text: "Grok didn't say how much is left just now.", link: null };
  if (report.source === "chatgpt") return { text: "ChatGPT doesn't share how much of your plan is left.", link: { href: CHATGPT_USAGE_URL, label: "See it on chatgpt.com" } };
  if (report.host === "api.anthropic.com") return { text: "Anthropic doesn't share a key's balance.", link: { href: "https://console.anthropic.com", label: "See it on console.anthropic.com" } };
  if (report.host === "api.openai.com") return { text: "OpenAI doesn't share a key's balance.", link: { href: "https://platform.openai.com/usage", label: "See it on platform.openai.com" } };
  if (report.host === "api.x.ai") return { text: "xAI doesn't share a key's balance.", link: { href: "https://console.x.ai", label: "See it on console.x.ai" } };
  return { text: "Your key's provider doesn't share how much is left.", link: null };
}

function spent(report: UsageReport): { value: string; note: string } {
  if (report.month.cost !== null) return { value: dollars(report.month.cost), note: "this month" };
  if (PLANS.has(report.source)) return { value: "Included", note: "in your plan" };
  return { value: "Not shared", note: report.host === "api.anthropic.com" ? "by Anthropic" : report.host === "api.openai.com" ? "by OpenAI" : "by your provider" };
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl bg-muted px-3 py-2.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-[12px] text-muted-foreground">{note}</span>
    </div>
  );
}

function PlanCard({ report }: { report: UsageReport }) {
  const { name, detail } = planName(report);
  const missing = report.windows?.length ? null : notShared(report);
  const money = spent(report);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        <CardDescription>{detail}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {report.windows?.map((window) => (
          <div key={window.name} className="flex flex-col gap-1.5">
            <Progress value={100 - window.left} tone={100 - window.left >= HIGH ? "warn" : undefined}>
              <ProgressLabel>{WINDOW_LABELS[window.name]}</ProgressLabel>
              <ProgressValue className={100 - window.left >= HIGH ? "font-medium text-tone-warn" : "font-medium text-foreground"}>{() => `${100 - window.left}% used`}</ProgressValue>
            </Progress>
            <span className="text-[12px] text-muted-foreground">{resets(window.resetsAt)}</span>
          </div>
        ))}
        {missing ? (
          <p className="flex items-start gap-2 rounded-2xl bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {missing.text}{" "}
              {missing.link ? (
                <a href={missing.link.href} target="_blank" rel="noreferrer" className="font-medium whitespace-nowrap text-foreground underline underline-offset-2">
                  {missing.link.label}
                </a>
              ) : null}
            </span>
          </p>
        ) : null}
        {report.windows?.length && report.checkedAt ? <p className="text-[12px] text-muted-foreground">As of {ago(report.checkedAt)}. This counts everything on the plan, not only Gond.</p> : null}
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Spent" value={money.value} note={money.note} />
          <Stat label="Tokens" value={tokens(report.month.tokens)} note="this month" />
        </div>
      </CardContent>
    </Card>
  );
}

const REMOVED: Pick<Bot, "name" | "title" | "color" | "expression" | "primary"> = { name: "Bots you removed", title: "", color: "#8f8b84", expression: "happy", primary: false };

function BotsCard({ report, range, onRange }: { report: UsageReport; range: UsageRange; onRange: (range: UsageRange) => void }) {
  const { bots } = useStore();
  const total = report.bots.reduce((sum, row) => sum + row.tokens, 0);
  // Every bot that's gone is one row, whatever it was called.
  const rows: { key: string; bot: Pick<Bot, "name" | "title" | "color" | "expression" | "primary"> & Partial<Pick<Bot, "shape" | "avatar">>; tokens: number; cost: number | null }[] = [];
  let removed: (typeof rows)[number] | null = null;
  for (const row of report.bots) {
    const bot = bots.find((b) => b.id === row.botId);
    if (bot) rows.push({ key: bot.id, bot, tokens: row.tokens, cost: row.cost });
    else if (removed) {
      removed.tokens += row.tokens;
      removed.cost = row.cost === null ? removed.cost : (removed.cost ?? 0) + row.cost;
    } else removed = { key: "removed", bot: REMOVED, tokens: row.tokens, cost: row.cost };
  }
  if (removed) rows.push(removed);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle id="usage-bots">Your bots</CardTitle>
        <ToggleGroup aria-labelledby="usage-bots" variant="pill" size="sm" value={[range]} onValueChange={(next) => next[0] && onRange(next[0] as UsageRange)}>
          {USAGE_RANGES.map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {RANGE_LABELS[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <BotAvatar bot={row.bot} size={32} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium">{row.bot.name}</span>
                  <span className="text-[12px] text-muted-foreground">{total ? `${Math.max(1, Math.round((row.tokens / total) * 100))}% of the total` : ""}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end tabular-nums">
                  <span className="text-[14px] font-semibold">{tokens(row.tokens)}</span>
                  <span className="text-[12px] text-muted-foreground">{row.cost !== null ? dollars(row.cost) : "tokens"}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">Nothing yet {range === "today" ? "today" : range === "week" ? "this week" : "this month"}.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** The admin's: whether this server's token count adds to the public one at gond.io/usage. */
function SharingCard() {
  const [sharing, setSharing] = useState<UsageSharing | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = useSingleFlight(async () => {
    const data = await api<UsageSharing>("/api/usage/sharing").catch(() => null);
    setLoadFailed(!data);
    if (data) setSharing(data);
  });
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "usage" || event.topic === "settings") void load();
  });

  async function change(on: boolean) {
    setSaving(true);
    try {
      setSharing(await api<UsageSharing>("/api/usage/sharing", { method: "PUT", body: JSON.stringify({ on }) }));
    } catch (error) {
      failed(on ? "Couldn't turn sharing on." : "Couldn't turn sharing off.")(error);
    } finally {
      setSaving(false);
    }
  }

  const since = sharing?.since ? new Date(sharing.since).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage metrics</CardTitle>
        <CardDescription>For the whole server. Only you, the admin, can change it.</CardDescription>
      </CardHeader>
      <CardContent>
        {!sharing ? (
          loadFailed ? <LoadFailed what="usage sharing" onRetry={() => void load()} /> : <Skeleton className="h-12 rounded-xl" />
        ) : (
          <Field orientation="horizontal" data-disabled={saving || undefined}>
            <FieldContent>
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor="share-usage">Share usage metrics</FieldLabel>
                <InfoTip label="What sharing sends">
                  <p>Adds this server&apos;s token count to the public total anyone can see at {USAGE_SHARING_URL.replace("https://", "")}.</p>
                  <p>Only that one number goes, about once an hour: everyone&apos;s bots here together, counted from when you turn it on. No names, bots, models, messages or costs.</p>
                </InfoTip>
              </div>
              <FieldDescription>{sharing.on && since ? `${tokens(sharing.tokens)} tokens counted since ${since}.` : "Off. Nothing is sent."}</FieldDescription>
            </FieldContent>
            <Switch id="share-usage" checked={sharing.on} disabled={saving} onCheckedChange={(on) => void change(on)} />
          </Field>
        )}
      </CardContent>
    </Card>
  );
}

export function UsageSection() {
  const { admin } = useStore();
  const [range, setRange] = useState<UsageRange>("month");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useSingleFlight(async () => {
    const data = await api<UsageReport>(`/api/usage?range=${range}`).catch(() => null);
    setLoadFailed(!data);
    if (data) setReport(data);
  });
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, range]);
  useLiveEvents((event) => {
    if (event.topic === "usage" || event.topic === "ai") void load();
  });

  if (!report) return loadFailed ? <LoadFailed what="your usage" onRetry={() => void load()} /> : <Skeleton className="h-96 rounded-xl" />;
  return (
    <>
      <PlanCard report={report} />
      <BotsCard report={report} range={range} onRange={setRange} />
      {admin ? <SharingCard /> : null}
    </>
  );
}
