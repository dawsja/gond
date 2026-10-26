import { isNotifyServiceKind } from "@gond/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { deleteNotifyService, getNotifyService, readNotifyService, saveNotifyService, setNotifyServiceEnabled } from "../data/notify-services.ts";
import { checkService, deliver, linkTo } from "../notify-services.ts";

const TEST_NOTICE = { title: "Gond is set up", body: "This is how your bots will reach you here.", url: "/app" };

export function notifyRoutes() {
  const app = new Hono<Env>();

  app.get("/notify-service", (c) => c.json({ service: getNotifyService(userId(c)) }));

  // One service at a time: saving another kind replaces the one there was.
  app.put("/notify-service", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; values?: unknown };
    if (!isNotifyServiceKind(body.kind)) return c.json({ error: "Pick a service from the list" }, 400);
    const values = body.values && typeof body.values === "object" ? (body.values as Record<string, unknown>) : {};
    const checked = checkService(body.kind, values, readNotifyService(userId(c)));
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    saveNotifyService(userId(c), body.kind, checked.settings, checked.secrets);
    return c.json({ service: getNotifyService(userId(c)) });
  });

  app.patch("/notify-service", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return c.json({ error: "Turn it on or off" }, 400);
    if (!setNotifyServiceEnabled(userId(c), body.enabled)) return c.json({ error: "There's no service set up" }, 404);
    return c.json({ service: getNotifyService(userId(c)) });
  });

  app.delete("/notify-service", (c) => {
    deleteNotifyService(userId(c));
    return c.json({ service: null });
  });

  // A test of what the form holds, before it's saved, or of the saved service when nothing is sent.
  app.post("/notify-service/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; values?: unknown };
    const saved = readNotifyService(userId(c));
    let service = saved;
    if (body.kind !== undefined) {
      if (!isNotifyServiceKind(body.kind)) return c.json({ error: "Pick a service from the list" }, 400);
      const checked = checkService(body.kind, body.values && typeof body.values === "object" ? (body.values as Record<string, unknown>) : {}, saved);
      if ("error" in checked) return c.json({ error: checked.error }, 400);
      service = { kind: body.kind, enabled: true, ...checked };
    }
    if (!service) return c.json({ error: "Set up a service first" }, 404);
    try {
      await deliver(service, { ...TEST_NOTICE, url: linkTo(TEST_NOTICE.url) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The test didn't go through." }, 400);
    }
    return c.json({ ok: true });
  });

  return app;
}
