"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { Check, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import type { Badge as BadgeRecord, Meter as MeterRecord, Tone } from "@/lib/markdown";
import { cn } from "@/lib/utils";

const ICONS: Record<Tone, ReactNode> = {
  ok: <Check aria-hidden="true" />,
  warn: <TriangleAlert aria-hidden="true" />,
  bad: <X aria-hidden="true" />,
  info: <Info aria-hidden="true" />,
  neutral: null,
};

const TEXT: Record<Tone, string> = {
  ok: "text-tone-ok",
  warn: "text-tone-warn",
  bad: "text-tone-bad",
  info: "text-tone-info",
  neutral: "text-foreground",
};

export function StatusBadge({ badge, children }: { badge: BadgeRecord; children: ReactNode }) {
  return (
    <Badge tone={badge.tone} wrap>
      {ICONS[badge.tone]}
      <span className="min-w-0 break-words">{children}</span>
    </Badge>
  );
}

export function Meter({ meter, children }: { meter: MeterRecord; children: ReactNode }) {
  const caption = meter.left || meter.right;
  return (
    <ProgressPrimitive.Root value={meter.percent} data-slot="meter" className="flex flex-col gap-1.5 py-0.5">
      {/* The value sits beside the label while both fit and wraps under it, to the left, when they don't. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <ProgressPrimitive.Label className="min-w-0 font-medium [overflow-wrap:anywhere]">{children}</ProgressPrimitive.Label>
        <span className={cn("min-w-0 text-[13px] font-medium tabular-nums", TEXT[meter.tone])}>{meter.text}</span>
      </div>
      <ProgressTrack className="h-1.5 rounded-full">
        <ProgressIndicator tone={meter.tone} className="rounded-full" />
      </ProgressTrack>
      {caption ? (
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[12px] leading-4 text-muted-foreground tabular-nums">
          {meter.left ? <span className="min-w-0">{meter.left}</span> : null}
          {meter.right ? <span className={cn("min-w-0", !meter.left && "ml-auto")}>{meter.right}</span> : null}
        </div>
      ) : null}
    </ProgressPrimitive.Root>
  );
}

/**
 * Where a message's choices can go: `pick` sends one as the person's message while the question
 * is still open; `picked` is what they answered once they have, which closes it.
 */
export const ChoicesContext = createContext<{ pick?: (option: string) => Promise<void>; picked?: string | null }>({});

export function Choices({ options }: { options: string[] }) {
  const { pick, picked } = useContext(ChoicesContext);
  const [sending, setSending] = useState<string | null>(null);
  const open = Boolean(pick) && picked === undefined;
  const chosen = (sending ?? picked)?.trim().toLowerCase() ?? null;
  return (
    <div data-slot="choices" role="group" aria-label="Choices" className="flex flex-wrap gap-2 pt-1">
      {options.map((option) => {
        const on = chosen === option.toLowerCase();
        return (
          <Button
            key={option}
            type="button"
            size="lg"
            variant={on ? "default" : "outline"}
            disabled={!open || Boolean(sending)}
            aria-pressed={on}
            className={cn("h-auto min-h-9 max-w-full py-1.5 text-left leading-5 whitespace-normal [overflow-wrap:anywhere]", on && "disabled:opacity-100")}
            onClick={() => {
              if (!pick || sending) return;
              setSending(option);
              void pick(option).finally(() => setSending(null));
            }}
          >
            {option}
          </Button>
        );
      })}
    </div>
  );
}
