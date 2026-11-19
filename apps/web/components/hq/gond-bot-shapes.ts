// The mascot's geometry in its 100 by 100 box. The app draws it in 3D (gond-bot.tsx) and scripts/brand.ts
// draws every icon from it flat, so the two can't drift. No imports: the brand script reads it as is.

export type GondBotShape = "cog" | "gumdrop" | "cloud" | "circle" | "triangle";

export const COG =
  "M40.14 25.36 C44.29 23.64 45 17 52 17 C59 17 59.71 23.64 63.86 25.36 C68.02 27.08 73.21 22.89 78.16 27.84 C83.11 32.79 78.92 37.98 80.64 42.14 C82.36 46.29 89 47 89 54 C89 61 82.36 61.71 80.64 65.86 C78.92 70.02 83.11 75.21 78.16 80.16 C73.21 85.11 68.02 80.92 63.86 82.64 C59.71 84.36 59 91 52 91 C45 91 44.29 84.36 40.14 82.64 C35.98 80.92 30.79 85.11 25.84 80.16 C20.89 75.21 25.08 70.02 23.36 65.86 C21.64 61.71 15 61 15 54 C15 47 21.64 46.29 23.36 42.14 C25.08 37.98 20.89 32.79 25.84 27.84 C30.79 22.89 35.98 27.08 40.14 25.36 Z";

// Other bodies for the same eyes, drawn in the cog's box (centred on x 52) so every shape sits the same size.
export const BODIES: Record<Exclude<GondBotShape, "cog">, string> = {
  gumdrop: "M52 19 C73 19 86.5 41 88 66 C89 82 82.5 88.5 71 89.2 C58 90.2 46 90.2 33 89.2 C21.5 88.5 15 82 16 66 C17.5 41 31 19 52 19 Z",
  cloud: "M29 79 A17 17 0 0 1 26.46 45.19 A3 3 0 0 0 29.01 42.32 A21 21 0 0 1 70.55 38.67 A3 3 0 0 0 73.28 41.04 A19 19 0 0 1 72 79 Z",
  circle: "M18 54 A34 34 0 1 1 86 54 A34 34 0 1 1 18 54 Z",
  triangle: "M58.53 26.38 L83.47 73.62 Q90 86 76 86 L28 86 Q14 86 20.53 73.62 L45.47 26.38 Q52 14 58.53 26.38 Z",
};

/** A body is stroked in its own fill this wide with round joins, which is what rounds its corners. */
export const BODY_STROKE = 5;

/** Each eye is a pill tilted by `turn` degrees about its centre. */
export const EYE = { width: 7.4, height: 18, turn: -16 } as const;
export const EYES = [
  { x: 44, y: 56.5 },
  { x: 60.5, y: 53 },
] as const;
