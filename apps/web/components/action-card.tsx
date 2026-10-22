"use client";

import type { Bot } from "@gond/shared";
import { Check, ChevronDown, Lock, X } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// Cards the person answered on this page, so the one they just said yes to celebrates as it folds and
// an old answered card loaded from history doesn't.
const answeredHere = new Set<string>();

/** Call as the person answers a card, so its folded line hops. */
export function cheerOnFold(id: string) {
  answeredHere.add(id);
}

/**
 * Every card a bot posts for the person to act on: the bot's bubble grey with the pill edge, the bot
 * peeking over its top edge, the question with "Needs you", then what it is about, the buttons and a
 * line on privacy. A card from a bot speaking up on its own (`noticed`) wears the person's color.
 */
export function ActionCard({ bot, icon, title, by, children, actions, note, noticed = false, className }: { bot?: Bot; icon: ReactNode; title: ReactNode; by?: ReactNode; children?: ReactNode; actions?: ReactNode; note?: ReactNode; noticed?: boolean; className?: string }) {
  return (
    <div className={cn("relative w-full max-w-[440px]", bot && "mt-7")}>
      {bot ? <BotAvatar bot={{ ...bot, primary: false }} size={52} className="absolute -top-[27px] right-24 animate-peek motion-reduce:animate-none" /> : null}
      <div data-slot="action-card" className={cn("relative flex flex-col gap-3.5 rounded-3xl border p-4", noticed ? "border-tint-edge bg-tint-wash" : "border-primary-edge bg-bubble-bot", className)}>
        <div className="flex items-start gap-3">
          {noticed || !bot ? <span className={cn("grid size-10 shrink-0 place-items-center rounded-full [&_svg]:size-[18px]", noticed ? "bg-tint-solid text-tint-foreground" : "border border-primary-edge bg-primary text-foreground")}>{icon}</span> : null}
          <div className="min-w-0 flex-1 self-center">
            <p className="text-[15px] leading-5 font-semibold break-words">{title}</p>
            {by ? <p className="text-[12.5px] leading-4 break-words text-muted-foreground">{by}</p> : null}
          </div>
          {noticed ? null : (
            <Badge tone="warn" className="shrink-0">
              Needs you
            </Badge>
          )}
        </div>
        {children}
        {actions ? (
          // Side by side at equal widths while every label fits on one line; a label that doesn't
          // takes its own row, and one wider than the card wraps inside its button.
          <div className="flex flex-wrap gap-2 max-sm:flex-col *:h-auto *:min-h-11 *:min-w-fit *:flex-1 *:py-2.5 *:text-center *:leading-5 *:whitespace-normal *:[overflow-wrap:anywhere]">{actions}</div>
        ) : null}
        {note ? (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-muted-foreground">
            <Lock className="mt-px size-3 shrink-0" aria-hidden="true" />
            <span>{note}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

const CONFETTI: { color: string; dx: number; dy: number; delay: number; shape: string }[] = [
  { color: "var(--tint)", dx: -18, dy: -14, delay: 0, shape: "size-1.5 rounded-[2px]" },
  { color: "var(--gold)", dx: 18, dy: -16, delay: 0.15, shape: "size-[5px] rounded-full" },
  { color: "var(--tone-ok)", dx: 20, dy: 6, delay: 0.25, shape: "h-[3px] w-1.5 rounded-[2px]" },
  { color: "var(--magenta)", dx: -20, dy: 4, delay: 0.08, shape: "h-1.5 w-1 rounded-[2px]" },
];

/** Once answered, a card folds to one line with how it ended; one the person just answered hops. */
export function ActionCardDone({ id, bot, icon, title, by, status, tone }: { id?: string; bot?: Bot; icon: ReactNode; title: ReactNode; by?: ReactNode; status: string; tone: "ok" | "bad" | "neutral" }) {
  const [celebrate] = useState(() => Boolean(id && tone === "ok" && answeredHere.has(id)));
  useEffect(() => {
    if (id) answeredHere.delete(id);
  }, [id]);
  return (
    <div data-slot="action-card" className={cn("flex w-full max-w-[440px] items-center gap-3 rounded-3xl border py-3 pr-3.5 pl-3", tone === "ok" ? "border-tone-ok-edge bg-tone-ok-wash" : "border-primary-edge bg-bubble-bot")}>
      {bot ? (
        <span className="relative grid size-8 shrink-0 place-items-center">
          {celebrate
            ? CONFETTI.map((bit, i) => (
                <span key={i} aria-hidden="true" className={cn("absolute top-1/2 left-1/2 animate-confetti opacity-0 motion-reduce:hidden", bit.shape)} style={{ background: bit.color, animationDelay: `${bit.delay}s`, "--dx": `${bit.dx}px`, "--dy": `${bit.dy}px` } as CSSProperties} />
              ))
            : null}
          <BotAvatar bot={{ ...bot, primary: false }} size={32} className={cn(celebrate && "animate-hop motion-reduce:animate-none")} />
        </span>
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-muted-foreground [&_svg]:size-4">{icon}</span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] leading-5 font-medium">{title}</p>
        {by ? <p className="truncate text-[12px] leading-4 text-muted-foreground">{by}</p> : null}
      </div>
      <Badge tone={tone} className="max-w-[45%] shrink-0" title={status}>
        {tone === "ok" ? <Check aria-hidden="true" /> : tone === "bad" ? <X aria-hidden="true" /> : null}
        <span className="truncate">{status}</span>
      </Badge>
    </div>
  );
}

export type ActionItem = { label: string; value: string; note?: string };
export type ActionRow = { label: string; value: string; items?: ActionItem[] };

/** The rows a card is about, drawn like the chat's tables. */
// A value this short (a price, a date) sits on the right of its label; a longer one, like a
// path or a sentence, goes under it, or it would squeeze the label to a letter per line.
const FIGURE_CHARS = 24;

function ItemsRow({ row }: { row: ActionRow & { items: ActionItem[] } }) {
  return (
    <Collapsible className="border-b border-primary-edge/70 last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-baseline gap-2 px-3.5 py-2 text-left outline-none focus-visible:bg-primary-hover [&[data-panel-open]_svg]:rotate-180">
        <span className="min-w-0 flex-1 wrap-anywhere">
          {row.label} <span className="font-semibold text-tint-ink">{row.items.length === 1 ? "1 item" : `${row.items.length} items`}</span>
        </span>
        {row.value ? <span className="shrink-0 text-right text-muted-foreground tabular-nums">{row.value}</span> : null}
        <ChevronDown className="size-4 shrink-0 self-center text-muted-foreground transition-transform" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-56 overflow-y-auto bg-background/60 py-1">
        {row.items.map((item, i) => (
          <div key={i} className="flex items-center gap-2 py-1.5 pr-3.5 pl-5 text-[13px] leading-5">
            <span className="min-w-0 flex-1 wrap-anywhere">{item.label}</span>
            {item.note ? <Badge tone="warn">{item.note}</Badge> : null}
            {item.value ? <span className="shrink-0 text-muted-foreground tabular-nums">{item.value}</span> : null}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ActionRows({ rows, total }: { rows: ActionRow[]; total?: { label: string; value: string } }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-primary-edge bg-background/50 text-[13.5px]">
      {rows.map((row, i) =>
        row.items?.length ? (
          <ItemsRow key={i} row={{ ...row, items: row.items }} />
        ) : row.value.length > FIGURE_CHARS ? (
          <div key={i} className="flex flex-col gap-0.5 border-b border-primary-edge/70 px-3.5 py-2 last:border-b-0">
            <span className="wrap-anywhere">{row.label}</span>
            <span className="wrap-anywhere text-muted-foreground">{row.value}</span>
          </div>
        ) : (
          <div key={i} className="flex items-baseline justify-between gap-3 border-b border-primary-edge/70 px-3.5 py-2 last:border-b-0">
            <span className="min-w-0 wrap-anywhere">{row.label}</span>
            {row.value ? <span className="shrink-0 text-right text-muted-foreground tabular-nums">{row.value}</span> : null}
          </div>
        ),
      )}
      {total ? (
        <div className={cn("flex items-baseline justify-between gap-3 px-3.5 pt-2 pb-2.5", rows.length > 0 && "border-t border-primary-edge")}>
          <span className="min-w-0 font-semibold break-words">{total.label}</span>
          <span className="shrink-0 text-[22px] leading-7 font-bold tabular-nums">{total.value}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ActionCode({ children }: { children: ReactNode }) {
  return <pre className="max-h-48 overflow-auto rounded-2xl border border-primary-edge bg-background/50 px-3.5 py-2.5 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap">{children}</pre>;
}
