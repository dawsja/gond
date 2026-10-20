import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { setUserTimezone } from "../data/prefs.ts";
import { countSubscriptions, removeSubscription, saveSubscription } from "../data/push.ts";
import { markViewing } from "../presence.ts";
import { sendPush, vapidKeys } from "../push.ts";

export function pushRoutes() {
  const app = new Hono<Env>();

  app.get("/push", (c) => c.json({ publicKey: vapidKeys().publicKey, subscriptions: countSubscriptions(userId(c)) }));

  app.post("/push/subscriptions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) return c.json({ error: "Not a push subscription" }, 400);
    saveSubscription({ endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } }, userId(c), c.req.header("user-agent") ?? "");
    return c.json({ ok: true, subscriptions: countSubscriptions(userId(c)) }, 201);
  });

  app.delete("/push/subscriptions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
    if (!body.endpoint) return c.json({ error: "Which subscription?" }, 400);
    removeSubscription(body.endpoint, userId(c));
    return c.json({ ok: true, subscriptions: countSubscriptions(userId(c)) });
  });

  app.post("/push/viewing", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { client?: unknown; threadId?: unknown; timezone?: unknown };
    if (typeof body.client !== "string" || !/^[\w-]{1,64}$/.test(body.client)) return c.json({ error: "Which window?" }, 400);
    if (body.threadId !== null && (typeof body.threadId !== "string" || !/^[\w-]{1,64}$/.test(body.threadId))) return c.json({ error: "Which conversation?" }, 400);
    markViewing(userId(c), body.client, body.threadId);
    if (body.timezone !== undefined) setUserTimezone(userId(c), body.timezone);
    return c.body(null, 204);
  });

  app.post("/push/test", async (c) => {
    const sent = await sendPush({ title: "Gond", body: "Notifications are working.", url: "/app", tag: "test", threadId: "" }, userId(c));
    return c.json({ sent });
  });

  return app;
}
