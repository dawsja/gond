"use client";

import type { Bot } from "@gond/shared";
import { Globe, Users } from "lucide-react";
import { GondBot } from "@/components/hq/gond-bot";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, rem } from "@/lib/utils";

export function BotAvatar({ bot, size = 24, greet = false, className, style }: { bot: Pick<Bot, "name" | "title" | "color" | "expression" | "primary"> & Partial<Pick<Bot, "shape" | "avatar">>; size?: number; greet?: boolean; className?: string; style?: React.CSSProperties }) {
  const disc = Math.max(12, Math.round(size * 0.3));
  const label = `${bot.name}${bot.title ? `, ${bot.title}` : ""}${bot.primary ? ", primary bot" : ""}`;
  return (
    <span data-slot="bot-avatar" className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: rem(size), height: rem(size), ...style }}>
      {bot.avatar ? (
        <Avatar className="size-full border border-primary-edge after:hidden" role="img" aria-label={label}>
          <AvatarImage src={bot.avatar} alt="" />
          <AvatarFallback style={{ background: bot.color }} />
        </Avatar>
      ) : (
        <GondBot color={bot.color} size={size} expression={bot.expression} shape={bot.shape} greet={greet} label={label} />
      )}
      {bot.primary && size >= 24 ? (
        <span aria-hidden="true" className={cn("absolute right-0 bottom-0 flex items-center justify-center rounded-full bg-gold-coin text-gold-foreground ring-[1.5px] ring-(--surface)", disc >= 18 && "gold-coin-shine")} style={{ width: rem(disc), height: rem(disc) }}>
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
    <svg viewBox="0 -1.5 24 24" style={{ width: rem(size), height: rem(size) }} fill="currentColor" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
    </svg>
  );
}

export function PersonAvatar({ name, avatar, size = 24, className }: { name: string; avatar: string | null; size?: number; className?: string }) {
  return (
    <Avatar className={cn("after:hidden", className)} style={{ width: rem(size), height: rem(size) }} aria-label={name}>
      {avatar ? <AvatarImage src={avatar} alt="" /> : null}
      <AvatarFallback className="border border-primary-edge bg-primary font-semibold text-primary-foreground" style={{ fontSize: rem(Math.max(10, Math.round(size * 0.4))) }}>
        {name.charAt(0).toUpperCase() || "Y"}
      </AvatarFallback>
    </Avatar>
  );
}

type Face = Parameters<typeof BotAvatar>[0]["bot"];

/** A room's bots as they show: in the room's order, without the hidden ones. */
export function roomMembers(thread: { members: string[] }, bots: Bot[]): Bot[] {
  return thread.members.flatMap((id) => bots.find((bot) => bot.id === id && !bot.hidden) ?? []);
}

/**
 * A room as its bots: two faces on the diagonal, the one that answers when nobody's named in
 * front, cut out of the back one by a ring of whatever it sits on (`--surface`), and a pill with
 * how many more there are. Too small for two to read, it shows the front one alone. A space wears
 * an ink globe on its top corner, where neither face sits, so it never reads as a room.
 */
export function RoomAvatar({ bots, size = 40, space = false, className }: { bots: Face[]; size?: number; space?: boolean; className?: string }) {
  if (!space || size < 28) return <RoomFaces bots={bots} size={size} className={className} />;
  const chip = Math.round(size * 0.42);
  const lift = Math.round(size / 16);
  return (
    <span data-slot="space-avatar" className={cn("relative inline-block shrink-0", className)} style={{ width: rem(size), height: rem(size) }}>
      <RoomFaces bots={bots} size={size} className="absolute top-0 left-0" />
      <span role="img" aria-label="Space" className="absolute flex items-center justify-center rounded-full bg-control text-control-foreground ring-2 ring-(--surface)" style={{ width: rem(chip), height: rem(chip), top: rem(-lift), right: rem(-lift) }}>
        <Globe strokeWidth={2.25} style={{ width: rem(Math.round(chip * 0.6)), height: rem(Math.round(chip * 0.6)) }} aria-hidden="true" />
      </span>
    </span>
  );
}

function RoomFaces({ bots, size, className }: { bots: Face[]; size: number; className?: string }) {
  const [front, back] = [...bots].sort((a, b) => Number(b.primary) - Number(a.primary)).map((bot) => ({ ...bot, primary: false }));
  if (!front) return <RoomIcon size={size} className={className} />;
  if (!back || size < 28) return <BotAvatar bot={front} size={size} className={className} />;
  const face = Math.round(size * 0.68);
  const cut = Math.max(2, Math.round(size / 24));
  const more = bots.length - 2;
  const chip = Math.round(size * 0.36);
  return (
    <span data-slot="room-avatar" role="img" aria-label={bots.map((bot) => bot.name).join(", ")} className={cn("relative inline-block shrink-0", className)} style={{ width: rem(size), height: rem(size) }}>
      <BotAvatar bot={back} size={face} className="absolute top-0 left-0" />
      <span className="absolute rounded-full bg-(--surface)" style={{ padding: rem(cut), right: rem(-cut), bottom: rem(-cut) }}>
        <BotAvatar bot={front} size={face} className="block" />
      </span>
      {more > 0 ? (
        <span aria-hidden="true" className="absolute -bottom-0.5 -left-0.5 flex items-center justify-center rounded-full border border-primary-edge bg-primary font-semibold text-primary-foreground tabular-nums ring-2 ring-(--surface)" style={{ height: rem(chip), minWidth: rem(chip), paddingInline: rem(Math.round(size * 0.06)), fontSize: rem(Math.max(9, Math.round(size * 0.2))) }}>
          +{more}
        </span>
      ) : null}
    </span>
  );
}

function RoomIcon({ size, className }: { size: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-primary-edge bg-primary text-muted-foreground", className)} style={{ width: rem(size), height: rem(size) }}>
      <Users style={{ width: rem(size * 0.4), height: rem(size * 0.4) }} aria-hidden="true" />
    </span>
  );
}
