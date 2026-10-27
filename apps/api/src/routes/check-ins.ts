import { isCheckInHours, type CheckIns } from "@gond/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { gmailConnected } from "../check-ins.ts";
import { checkInsOf, setCheckIns } from "../data/check-ins.ts";

const isHour = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23;

function settingsOf(id: string): CheckIns {
  const { enabled, everyHours, quietFrom, quietTo, email } = checkInsOf(id);
  return { enabled, everyHours, quietFrom, quietTo, email };
}

/** The primary bot's check-ins, the open profile's own. */
export function checkInsRoutes() {
  const app = new Hono<Env>();

  app.get("/check-ins", (c) => c.json({ checkIns: settingsOf(userId(c)), gmail: gmailConnected(userId(c)) }));

  app.put("/check-ins", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<Record<keyof CheckIns, unknown>> | null;
    if (!body) return c.json({ error: "Say how check-ins should work" }, 400);
    const change: Partial<CheckIns> = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return c.json({ error: "Turn check-ins on or off" }, 400);
      change.enabled = body.enabled;
    }
    if (body.email !== undefined) {
      if (typeof body.email !== "boolean") return c.json({ error: "Say whether to look at your email" }, 400);
      change.email = body.email;
    }
    if (body.everyHours !== undefined) {
      if (!isCheckInHours(body.everyHours)) return c.json({ error: "Pick how often from the list" }, 400);
      change.everyHours = body.everyHours;
    }
    for (const key of ["quietFrom", "quietTo"] as const) {
      if (body[key] === undefined) continue;
      if (!isHour(body[key])) return c.json({ error: "Pick the quiet hours from the list" }, 400);
      change[key] = body[key];
    }
    return c.json({ checkIns: setCheckIns(userId(c), change), gmail: gmailConnected(userId(c)) });
  });

  return app;
}
