import { isUsageRange } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { userId } from "../access.ts";
import { usageReport } from "../usage.ts";

export function usageRoutes() {
  const app = new Hono<Env>();

  app.get("/usage", async (c) => {
    const range = c.req.query("range") ?? "month";
    if (!isUsageRange(range)) return c.json({ error: "Pick this month, this week or today" }, 400);
    return c.json(await usageReport(userId(c), range));
  });

  return app;
}
