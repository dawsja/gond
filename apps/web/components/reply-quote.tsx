"use client";

import type { Quote } from "@gond/shared";
import { CornerUpLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The quoted message: a bar in its author's colour, their name and its first words. */
function Quoted({ name, color, text, className }: { name: string; color: string | null; text: string; className?: string }) {
  return (
    <span className={cn("flex min-w-0 gap-2.5 rounded-xl bg-bubble-inset py-1.5 pr-3 pl-2 text-left", className)}>
      <span aria-hidden="true" className={cn("w-[3px] shrink-0 rounded-full", !color && "bg-tint-solid")} style={color ? { background: color } : undefined} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[12.5px] leading-4 font-semibold">{name}</span>
        <span className="line-clamp-2 text-[12.5px] leading-4 wrap-anywhere text-muted-foreground">{text || "A message"}</span>
      </span>
    </span>
  );
}

/** At the top of a reply's bubble; a tap goes to the message it answers. */
export function QuoteInBubble({ quote, name, color, onJump }: { quote: Quote; name: string; color: string | null; onJump: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onJump(quote.id)} aria-label={`Replying to ${name}: ${quote.text}. Go to it`} className="-mx-1.5 mb-1 block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <Quoted name={name} color={color} text={quote.text} />
    </button>
  );
}

/** Above the composer while the person is replying to a message. */
export function ReplyingTo({ name, color, text, onCancel }: { name: string; color: string | null; text: string; onCancel: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-3xl border border-primary-edge bg-card p-1.5 pl-3">
      <CornerUpLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Quoted name={name} color={color} text={text} className="flex-1" />
      <Button type="button" variant="ghost" size="icon-lg" aria-label="Don't reply to it" onClick={onCancel} className="shrink-0 rounded-full pointer-coarse:size-11">
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
