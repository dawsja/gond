"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";
import { BODIES, BODY_STROKE, COG, EYE, EYES, type GondBotShape } from "@/components/hq/gond-bot-shapes";
import { rem } from "@/lib/utils";

type GondBotExpression = "happy" | "wink" | "surprised";
/** What the bot is doing right now, set by Gond and never stored: working, on a call, or pleased for a moment. */
export type GondBotMood = "thinking" | "talking" | "glad";

type GondBotProps = {
  color?: string;
  size?: number;
  expression?: GondBotExpression;
  shape?: GondBotShape;
  greet?: boolean;
  tilt?: number;
  label?: string;
  // Eyes shut, slow breaths and a drift of z's; no blinking, glancing or hello.
  asleep?: boolean;
  mood?: GondBotMood;
};

// Every shade comes from the bot's one colour, so the picker and what's stored stay a single hex.
function mix(a: string, b: string, t: number) {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) * (1 - t) + channel(b, i) * t));
  return `#${out.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function shadesOf(color: string) {
  const base = /^#[0-9a-f]{6}$/i.test(color) ? color : "#189C47";
  return {
    base,
    top: mix(base, "#ffffff", 0.3),
    bottom: mix(base, "#000000", 0.36),
    rimLight: mix(base, "#ffffff", 0.75),
    rimDark: mix(base, "#000000", 0.62),
    visorTop: mix(base, "#0a0b0d", 0.84),
    visorBottom: mix(base, "#050506", 0.94),
    eye: mix(base, "#ffffff", 0.88),
    glow: mix(base, "#ffffff", 0.4),
  };
}

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0 Z`;

// The cog keeps a still hub in front of its teeth, so only the teeth turn and the light never turns with them.
const HUB = circle(52, 54, 31);

// Where each body's visor sits (its own outline shrunk about a point, or a disc) and how the face fits in it.
const LAYOUT: Record<GondBotShape, { visor: string; at: [number, number]; scale: number; face: { x: number; y: number; scale: number } }> = {
  cog: { visor: circle(52, 54, 24), at: [52, 54], scale: 1, face: { x: 0, y: -1, scale: 0.92 } },
  circle: { visor: circle(52, 54, 25.5), at: [52, 54], scale: 1, face: { x: 0, y: -1, scale: 0.95 } },
  gumdrop: { visor: BODIES.gumdrop, at: [52, 61], scale: 0.7, face: { x: 0, y: 2.5, scale: 0.95 } },
  cloud: { visor: BODIES.cloud, at: [51, 60], scale: 0.7, face: { x: -0.5, y: 2.5, scale: 0.86 } },
  triangle: { visor: BODIES.triangle, at: [52, 67], scale: 0.66, face: { x: 0, y: 9, scale: 0.76 } },
};

const FACE_AT = { x: 52.25, y: 58 };

