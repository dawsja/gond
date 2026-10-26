import { Hono } from "hono";
import { ownBot, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { listBots } from "../data/bots.ts";
import { getRoutine, listRoutines, updateRoutine } from "../data/routines.ts";

export function routinesRoutes() {
  const app = new Hono<Env>();

  app.get("/routines", (c) => {
    const wanted = c.req.query("bot") || undefined;
    if (wanted) return ownBot(c, wanted) ? c.json({ routines: listRoutines(wanted) }) : c.json({ error: "Couldn't find that bot" }, 404);
    const mine = new Set(listBots({ includeHidden: true, userId: userId(c) }).map((b) => b.id));
    return c.json({ routines: listRoutines().filter((r) => mine.has(r.botId)) });
  });

  const ownRoutine = (c: Parameters<typeof ownBot>[0], id: string) => {
    const routine = getRoutine(id);
    return routine && ownBot(c, routine.botId) ? routine : null;
  };

  // A person only switches a routine on or off; making, changing, removing and running one is the bot's (its routine tools).
  app.patch("/routines/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return c.json({ error: "A routine can only be switched on or off here. Ask its bot to change it." }, 400);
    const current = ownRoutine(c, c.req.param("id"));
    if (!current) return c.json({ error: "Couldn't find that routine" }, 404);
    return c.json({ routine: updateRoutine(current.id, { enabled: body.enabled }) });
  });

  return app;
}
