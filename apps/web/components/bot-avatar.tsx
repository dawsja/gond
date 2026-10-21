"use client";

import type { Bot } from "@gond/shared";
import { GondBot } from "@/components/hq/gond-bot";
import { useStore } from "@/components/store";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export function BotAvatar({ bot, size = 24, greet = false, className }: { bot: Pick<Bot, "name" | "title" | "color" | "expression" | "primary"> & Partial<Pick<Bot, "shape" | "avatar">>; size?: number; greet?: boolean; className?: string }) {
  const disc = Math.max(12, Math.round(size * 0.3));
  const label = `${bot.name}${bot.title ? `, ${bot.title}` : ""}${bot.primary ? ", primary bot" : ""}`;
  return (
    <span data-slot="bot-avatar" className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      {bot.avatar ? (
        <Avatar className="size-full border border-primary-edge after:hidden" role="img" aria-label={label}>
          <AvatarImage src={bot.avatar} alt="" />
          <AvatarFallback style={{ background: bot.color }} />
        </Avatar>
      ) : (
        <GondBot color={bot.color} size={size} expression={bot.expression} shape={bot.shape} greet={greet} label={label} />
      )}
      {bot.primary && size >= 24 ? (
        <span aria-hidden="true" className={cn("absolute right-0 bottom-0 flex items-center justify-center rounded-full bg-gold-coin text-gold-foreground ring-[1.5px] ring-(--surface)", disc >= 18 && "gold-coin-shine")} style={{ width: disc, height: disc }}>
          <CrownMark size={crownSize(disc)} />
        </span>
      ) : null}
    </span>
  );
}

// Even with the coin's size, odd with odd, so the crown centres on whole pixels instead of half of one.
function crownSize(disc: number) {
  const size = Math.round(disc * 0.72);
  return (disc - size) % 2 === 0 ? size : size + 1;
}

// Lucide's crown without its base line, framed on the crown's own centre, lifted half a unit since its
// weight is in the band at the bottom.
// Solid, because the badge is usually 12 px and an outline that small is a smudge. Sized inline, since a
// Button resizes any svg inside it that has no size class (the conversation header's bot pill).
function CrownMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 -1.5 24 24" style={{ width: size, height: size }} fill="currentColor" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
    </svg>
  );
}

export function YouAvatar({ size = 24, className }: { size?: number; className?: string }) {
  const { me } = useStore();
  return <PersonAvatar name={me.name} avatar={me.avatar} size={size} className={className} />;
}

export function PersonAvatar({ name, avatar, size = 24, className }: { name: string; avatar: string | null; size?: number; className?: string }) {
  return (
    <Avatar className={cn("after:hidden", className)} style={{ width: size, height: size }} aria-label={name}>
      {avatar ? <AvatarImage src={avatar} alt="" /> : null}
      <AvatarFallback className="border border-primary-edge bg-primary font-semibold text-primary-foreground" style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}>
        {name.charAt(0).toUpperCase() || "Y"}
      </AvatarFallback>
    </Avatar>
  );
}
