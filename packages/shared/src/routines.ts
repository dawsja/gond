import type { z } from "zod";
import type { routineInputSchema } from "./schemas.ts";

export type Routine = {
  id: string;
  botId: string;
  name: string;

  cron: string;
  timezone: string;

  prompt: string;
  enabled: boolean;
  /** A watch checks for a change and speaks up only when there is one worth telling; its runs show as "<bot> noticed". */
  watch: boolean;
  /** A reminder: it runs the next time its cron matches, then removes itself. */
  once: boolean;
  /** What starts it instead of its cron, which is then empty: an event in one of the person's connected apps. */
  trigger: RoutineTrigger | null;
  skillId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};
/** An event in a connected app that runs a routine the moment it happens (Composio's triggers). */
export type RoutineTrigger = {
  toolkit: string;
  slug: string;
  name: string;
  config: Record<string, unknown>;
};

export type RoutineInput = z.infer<typeof routineInputSchema>;
