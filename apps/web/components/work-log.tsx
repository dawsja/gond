"use client";

import type { Bot } from "@gond/shared";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { BotAvatar, RoomAvatar } from "@/components/bot-avatar";
import { MarkerContent, markerVariants } from "@/components/ui/marker";
import { cn } from "@/lib/utils";

/** What a bot is doing right now, in one line. Its steps are kept by the API but never shown. */
export function WorkLine({ bot, line }: { bot: Bot | undefined; line: string }) {
  return (
    <div className={markerVariants()}>
      {bot ? <BotAvatar bot={bot} size={22} /> : null}
      <MarkerContent className="min-w-0 flex-1 shimmer truncate font-mono text-[12px]">{line}</MarkerContent>
    </div>
  );
}

const CUBES = 5;

/**
 * Several bots working at once: their faces and a row of squares lighting up in each one's colour
 * in turn. A tap opens what each is doing, a line apiece, and taps again to close it.
 */
export function WorkLines({ working, label }: { working: { bot: Bot; line: string }[]; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button type="button" aria-expanded={open} aria-label={`${label} are working. ${open ? "Hide" : "Show"} what each is doing.`} onClick={() => setOpen((was) => !was)} className={cn(markerVariants(), "w-fit gap-2.5 rounded-full pr-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11")}>
        <RoomAvatar bots={working.map((w) => w.bot)} size={30} />
        <span aria-hidden="true" className="flex items-center gap-1">
          {Array.from({ length: CUBES }, (_, i) => (
            <span key={i} className="size-2.5 animate-light-up rounded-[3px] bg-muted motion-reduce:animate-none motion-reduce:bg-(--lit)" style={{ ["--lit" as string]: working[i % working.length]!.bot.color, animationDelay: `${i * 0.18}s` }} />
          ))}
        </span>
        <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open
        ? working.map(({ bot, line }) => (
            <div key={bot.id} className={cn(markerVariants(), "pl-[38px]")}>
              <BotAvatar bot={bot} size={18} />
              <MarkerContent className="min-w-0 flex-1 shimmer truncate font-mono text-[12px]">{line}</MarkerContent>
            </div>
          ))
        : null}
    </div>
  );
}