export function GondBot({
  color = "#189C47",
  size = 200,
  expression = "happy",
  shape = "cog",
  greet = true,
  tilt = 0,
  label = "Gond bot saying hello",
  asleep = false,
  mood,
}: GondBotProps) {
  const [blink, setBlink] = useState(false);
  const [hello, setHello] = useState<"bounce" | "spin" | null>(greet && !asleep ? "bounce" : null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ref = (name: string) => `gb${id}-${name}`;
  const url = (name: string) => `url(#${ref(name)})`;
  const now = asleep ? undefined : mood;
  // The glow, sheen and catch-lights blur into mud below this, and each glow is a filter.
  const fine = size >= 40;

  useEffect(() => {
    if (asleep) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => {
        setBlink(true);
        setTimeout(() => setBlink(false), 150);
        loop();
      }, 2400 + Math.random() * 2800);
    };
    loop();
    return () => clearTimeout(t);
  }, [asleep]);

  useEffect(() => {
    if (asleep || now) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => {
        setLook({ x: (Math.random() - 0.5) * 5, y: (Math.random() - 0.5) * 3.5 });
        setTimeout(() => setLook({ x: 0, y: 0 }), 900);
        loop();
      }, 3500 + Math.random() * 4000);
    };
    loop();
    return () => clearTimeout(t);
  }, [asleep, now]);

  useEffect(() => {
    if (!hello) return;
    const t = setTimeout(() => setHello(null), 1300);
    return () => clearTimeout(t);
  }, [hello]);

  const sayHello = () => !asleep && setHello(shape === "cog" && Math.random() < 0.5 ? "spin" : "bounce");

  const tone = shadesOf(color);
  const layout = LAYOUT[shape] ?? LAYOUT.cog;
  const body = shape === "cog" ? COG : (BODIES[shape] ?? COG);
  const visorTransform = layout.scale === 1 ? undefined : `translate(${layout.at[0]} ${layout.at[1]}) scale(${layout.scale}) translate(${-layout.at[0]} ${-layout.at[1]})`;
  const faceTransform = `translate(${layout.face.x} ${layout.face.y}) translate(${FACE_AT.x} ${FACE_AT.y}) scale(${layout.face.scale}) translate(${-FACE_AT.x} ${-FACE_AT.y})`;
  const glow = fine ? url("glow") : undefined;

  const eye = (cx: number, cy: number, wink: boolean) => {
    const line = { stroke: tone.eye, strokeWidth: 3.4, fill: "none", strokeLinecap: "round" as const };
    if (asleep) return <path d={`M${cx - 6} ${cy} q6 4.5 12 0`} {...line} />;
    // Glad arcs lean with the line between the eyes, so the smile sits level with the face.
    if (now === "glad") return <path d={`M${cx - 6} ${cy + 3} q6 -11 12 0`} {...line} strokeWidth={3.8} transform={`rotate(-12 ${cx} ${cy})`} />;
    if (wink) return <path d={`M${cx - 6} ${cy} q6 -5 12 0`} {...line} />;
    if (expression === "surprised")
      return (
        <>
          <circle cx={cx} cy={cy} r="6" fill={tone.eye} />
          {fine ? <circle cx={cx - 2} cy={cy - 2.2} r="1.5" fill="#fff" opacity="0.75" /> : null}
        </>
      );
    return (
      <g transform={`rotate(${EYE.turn} ${cx} ${cy})`}>
        <rect x={cx - EYE.width / 2} y={cy - EYE.height / 2} width={EYE.width} height={EYE.height} rx={EYE.width / 2} fill={tone.eye} />
        {fine ? <circle cx={cx - 1.2} cy={cy - 5} r="1.3" fill="#fff" opacity="0.7" /> : null}
      </g>
    );
  };

  return (
    <div
      className={`gb${hello ? ` gb-${hello}` : ""}${asleep ? " gb-asleep" : ""}${now ? ` gb-${now}` : ""}${shape === "cog" ? " gb-gear" : ""}`}
      style={{ width: rem(size), height: rem(size), "--tilt": `${tilt}deg` } as CSSProperties}
      onClick={sayHello}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 100 100" className="gb-svg">
        <defs>
          <linearGradient id={ref("body")} x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%" stopColor={tone.top} />
            <stop offset="55%" stopColor={tone.base} />
            <stop offset="100%" stopColor={tone.bottom} />
          </linearGradient>
          <linearGradient id={ref("rim")} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={tone.rimLight} stopOpacity="0.9" />
            <stop offset="45%" stopColor={tone.base} stopOpacity="0" />
            <stop offset="100%" stopColor={tone.rimDark} stopOpacity="0.9" />
          </linearGradient>
          <radialGradient id={ref("shine")} cx="32%" cy="18%" r="62%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={ref("visor")} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={tone.visorTop} />
            <stop offset="100%" stopColor={tone.visorBottom} />
          </linearGradient>
          <radialGradient id={ref("aura")} cx="50%" cy="48%" r="55%">
            <stop offset="0%" stopColor={tone.glow} stopOpacity="0.26" />
            <stop offset="100%" stopColor={tone.glow} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={ref("sheen")} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={ref("visor-clip")}>
            <path d={layout.visor} transform={visorTransform} />
          </clipPath>
          {fine ? (
            // The eyes' own outline blurred and filled with the bot's light shade: a glow in its colour.
            <filter id={ref("glow")} x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="1.8" result="blur" />
              <feFlood floodColor={tone.glow} floodOpacity="0.9" />
              <feComposite in2="blur" operator="in" result="halo" />
              <feMerge>
                <feMergeNode in="halo" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          ) : null}
        </defs>

        <g className="gb-body">
          <g className="gb-shape">
            <g className="gb-turn">
              <path d={body} fill="none" stroke={url("rim")} strokeWidth={BODY_STROKE + 1.6} strokeLinejoin="round" />
              <path d={body} fill={url("body")} stroke={url("body")} strokeWidth={BODY_STROKE} strokeLinejoin="round" />
            </g>
            {shape === "cog" ? (
              <>
                <path d={HUB} fill="none" stroke={tone.rimDark} strokeOpacity="0.35" strokeWidth="1.6" />
                <path d={HUB} fill={url("body")} />
              </>
            ) : null}
            {fine ? <path d={shape === "cog" ? HUB : body} fill={url("shine")} stroke={shape === "cog" ? "none" : url("shine")} strokeWidth={BODY_STROKE} strokeLinejoin="round" /> : null}

            <path d={layout.visor} transform={visorTransform} fill="none" stroke="#000" strokeOpacity="0.32" strokeWidth={2.4 / layout.scale} />
            <path d={layout.visor} transform={visorTransform} fill={url("visor")} />

            <g clipPath={url("visor-clip")}>
              {fine ? <rect x="0" y="0" width="100" height="100" fill={url("aura")} /> : null}
              <g transform={faceTransform}>
                <g className="gb-face" style={{ transform: asleep || now ? undefined : `translate(${look.x}px, ${look.y}px)` }}>
                  {now === "thinking" ? (
                    <g filter={glow}>
                      {[42, 52.25, 62.5].map((cx, i) => (
                        <circle key={cx} className="gb-dot" cx={cx} cy="55" r="3.6" fill={tone.eye} style={{ animationDelay: `${i * 0.16}s` }} />
                      ))}
                    </g>
                  ) : (
                    <g filter={glow}>
                      <g className={`gb-eye${blink ? " gb-blink" : ""}`}>{eye(EYES[0].x, EYES[0].y, false)}</g>
                      <g className={`gb-eye${blink ? " gb-blink" : ""}`}>{eye(EYES[1].x, EYES[1].y, expression === "wink")}</g>
                    </g>
                  )}
                  {now === "glad" ? (
                    <path d="M47 69 q5.5 5 11 0" stroke={tone.glow} strokeWidth="2.6" fill="none" strokeLinecap="round" filter={glow} />
                  ) : asleep ? null : (
                    <rect className="gb-mouth" x="49" y="68.2" width="7.5" height="2.6" rx="1.3" fill={tone.glow} opacity="0.85" filter={glow} />
                  )}
                </g>
              </g>
              {fine ? <path d="M20 20 L58 20 L36 90 L20 90 Z" fill={url("sheen")} /> : null}
            </g>
          </g>
        </g>

        {asleep ? (
          <g className="gb-zs" fill="currentColor" fontWeight="700" fontFamily="inherit">
            <text className="gb-z" x="74" y="32" fontSize="13">z</text>
            <text className="gb-z" x="84" y="18" fontSize="17">Z</text>
            <text className="gb-z" x="95" y="2" fontSize="21">Z</text>
          </g>
        ) : null}
      </svg>

      <style>{`
        .gb { display:inline-block; cursor:pointer; user-select:none; }
        .gb-svg { width:100%; height:100%; overflow:visible; }
        .gb-body { transform-box:fill-box; transform-origin:50% 90%; animation: gb-rock 2.6s ease-in-out infinite; }
        .gb-shape { transform-box:fill-box; transform-origin:50% 90%; transform: rotate(var(--tilt)); }
        .gb-turn { transform-box:fill-box; transform-origin:50% 50%; }
        .gb-face { transition: transform .5s cubic-bezier(.2,.8,.2,1); }
        .gb-eye { transform-box:fill-box; transform-origin:center; }
        .gb-blink { animation: gb-blink .15s ease-in-out; }
        .gb-mouth { transform-box:fill-box; transform-origin:center; }
        .gb-dot { transform-box:fill-box; transform-origin:center; animation: gb-dot 1s ease-in-out infinite; }

        .gb-thinking .gb-body { animation: gb-hover 2.8s ease-in-out infinite; }
        .gb-thinking.gb-gear .gb-turn { animation: gb-spin 9s linear infinite; }
        .gb-talking .gb-body { animation: gb-nod 1.1s ease-in-out infinite; }
        .gb-talking .gb-mouth { animation: gb-talk .55s ease-in-out infinite; }
        .gb-glad .gb-body { animation: gb-hop 1.4s cubic-bezier(.34,1.56,.64,1) infinite; }

        .gb-bounce .gb-body { animation: gb-hello 1.3s cubic-bezier(.34,1.56,.64,1) 1; }
        .gb-spin .gb-turn { animation: gb-spin 1.2s cubic-bezier(.3,.9,.2,1) 1; }

        .gb-asleep .gb-body { animation: gb-breathe 4.8s ease-in-out infinite; }
        .gb-z { opacity:0; animation: gb-z 3.6s ease-out infinite; }
        .gb-z:nth-child(2) { animation-delay: 1.2s; }
        .gb-z:nth-child(3) { animation-delay: 2.4s; }

        @keyframes gb-breathe { 0%,100%{transform:scale(1,1) rotate(-3deg)} 50%{transform:scale(1.03,.97) rotate(-3deg) translateY(1px)} }
        @keyframes gb-z { 0%{opacity:0; transform:translate(-4px,6px)} 25%{opacity:.9} 100%{opacity:0; transform:translate(4px,-6px)} }
        @keyframes gb-rock { 0%,100%{transform:scale(1,1) rotate(0)} 30%{transform:scale(.99,1.02) rotate(-2deg)} 65%{transform:scale(1.02,.99) rotate(2deg)} }
        @keyframes gb-hover { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-2.5px)} }
        @keyframes gb-dot { 0%,60%,100%{transform:translateY(0) scale(1)} 30%{transform:translateY(-4px) scale(1.15)} }
        @keyframes gb-nod { 0%,100%{transform:translateY(0) rotate(0)} 25%{transform:translateY(-2px) rotate(-1.5deg)} 60%{transform:translateY(-1px) rotate(1deg)} }
        @keyframes gb-talk { 0%,100%{transform:scale(1,1)} 50%{transform:scale(1.5,2.6)} }
        @keyframes gb-hop { 0%,60%,100%{transform:translateY(0) scale(1,1)} 12%{transform:translateY(1px) scale(1.08,.92)} 30%{transform:translateY(-7px) scale(.95,1.06)} 45%{transform:translateY(0) scale(1.04,.96)} }
        @keyframes gb-hello {
          0%{transform:scale(1) rotate(0)}
          25%{transform:scale(1.12,.9) rotate(-8deg) translateY(2px)}
          50%{transform:scale(.94,1.08) rotate(8deg) translateY(-6px)}
          75%{transform:scale(1.04,.98) rotate(-3deg)}
          100%{transform:scale(1) rotate(0)}
        }
        @keyframes gb-spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
        @keyframes gb-blink { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(.08)} }
        @media (prefers-reduced-motion: reduce) { .gb-body,.gb-turn,.gb-blink,.gb-z,.gb-dot,.gb-mouth{animation:none!important} .gb-z{opacity:.8} }
      `}</style>
    </div>
  );
}
