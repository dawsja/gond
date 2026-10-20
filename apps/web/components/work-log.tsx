"use client";

import type { Bot } from "@gond/shared";
import { BotAvatar } from "@/components/bot-avatar";
import { MarkerContent, markerVariants } from "@/components/ui/marker";

/** What a bot is doing right now, in one line. Its steps are kept by the API but never shown. */
export function WorkLine({ bot, line }: { bot: Bot | undefined; line: string }) {
  return (
    <div className={markerVariants()}>
      {bot ? <BotAvatar bot={bot} size={22} /> : null}
      <MarkerContent className="min-w-0 flex-1 shimmer truncate font-mono text-[12px]">{line}</MarkerContent>
    </div>
  );
}
