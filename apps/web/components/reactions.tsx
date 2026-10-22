"use client";

import { REACTIONS, type Bot, type Message, type ReactionEmoji } from "@gond/shared";
import { ContextMenuGroup, ContextMenuItem } from "@/components/ui/context-menu";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function canReact(message: Message): boolean {
  return message.kind === "message" && !["you", "system", "routine"].includes(message.author);
}

/** Puts the person's reaction on a bot's message, or takes it off when it is the one already there. */
export async function react(message: Message, emoji: ReactionEmoji, onChange: (message: Message) => void) {
  const mine = message.reactions.find((r) => r.author === "you")?.emoji;
  const next = mine === emoji ? null : emoji;
  try {
    const { reactions } = await api<{ reactions: Message["reactions"] }>(`/api/threads/${message.threadId}/messages/${message.id}/reaction`, { method: "PUT", body: JSON.stringify({ emoji: next }) });
    onChange({ ...message, reactions });
  } catch {
    toast.add({ type: "error", title: "Couldn't react to it." });
  }
}

/** The row of reactions at the top of a bot message's menu. */
export function ReactionPicker({ message, onReact }: { message: Message; onReact: (emoji: ReactionEmoji) => void }) {
  const mine = message.reactions.find((r) => r.author === "you")?.emoji;
  return (
    <ContextMenuGroup aria-label="React" className="flex justify-between gap-0.5">
      {REACTIONS.map((emoji) => (
        <ContextMenuItem
          key={emoji}
          aria-label={mine === emoji ? `Remove ${emoji}` : `React ${emoji}`}
          aria-pressed={mine === emoji}
          onClick={() => onReact(emoji)}
          className="size-8 justify-center rounded-full px-0 text-lg aria-pressed:bg-muted pointer-coarse:size-11 pointer-coarse:rounded-full pointer-coarse:px-0 pointer-coarse:text-2xl"
        >
          {emoji}
        </ContextMenuItem>
      ))}
    </ContextMenuGroup>
  );
}

/** The reactions on a bubble, pinned to its lower corner on the side away from the avatar. */
export function ReactionBadges({ message, bots, mine, onReact }: { message: Message; bots: Bot[]; mine: boolean; onReact: (emoji: ReactionEmoji) => void }) {
  if (!message.reactions.length) return null;
  return (
    <span className={cn("absolute -bottom-3 z-10 flex gap-1", mine ? "left-2" : "right-2")}>
      {message.reactions.map((reaction) => {
        const who = reaction.author === "you" ? "You" : (bots.find((b) => b.id === reaction.author)?.name ?? "A bot");
        const chip = "inline-flex h-6 min-w-7 animate-pop items-center justify-center rounded-full border border-primary-edge bg-card px-1.5 text-[13px] leading-none shadow-subtle motion-reduce:animate-none";
        return reaction.author === "you" ? (
          <button key={reaction.author} type="button" aria-label={`Remove your ${reaction.emoji}`} title="Tap to remove" onClick={() => onReact(reaction.emoji)} className={cn(chip, "outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-7")}>
            {reaction.emoji}
          </button>
        ) : (
          <span key={reaction.author} role="img" aria-label={`${who} reacted ${reaction.emoji}`} title={`${who} reacted`} className={chip}>
            {reaction.emoji}
          </span>
        );
      })}
    </span>
  );
}
