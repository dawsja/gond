// The mascot's geometry in its 100 by 100 box. The app draws it in 3D (gond-bot.tsx) and scripts/brand.ts
// draws every icon from it flat, so the two can't drift. No imports: the brand script reads it as is.

export type GondBotShape = "cog" | "cloud" | "circle" | "triangle" | "tile" | "gem" | "star" | "drop";

export const COG =
  "M40.14 25.36 C44.29 23.64 45 17 52 17 C59 17 59.71 23.64 63.86 25.36 C68.02 27.08 73.21 22.89 78.16 27.84 C83.11 32.79 78.92 37.98 80.64 42.14 C82.36 46.29 89 47 89 54 C89 61 82.36 61.71 80.64 65.86 C78.92 70.02 83.11 75.21 78.16 80.16 C73.21 85.11 68.02 80.92 63.86 82.64 C59.71 84.36 59 91 52 91 C45 91 44.29 84.36 40.14 82.64 C35.98 80.92 30.79 85.11 25.84 80.16 C20.89 75.21 25.08 70.02 23.36 65.86 C21.64 61.71 15 61 15 54 C15 47 21.64 46.29 23.36 42.14 C25.08 37.98 20.89 32.79 25.84 27.84 C30.79 22.89 35.98 27.08 40.14 25.36 Z";

// Other bodies for the same eyes, drawn in the cog's box (centred on x 52) so every shape sits the same size.
export const BODIES: Record<Exclude<GondBotShape, "cog">, string> = {
  cloud: "M29 79 A17 17 0 0 1 26.46 45.19 A3 3 0 0 0 29.01 42.32 A21 21 0 0 1 70.55 38.67 A3 3 0 0 0 73.28 41.04 A19 19 0 0 1 72 79 Z",
  circle: "M18 54 A34 34 0 1 1 86 54 A34 34 0 1 1 18 54 Z",
  triangle: "M58.53 26.38 L83.47 73.62 Q90 86 76 86 L28 86 Q14 86 20.53 73.62 L45.47 26.38 Q52 14 58.53 26.38 Z",
  tile: "M44.5 20.5 L59.5 20.5 C80.82 20.5 85.5 25.18 85.5 46.5 L85.5 61.5 C85.5 82.82 80.82 87.5 59.5 87.5 L44.5 87.5 C23.18 87.5 18.5 82.82 18.5 61.5 L18.5 46.5 C18.5 25.18 23.18 20.5 44.5 20.5 Z",
  gem: "M40 22 L64 22 Q69 22 72.44 25.62 L83.87 37.65 Q88 42 84.35 46.76 L56.86 82.65 Q52 89 47.14 82.65 L19.65 46.76 Q16 42 20.13 37.65 L31.56 25.62 Q35 22 40 22 Z",
  star: "M55.77 23.9 L62.77 34.83 Q64.93 38.2 68.8 39.21 L81.37 42.49 Q88.14 44.26 83.7 49.67 L75.46 59.71 Q72.92 62.8 73.16 66.79 L73.92 79.75 Q74.34 86.74 67.82 84.19 L55.72 79.46 Q52 78 48.28 79.46 L36.18 84.19 Q29.66 86.74 30.08 79.75 L30.84 66.79 Q31.08 62.8 28.54 59.71 L20.3 49.67 Q15.86 44.26 22.63 42.49 L35.2 39.21 Q39.07 38.2 41.23 34.83 L48.23 23.9 Q52 18 55.77 23.9 Z",
  drop: "M55.63 20.28 L73.91 44.38 A27.5 27.5 0 1 1 30.09 44.38 L48.37 20.28 Q52 15.5 55.63 20.28 Z",
};

/** A body is stroked in its own fill this wide with round joins, which is what rounds its corners. */
export const BODY_STROKE = 5;

/** Each eye is a pill tilted by `turn` degrees about its centre. */
export const EYE = { width: 7.4, height: 18, turn: -16 } as const;
export const EYES = [
  { x: 44, y: 56.5 },
  { x: 60.5, y: 53 },
] as const;
