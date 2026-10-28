import { Hono } from "hono";
import { personId, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { setUserTimezone } from "../data/prefs.ts";
import { readDeviceNotices } from "@gond/shared";
import { countSubscriptions, removeSubscription, saveSubscription, setSubscriptionNotices, subscriptionNotices } from "../data/push.ts";
import { getPushDevice, registerPushDevice, removePushDevice, setPushDeviceNotices } from "../data/push-devices.ts";
import { answerableOnPhone, decide } from "../approvals.ts";
import { getApproval } from "../data/approvals.ts";
import { personOf } from "../data/profiles.ts";
import { getThread } from "../data/threads.ts";
import { answerSigned } from "../phone-push.ts";
import { markViewing } from "../presence.ts";
import { vapidKeys } from "../push.ts";

export function pushRoutes() {
  const app = new Hono<Env>();

  app.get("/push", (c) => c.json({ publicKey: vapidKeys().publicKey, subscriptions: countSubscriptions(personId(c)) }));

  app.post("/push/subscriptions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) return c.json({ error: "This browser sent an incomplete push subscription. Turn notifications off and on again." }, 400);
    saveSubscription({ endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } }, personId(c), c.req.header("user-agent") ?? "");
    return c.json({ ok: true, subscriptions: countSubscriptions(personId(c)) }, 201);
  });

  app.delete("/push/subscriptions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
    if (!body.endpoint) return c.json({ error: "Say which subscription to remove" }, 400);
    removeSubscription(body.endpoint, personId(c));
    return c.json({ ok: true, subscriptions: countSubscriptions(personId(c)) });
  });

  // What this browser is told about. The endpoint names the subscription, so it is sent in the body rather than the URL.
  app.post("/push/notices", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    if (typeof body.endpoint !== "string" || !body.endpoint) return c.json({ error: "Say which browser this is" }, 400);
    const notices = subscriptionNotices(body.endpoint, personId(c));
    if (!notices) return c.json({ error: "Notifications aren't on for this browser" }, 404);
    return c.json({ notices });
  });

  app.put("/push/notices", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown; notices?: unknown };
    const notices = readDeviceNotices(body.notices);
    if (typeof body.endpoint !== "string" || !body.endpoint || !notices) return c.json({ error: "Couldn't read which notices this browser wants" }, 400);
    if (!setSubscriptionNotices(body.endpoint, personId(c), notices)) return c.json({ error: "Notifications aren't on for this browser" }, 404);
    return c.json({ notices });
  });

  // A phone signing up for push, or checking in as it opens. New keys come back only when it needs them.
  app.put("/push/devices", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { platform?: unknown; token?: unknown; id?: unknown; notices?: unknown };
    if (body.platform !== "android") return c.json({ error: "Push works on the Android app for now" }, 400);
    if (typeof body.token !== "string" || !/^[\w:.-]{20,512}$/.test(body.token)) return c.json({ error: "This phone sent a push token that doesn't look right. Open the app again." }, 400);
    if (body.id !== undefined && body.id !== null && (typeof body.id !== "string" || !/^[\w-]{1,64}$/.test(body.id))) return c.json({ error: "Say which phone this is" }, 400);
    const notices = body.notices === undefined ? null : readDeviceNotices(body.notices);
    if (body.notices !== undefined && !notices) return c.json({ error: "Couldn't read which notices this phone wants" }, 400);
    const device = registerPushDevice(personId(c), { token: body.token, id: (body.id as string | null | undefined) ?? null, notices });
    return c.json(device.keys ? { id: device.id, seal: device.keys.seal, answer: device.keys.answer } : { id: device.id }, device.keys ? 201 : 200);
  });

  app.put("/push/devices/:id/notices", async (c) => {
    const notices = readDeviceNotices(((await c.req.json().catch(() => ({}))) as { notices?: unknown }).notices);
    if (!notices) return c.json({ error: "Couldn't read which notices this phone wants" }, 400);
    if (!setPushDeviceNotices(c.req.param("id"), personId(c), notices)) return c.json({ error: "Push isn't on for this phone" }, 404);
    return c.json({ notices });
  });

  app.delete("/push/devices/:id", (c) => (removePushDevice(c.req.param("id"), personId(c)) ? c.body(null, 204) : c.json({ error: "Push isn't on for this phone" }, 404)));

  app.post("/push/viewing", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { client?: unknown; threadId?: unknown; timezone?: unknown };
    if (typeof body.client !== "string" || !/^[\w-]{1,64}$/.test(body.client)) return c.json({ error: "Say which window this is" }, 400);
    if (body.threadId !== null && (typeof body.threadId !== "string" || !/^[\w-]{1,64}$/.test(body.threadId))) return c.json({ error: "Say which conversation is open" }, 400);
    markViewing(userId(c), body.client, body.threadId);
    if (body.timezone !== undefined) setUserTimezone(userId(c), body.timezone);
    return c.body(null, 204);
  });

  return app;
}

const ANSWER_SKEW_MS = 5 * 60 * 1000;

/**
 * A card answered from a phone's lock screen, ahead of the session check: the app has no cookie
 * there. The phone signs its answer with the key only it and this server hold, and the card must be
 * its person's, still open, and one a phone may answer at all.
 */
export function pushAnswerRoutes() {
  const app = new Hono();

  app.post("/push/answer", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { approvalId?: unknown; decision?: unknown };
    const deviceId = c.req.header("x-gond-device") ?? "";
    const at = c.req.header("x-gond-time") ?? "";
    const signature = c.req.header("x-gond-signature") ?? "";
    if (typeof body.approvalId !== "string" || (body.decision !== "allow" && body.decision !== "deny")) return c.json({ error: "Say allow or deny" }, 400);
    const device = getPushDevice(deviceId);
    const fresh = /^\d{1,16}$/.test(at) && Math.abs(Date.now() - Number(at)) <= ANSWER_SKEW_MS;
    if (!device || !fresh || !answerSigned(device.answerKey, { device: deviceId, at, approvalId: body.approvalId, decision: body.decision }, signature)) return c.json({ error: "This phone couldn't be checked. Open Gond to answer." }, 401);
    const approval = getApproval(body.approvalId);
    const thread = approval ? getThread(approval.threadId) : null;
    if (!approval || !thread || personOf(thread.userId) !== device.userId) return c.json({ error: "Couldn't find that card" }, 404);
    if (approval.status !== "pending") return c.json({ error: "That card was already answered or ran out of time" }, 409);
    if (!answerableOnPhone(approval)) return c.json({ error: "Open Gond to answer this card" }, 409);
    const answered = decide(approval.id, { decision: body.decision });
    return c.json({ status: answered?.status ?? approval.status });
  });

  return app;
}
