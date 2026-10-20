"use client";

import { DESKTOP_CONTROL_LABELS } from "@gond/shared";
import type { Bot } from "@gond/shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { changeDesktopControl } from "@/components/computer-panel";
import { ControlChip, DesktopView, INITIAL_REPORT, type DesktopReport } from "@/components/hq/box-desktop";
import { DesktopScreen } from "@/components/hq/desktop-screen";
import { GondBot } from "@/components/hq/gond-bot";
import { useStore } from "@/components/store";
import { cn } from "@/lib/utils";

// How long a closed screen stays live in the panel before the computer goes back to sleep there.
export const SCREEN_PREVIEW_MS = 2 * 60_000;

const awake = new Set<string>();
const sleepTimers = new Map<string, ReturnType<typeof setTimeout>>();
const awakeListeners = new Set<() => void>();

function notifyAwake() {
  for (const listener of awakeListeners) listener();
}

/** Keeps a bot's screen awake in the panel: `null` while it is open, else for `ms` more. */
export function wakeScreen(botId: string, ms: number | null) {
  clearTimeout(sleepTimers.get(botId));
  sleepTimers.delete(botId);
  awake.add(botId);
  if (ms !== null) {
    sleepTimers.set(
      botId,
      setTimeout(() => {
        sleepTimers.delete(botId);
        awake.delete(botId);
        notifyAwake();
      }, ms),
    );
  }
  notifyAwake();
}

export function useScreenAwake(botId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      awakeListeners.add(listener);
      return () => void awakeListeners.delete(listener);
    },
    () => awake.has(botId),
    () => false,
  );
}

/** The panel while nobody uses the computer: the bot asleep, and no connection to the desktop. */
export function SleepingScreen({ bot, onWake }: { bot: Pick<Bot, "name" | "color" | "shape">; onWake: () => void }) {
  return (
    <button
      type="button"
      onClick={onWake}
      aria-label={`${bot.name}'s computer is asleep. Wake it`}
      className="group flex aspect-[16/10] min-h-11 w-full flex-col items-center justify-center gap-1.5 rounded-xl border bg-muted text-muted-foreground outline-none transition-colors hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span aria-hidden="true">
        <GondBot color={bot.color} shape={bot.shape} size={56} greet={false} asleep label="" />
      </span>
      <span className="text-[13px] font-medium text-foreground">Computer is asleep</span>
      <span className="text-[12px] pointer-coarse:hidden">Click to wake</span>
      <span className="hidden text-[12px] pointer-coarse:inline">Tap to wake</span>
    </button>
  );
}

export function ScreenPanel({ botId, expanded, onExpand, onCollapse }: { threadId: string; botId: string; expanded: boolean; onExpand: () => void; onCollapse: () => void }) {
  const { desktop, botById } = useStore();
  const control = desktop?.control ?? "free";
  const bot = botById(botId);
  const name = bot?.name ?? "The bot";
  const [report, setReport] = useState<DesktopReport>(INITIAL_REPORT);

  useEffect(() => {
    if (!expanded) return;
    wakeScreen(botId, null);
    return () => wakeScreen(botId, SCREEN_PREVIEW_MS);
  }, [expanded, botId]);

  if (expanded) {
    return (
      <DesktopScreen
        title={name}
        wideTitle={`${name} · Screen`}
        icon={bot ? <BotAvatar bot={bot} size={32} /> : null}
        driver={name}
        control={control}
        onControlChange={changeDesktopControl}
        onClose={onCollapse}
        closeLabel="Hide"
        backdropLabel="Hide the screen"
      />
    );
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-primary-edge bg-card">
      <div className="aspect-[16/10] w-full">
        <DesktopView viewOnly quality="thumb" onStatus={setReport} className="h-full" />
      </div>
      <button type="button" onClick={onExpand} aria-label={`Watch ${name}'s screen`} className="group absolute inset-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full border border-primary-edge bg-primary px-2 py-0.5 text-[11px] text-primary-foreground">
          <span className={cn("size-1.5 rounded-full", report.status === "live" ? "animate-pulse bg-tone-ok" : "bg-muted-foreground")} aria-hidden="true" />
          {report.status === "live" ? "Live" : report.status === "error" || report.status === "ended" ? "Off" : "Connecting"}
        </span>
        <ControlChip control={control} className="absolute top-2 right-2" />
        <span className="absolute inset-x-0 bottom-0 bg-card/90 px-3 py-1.5 text-left text-[12px] text-card-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100">
          {control === "person" ? DESKTOP_CONTROL_LABELS.person : "Watch the screen"}
        </span>
      </button>
    </div>
  );
}
