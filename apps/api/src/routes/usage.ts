import { isUsageRange } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { userId } from "../access.ts";
import { turnTiming } from "../config.ts";
import { usageReport } from "../usage.ts";
import { turnsOf } from "../work.ts";
import { changeSharing, sharingState } from "../usage-sharing.ts";
import { readBody } from "./body.ts";

export function usageRoutes() {
  const app = new Hono<Env>();

  app.get("/usage", async (c) => {
    const range = c.req.query("range") ?? "month";
    if (!isUsageRange(range)) return c.json({ error: "Pick this month, this week or today" }, 400);
    return c.json(await usageReport(userId(c), range));
  });

  // Each of the person's recent turns with where its time went,; there only while turns are timed.
  app.get("/usage/turns", (c) => (turnTiming() ? c.json({ turns: turnsOf(userId(c), c.req.query("since")) }) : c.json({ error: "Turn timing is off on this server" }, 404)));

  // The admin's alone (app.ts): whether this server's token count goes to the public total.
  app.get("/usage/sharing", (c) => c.json(sharingState()));

  app.put("/usage/sharing", async (c) => {
    const body = await readBody(c);
    if (typeof body.on !== "boolean") return c.json({ error: "Say on or off" }, 400);
    return c.json(changeSharing(body.on));
  });

  return app;
}
