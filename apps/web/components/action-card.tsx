import { Check, Lock, X } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Every card a bot posts for the person to act on: the bot's bubble grey with the pill edge, an
 * icon in a circle, the question, then what it is about, the buttons and a line on privacy.
 */
export function ActionCard({ icon, title, by, children, actions, note, className }: { icon: ReactNode; title: ReactNode; by?: ReactNode; children?: ReactNode; actions?: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div data-slot="action-card" className={cn("flex w-full max-w-[440px] flex-col gap-3.5 rounded-3xl border border-primary-edge bg-bubble-bot p-4", className)}>
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-primary-edge bg-primary text-foreground [&_svg]:size-[18px]">{icon}</span>
        <div className="min-w-0">
          <p className="text-[15px] leading-5 font-semibold break-words">{title}</p>
          {by ? <p className="text-[12.5px] leading-4 break-words text-muted-foreground">{by}</p> : null}
        </div>
      </div>
      {children}
      {actions ? <div className="grid auto-cols-fr grid-flow-col gap-2 max-sm:grid-flow-row">{actions}</div> : null}
      {note ? (
        <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-muted-foreground">
          <Lock className="mt-px size-3 shrink-0" aria-hidden="true" />
          <span>{note}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Once answered, a card folds to one line with how it ended. */
export function ActionCardDone({ icon, title, by, status, tone }: { icon: ReactNode; title: ReactNode; by?: ReactNode; status: string; tone: "ok" | "bad" | "neutral" }) {
  return (
    <div data-slot="action-card" className="flex w-full max-w-[440px] items-center gap-3 rounded-3xl border border-primary-edge bg-bubble-bot py-3 pr-3.5 pl-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] leading-5 font-medium">{title}</p>
        {by ? <p className="truncate text-[12px] leading-4 text-muted-foreground">{by}</p> : null}
      </div>
      <Badge tone={tone}>
        {tone === "ok" ? <Check aria-hidden="true" /> : tone === "bad" ? <X aria-hidden="true" /> : null}
        {status}
      </Badge>
    </div>
  );
}

/** The rows a card is about, drawn like the chat's tables. */
// A value this short (a price, a date) sits on the right of its label; a longer one, like a
// path or a sentence, goes under it, or it would squeeze the label to a letter per line.
const FIGURE_CHARS = 24;

export function ActionRows({ rows, total }: { rows: { label: string; value: string }[]; total?: { label: string; value: string } }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-primary-edge bg-background/50 text-[13.5px]">
      {rows.map((row, i) =>
        row.value.length > FIGURE_CHARS ? (
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
        <div className={cn("flex items-baseline justify-between gap-3 px-3.5 py-2 font-semibold", rows.length > 0 && "border-t border-primary-edge")}>
          <span className="min-w-0 break-words">{total.label}</span>
          <span className="shrink-0 tabular-nums">{total.value}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ActionCode({ children }: { children: ReactNode }) {
  return <pre className="max-h-48 overflow-auto rounded-2xl border border-primary-edge bg-background/50 px-3.5 py-2.5 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap">{children}</pre>;
}
