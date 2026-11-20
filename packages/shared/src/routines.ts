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
  skillId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type RoutineInput = z.infer<typeof routineInputSchema>;
