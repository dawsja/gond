"use client";

import { isWatchRun, routineName, type Bot, type Message, type Routine } from "@gond/shared";
import { Clock, Eye } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { api, post } from "@/lib/api";
import { describeSchedule } from "@/lib/schedule";

/** The bot's watches that are on, refetched when a routine changes. */
export function useWatches(botId: string | null): Routine[] {
  const [watches, setWatches] = useState<Routine[]>([]);
  const load = useCallback(async () => {
    if (!botId) return setWatches([]);
    const data = await api<{ routines: Routine[] }>(`/api/routines?bot=${botId}`).catch(() => null);
    if (data) setWatches(data.routines.filter((r) => r.watch && r.enabled));
  }, [botId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });
  return watches;
}

export const WatchesContext = createContext<Routine[]>([]);

export type Noticed = { watch: string; lead: boolean };

/**
 * Which messages a watch's run said, from its marker until the person next speaks, so its cards
 * wear the person's color and its first line carries "Why you're seeing this" and "Less like this".
 */
export function noticedRuns(messages: Message[]): Map<string, Noticed> {
  const runs = new Map<string, Noticed>();
  let watch: string | null = null;
  let lead = false;
  for (const m of messages) {
    if (m.author === "routine") {
      watch = isWatchRun(m.body) ? (routineName(m.body) ?? "") : null;
      lead = true;
    } else if (m.author === "you") {
      watch = null;
    } else if (watch !== null && m.kind !== "prompt" && m.author !== "system") {
      runs.set(m.id, { watch, lead: lead && m.kind === "message" });
      if (m.kind === "message") lead = false;
    }
  }
  return runs;
}

/** The line a routine's run leaves: a clock and its name, or for a watch, "<bot> noticed". */
export function RunMarker({ message, bot }: { message: Message; bot: Bot | null }) {
  const name = routineName(message.body);
  if (!isWatchRun(message.body)) {
    return (
      <Marker className="justify-center" title={message.body.replace(/\s+/g, " ").slice(0, 200)}>
        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        <MarkerContent className="max-w-[80%] truncate text-xs">{name ?? "A routine"}</MarkerContent>
      </Marker>
    );
  }
  return (
    <Marker className="justify-center" title={name ?? undefined}>
      <Eye className="size-3.5 shrink-0 text-tint-ink" aria-hidden="true" />
      <MarkerContent className="max-w-[80%] truncate text-xs">
        <span className="font-semibold text-tint-ink">{bot?.name ?? "Your bot"} noticed</span>
        {name ? ` · ${name}` : null}
      </MarkerContent>
    </Marker>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const LINK = "inline-flex min-h-7 items-center rounded-full px-2 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 pointer-coarse:min-h-11";

export function NoticedLinks({ message, watch, bot }: { message: Message; watch: string; bot: Bot | null }) {
  const watches = useContext(WatchesContext);
  const routine = watches.find((r) => r.name === watch);
  const [sent, setSent] = useState(false);
  const name = bot?.name ?? "Your bot";

  async function less() {
    if (sent) return;
    setSent(true);
    try {
      await post(`/api/threads/${message.threadId}/messages/${message.id}/less`, { watch });
      toast.add({ title: `${name} will leave things like this out.` });
    } catch {
      setSent(false);
      toast.add({ type: "error", title: "Couldn't send that." });
    }
  }

  return (
    <div className="-ml-2 flex flex-wrap gap-x-1">
      <Popover>
        <PopoverTrigger className={LINK}>Why you&apos;re seeing this</PopoverTrigger>
        <PopoverContent className="w-72">
          <PopoverHeader>
            <PopoverTitle>{watch ? `${name} is watching “${watch}”` : `${name} noticed this`}</PopoverTitle>
            <PopoverDescription>
              {routine ? `It checks ${lowerFirst(describeSchedule(routine.cron))}, and only speaks up when something changes that matters to you.` : "It only speaks up when something changes that matters to you."} Ask {name} to change or stop it any time.
            </PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
      <button type="button" className={LINK} onClick={() => void less()} disabled={sent}>
        {sent ? "Got it" : "Less like this"}
      </button>
    </div>
  );
}
