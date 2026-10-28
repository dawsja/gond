import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { noticeWanted } from "@gond/shared";
import { appUrl, ensureDataDir } from "./config.ts";
import { personOf, profileIds, profileOf } from "./data/profiles.ts";
import { listSubscriptions, removeSubscription } from "./data/push.ts";
import { emit } from "./events.ts";
import { pushToPhones } from "./phone-push.ts";
import { isViewing } from "./presence.ts";

type Vapid = { publicKey: string; privateKey: string };
const holder = globalThis as typeof globalThis & { __gondVapid?: Vapid };

export function vapidKeys(): Vapid {
  if (holder.__gondVapid) return holder.__gondVapid;
  const file = path.join(ensureDataDir(), "vapid.json");
  let keys: Vapid;
  if (existsSync(file)) {
    keys = JSON.parse(readFileSync(file, "utf8")) as Vapid;
  } else {
    keys = webpush.generateVAPIDKeys();
    writeFileSync(file, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  }
  holder.__gondVapid = keys;
  return keys;
}

type PushPayload = {
  title: string;
  body: string;

  url: string;

  tag: string;
  threadId: string;
  /** The bot it is about, so each device can leave out the bots it muted; none for an export or a person in a space. */
  botId?: string | null;
  /** A card a phone can answer from its lock screen, its buttons named as on the card. */
  card?: { id: string; allow: string; deny: string };
};

/**
 * With more than one profile, a notice says which it is from and opens in it, wherever the device
 * has wandered since.
 */
export function fromProfile(payload: PushPayload, userId: string): PushPayload {
  const profile = profileOf(userId);
  if (!profile || profileIds(profile.personId).length < 2) return payload;
  const url = `${payload.url}${payload.url.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile.id)}`;
  return { ...payload, title: `${profile.label} · ${payload.title}`, url };
}

/**
 * A notice goes everywhere the person set up, whichever profile it is from: every browser and app
 * that turned notifications on, and every phone signed up for push. Nothing goes about the
 * conversation they have in front of them, and nothing from a profile they muted.
 */
export async function sendPush(raw: PushPayload, userId: string): Promise<number> {
  if (profileOf(userId)?.muted) return 0;
  const payload = fromProfile(raw, userId);
  const person = personOf(userId);
  const { card: _card, ...live } = payload;
  emit({ topic: "notify", userId, ...live });
  if (payload.threadId && isViewing(userId, payload.threadId)) return 0;
  const [phones, browsers] = await Promise.all([
    pushToPhones(person, { v: 1, title: payload.title, body: payload.body, url: payload.url, tag: payload.tag, ...(payload.card ? { card: payload.card } : {}) }, payload.botId),
    toBrowsers(person, live),
  ]);
  return phones + browsers;
}

async function toBrowsers(person: string, payload: Omit<PushPayload, "card">): Promise<number> {
  const subscriptions = listSubscriptions(person).filter((sub) => noticeWanted(sub.notices, payload.botId));
  if (subscriptions.length === 0) return 0;
  const keys = vapidKeys();
  const contact = `mailto:gond@${new URL(appUrl()).hostname || "localhost"}`;
  let sent = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { vapidDetails: { subject: contact, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 60 * 60, urgency: "high" });
        sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) removeSubscription(sub.endpoint);
        else console.warn(`[gond] push failed (${status ?? "?"}): ${error instanceof Error ? error.message : error}`);
      }
    }),
  );
  return sent;
}
