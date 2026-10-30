import { isUsageRange } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { userId } from "../access.ts";
import { usageReport } from "../usage.ts";
import { changeSharing, sharingState } from "../usage-sharing.ts";

export function usageRoutes() {
  const app = new Hono<Env>();

  app.get("/usage", async (c) => {
    const range = c.req.query("range") ?? "month";
    if (!isUsageRange(range)) return c.json({ error: "Pick this month, this week or today" }, 400);
    return c.json(await usageReport(userId(c), range));
  });

  // The admin's alone (app.ts): whether this server's token count goes to the public total.
  app.get("/usage/sharing", (c) => c.json(sharingState()));

  app.put("/usage/sharing", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
    if (typeof body?.on !== "boolean") return c.json({ error: "Say on or off" }, 400);
    return c.json(changeSharing(body.on));
  });

  return app;
}
