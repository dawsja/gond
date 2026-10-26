"use client";

import { IMAGE_SHAPES, type Bot, type ImageAspect } from "@gond/shared";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** A picture that has just landed: the squares fall away over it once, in its bot's shades. */
export type PictureReveal = { file: string; aspect: ImageAspect; color: string };

// The bot's own colour from pale to deep: a square rests in a softer one and swells into a stronger one, so the frame is never one flat tint.
const RESTING = [
  "color-mix(in oklch, var(--bot) 30%, var(--bubble-bot))",
  "color-mix(in oklch, var(--bot) 42%, var(--bubble-bot))",
  "color-mix(in oklch, var(--bot) 55%, var(--bubble-bot))",
  "color-mix(in oklch, var(--bot) 68%, var(--bubble-bot))",
];
const LIT = [
  "var(--bot)",
  "color-mix(in oklch, var(--bot) 70%, white)",
  "color-mix(in oklch, var(--bot) 72%, black)",
  "color-mix(in oklch, var(--bot) 50%, white)",
  "color-mix(in oklch, var(--bot) 52%, black)",
  "color-mix(in oklch, var(--bot) 85%, white)",
  "color-mix(in oklch, var(--bot) 86%, black)",
  "color-mix(in oklch, var(--bot) 35%, white)",
];

// The same sizes a posted picture is drawn at (`max-w-80 max-h-90` in the conversation), so one takes the other's place.
const FRAME: Record<ImageAspect, string> = {
  square: "w-80 aspect-square",
  portrait: "w-60 aspect-[2/3]",
  landscape: "w-80 aspect-[3/2]",
};

function shades(color: string): CSSProperties {
  return {
    "--bot": color,
    "--wash": "color-mix(in oklch, var(--bot) 22%, var(--bubble-bot))",
  } as CSSProperties;
}

function Squares({ aspect, falling = false, faint = false }: { aspect: ImageAspect; falling?: boolean; faint?: boolean }) {
  const { columns, rows } = IMAGE_SHAPES[aspect];
  return (
    <div
      aria-hidden="true"
      className={cn("absolute inset-0 grid", falling ? "pointer-events-none" : "gap-[5px] p-2.5", faint && "opacity-55")}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: columns * rows }, (_, i) => {
        const row = Math.floor(i / columns);
        const column = i % columns;
        return (
          <span
            key={i}
            className={falling ? "animate-picture-fall bg-(--wash) motion-reduce:hidden" : "animate-picture-light rounded-md bg-(--rest) motion-reduce:animate-none"}
            style={{
              ["--rest" as string]: RESTING[(row * 5 + column * 3) % RESTING.length],
              ["--lit" as string]: LIT[(row * 3 + column * 7) % LIT.length],
              animationDelay: `${(row + column) * (falling ? 0.04 : 0.12)}s`,
              ...(falling ? {} : { animationDuration: `${2.2 + ((row * 7 + column * 3) % 5) * 0.2}s` }),
            }}
          />
        );
      })}
    </div>
  );
}

/** A picture a bot is making: a frame its shape, lit in a wave of the bot's shades, over any rough preview so far. */
export function PictureMaking({ bot, aspect, preview }: { bot: Bot | undefined; aspect: ImageAspect; preview: string | null }) {
  const line = `${bot?.name ?? "A bot"} is making a picture`;
  return (
    <div className="flex flex-col gap-1.5">
      <div role="img" aria-label={line} className={cn("relative max-w-full overflow-hidden rounded-3xl bg-(--wash)", FRAME[aspect])} style={shades(bot?.color ?? "var(--muted-foreground)")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview ? <img src={preview} alt="" className="absolute inset-0 size-full object-cover" /> : null}
        <Squares aspect={aspect} faint={Boolean(preview)} />
      </div>
      <span className="pl-1 text-xs text-muted-foreground">{line}</span>
    </div>
  );
}

/** Laid over a posted picture the moment it lands. */
export function PictureFall({ reveal }: { reveal: PictureReveal }) {
  return (
    <div className="pointer-events-none absolute inset-0" style={shades(reveal.color)}>
      <Squares aspect={reveal.aspect} falling />
    </div>
  );
}
