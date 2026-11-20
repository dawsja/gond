import type { z } from "zod";
import type { botInputSchema } from "./schemas.ts";

export const BOT_EXPRESSIONS = ["happy", "wink", "surprised"] as const;
export type BotExpression = (typeof BOT_EXPRESSIONS)[number];
// The cog is the Gond bot and always the default; the rest are other bodies with the same eyes.
export const BOT_SHAPES = ["cog", "cloud", "circle", "triangle", "tile", "gem", "star", "drop"] as const;
export type BotShape = (typeof BOT_SHAPES)[number];
export const BOT_SHAPE_LABELS: Record<BotShape, string> = { cog: "Cog", cloud: "Cloud", circle: "Circle", triangle: "Triangle", tile: "Tile", gem: "Gem", star: "Star", drop: "Drop" };

export const BOT_COLORS = ["#E04E0A", "#2F6FD6", "#D03A3A", "#D98A08", "#7650D8", "#CF3D85", "#11998A", "#189C47", "#0B8EC8", "#D8620F"] as const;

export const APPROVAL_LEVELS = ["ask", "auto", "full"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const APPROVAL_LEVEL_LABELS: Record<ApprovalLevel, { title: string; detail: string }> = {
  ask: { title: "Always ask", detail: "Every shell command, file outside its own folder and connected-app action waits for you." },
  auto: { title: "Auto", detail: "It carries on with routine work and asks before anything it can't undo or that leaves the computer: sending, deleting, paying, forcing." },
  full: { title: "Always allow", detail: "Nothing asks but an email that goes out. Only for a bot you trust with the computer and your apps." },
};

export const DEFAULT_MODEL = "opus";

export const BOT_LIMITS = {
  name: 40,
  title: 80,
  description: 4000,
} as const;
export type BotInput = z.infer<typeof botInputSchema>;

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type Bot = BotInput & {
  id: string;

  userId: string;

  threadId: string;

  primary: boolean;
  hidden: boolean;
  pinned: boolean;
  position: number;
  /** The model this bot runs on instead of the one in Settings → AI; empty for that one. */
  model: string;
  /** Where `model` was picked (`modelSource`); it holds only while the AI still runs there. */
  modelFor: string;
  createdAt: string;
  updatedAt: string;
};
