import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { appUrl, ensureDataDir } from "./config.ts";
import { listSubscriptions, removeSubscription } from "./data/push.ts";
import { emit } from "./events.ts";
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

export type PushPayload = {
  title: string;
  body: string;

  url: string;

  tag: string;
  threadId: string;
};

export async function sendPush(payload: PushPayload, userId: string): Promise<number> {
  emit({ topic: "notify", userId, ...payload });
  if (payload.threadId && isViewing(userId, payload.threadId)) return 0;
  const subscriptions = listSubscriptions(userId);
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
