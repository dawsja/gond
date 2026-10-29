"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { rem } from "@/lib/utils";

type GondBotExpression = "happy" | "wink" | "surprised";
type GondBotShape = "cog" | "gumdrop" | "cloud" | "circle" | "triangle";

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
};

const COG =
  "M40.14 25.36 C44.29 23.64 45 17 52 17 C59 17 59.71 23.64 63.86 25.36 C68.02 27.08 73.21 22.89 78.16 27.84 C83.11 32.79 78.92 37.98 80.64 42.14 C82.36 46.29 89 47 89 54 C89 61 82.36 61.71 80.64 65.86 C78.92 70.02 83.11 75.21 78.16 80.16 C73.21 85.11 68.02 80.92 63.86 82.64 C59.71 84.36 59 91 52 91 C45 91 44.29 84.36 40.14 82.64 C35.98 80.92 30.79 85.11 25.84 80.16 C20.89 75.21 25.08 70.02 23.36 65.86 C21.64 61.71 15 61 15 54 C15 47 21.64 46.29 23.36 42.14 C25.08 37.98 20.89 32.79 25.84 27.84 C30.79 22.89 35.98 27.08 40.14 25.36 Z";

// Other bodies for the same eyes, drawn in the cog's box (centred on x 52) so every shape sits the same size.
const BODIES: Record<Exclude<GondBotShape, "cog">, string> = {
  gumdrop: "M52 19 C73 19 86.5 41 88 66 C89 82 82.5 88.5 71 89.2 C58 90.2 46 90.2 33 89.2 C21.5 88.5 15 82 16 66 C17.5 41 31 19 52 19 Z",
  cloud: "M29 79 A17 17 0 0 1 26.46 45.19 A3 3 0 0 0 29.01 42.32 A21 21 0 0 1 70.55 38.67 A3 3 0 0 0 73.28 41.04 A19 19 0 0 1 72 79 Z",
  circle: "M18 54 A34 34 0 1 1 86 54 A34 34 0 1 1 18 54 Z",
  triangle: "M58.53 26.38 L83.47 73.62 Q90 86 76 86 L28 86 Q14 86 20.53 73.62 L45.47 26.38 Q52 14 58.53 26.38 Z",
};

export function GondBot({
  color = "#189C47",
  size = 200,
  expression = "happy",
  shape = "cog",
  greet = true,
  tilt = 0,
  label = "Gond bot saying hello",
  asleep = false,
}: GondBotProps) {
  const [blink, setBlink] = useState(false);
  const [hello, setHello] = useState<"bounce" | "spin" | null>(greet && !asleep ? "bounce" : null);
  const [look, setLook] = useState({ x: 0, y: 0 });

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
    if (asleep) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => {
        setLook({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 3 });
        setTimeout(() => setLook({ x: 0, y: 0 }), 900);
        loop();
      }, 3500 + Math.random() * 4000);
    };
    loop();
    return () => clearTimeout(t);
  }, [asleep]);

  useEffect(() => {
    if (!hello) return;
    const t = setTimeout(() => setHello(null), 1300);
    return () => clearTimeout(t);
  }, [hello]);

  const sayHello = () => !asleep && setHello(shape === "cog" && Math.random() < 0.5 ? "spin" : "bounce");

  const eye = ({ cx, cy, lid }: { cx: number; cy: number; lid: boolean }) =>
    asleep ? (
      <path d={`M${cx - 6} ${cy} q6 4 12 0`} stroke="#fff" strokeWidth="3.2" fill="none" strokeLinecap="round" />
    ) : lid ? (
      <path d={`M${cx - 6} ${cy} q6 -5 12 0`} stroke="#fff" strokeWidth="3.2" fill="none" strokeLinecap="round" />
    ) : expression === "surprised" ? (
      <circle cx={cx} cy={cy} r="6.5" fill="#fff" />
    ) : (
      <rect x={cx - 3.7} y={cy - 9} width="7.4" height="18" rx="3.7" fill="#fff" transform={`rotate(-16 ${cx} ${cy})`} />
    );

  return (
    <div
      className={`gb${hello ? ` gb-${hello}` : ""}${asleep ? " gb-asleep" : ""}`}
      style={{ width: rem(size), height: rem(size), "--tilt": `${tilt}deg` } as CSSProperties}
      onClick={sayHello}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 100 100" className="gb-svg">
        <g className="gb-body">
          <g className="gb-shape">
            <g className="gb-cog">
              <path d={shape === "cog" ? COG : (BODIES[shape] ?? COG)} fill={color} stroke={color} strokeWidth="5" strokeLinejoin="round" />
            </g>
          </g>

          <g className="gb-face" style={{ transform: asleep ? undefined : `translate(${look.x}px, ${look.y}px)` }}>
            <g className={`gb-eye${blink ? " gb-blink" : ""}`}>{eye({ cx: 44, cy: 56.5, lid: false })}</g>
            <g className={`gb-eye${blink ? " gb-blink" : ""}`}>{eye({ cx: 60.5, cy: 53, lid: expression === "wink" })}</g>
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
        .gb-bounce .gb-body { animation: gb-hello 1.3s cubic-bezier(.34,1.56,.64,1) 1; }
        .gb-shape { transform-box:fill-box; transform-origin:50% 90%; transform: rotate(var(--tilt)); }
        .gb-cog { transform-box:fill-box; transform-origin:50% 50%; }
        .gb-spin .gb-cog { animation: gb-spin 1.2s cubic-bezier(.3,.9,.2,1) 1; }
        .gb-face { transition: transform .5s cubic-bezier(.2,.8,.2,1); }
        .gb-eye { transform-box:fill-box; transform-origin:center; }
        .gb-blink { animation: gb-blink .15s ease-in-out; }

        .gb-asleep .gb-body { animation: gb-breathe 4.8s ease-in-out infinite; }
        .gb-z { opacity:0; animation: gb-z 3.6s ease-out infinite; }
        .gb-z:nth-child(2) { animation-delay: 1.2s; }
        .gb-z:nth-child(3) { animation-delay: 2.4s; }

        @keyframes gb-breathe { 0%,100%{transform:scale(1,1) rotate(-3deg)} 50%{transform:scale(1.03,.97) rotate(-3deg) translateY(1px)} }
        @keyframes gb-z { 0%{opacity:0; transform:translate(-4px,6px)} 25%{opacity:.9} 100%{opacity:0; transform:translate(4px,-6px)} }
        @keyframes gb-rock { 0%,100%{transform:scale(1,1) rotate(0)} 30%{transform:scale(.99,1.02) rotate(-2deg)} 65%{transform:scale(1.02,.99) rotate(2deg)} }
        @keyframes gb-hello {
          0%{transform:scale(1) rotate(0)}
          25%{transform:scale(1.12,.9) rotate(-8deg) translateY(2px)}
          50%{transform:scale(.94,1.08) rotate(8deg) translateY(-6px)}
          75%{transform:scale(1.04,.98) rotate(-3deg)}
          100%{transform:scale(1) rotate(0)}
        }
        @keyframes gb-spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
        @keyframes gb-blink { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(.08)} }
        @media (prefers-reduced-motion: reduce) { .gb-body,.gb-cog,.gb-blink,.gb-z{animation:none!important} .gb-z{opacity:.8} }
      `}</style>
    </div>
  );
}
