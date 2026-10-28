import { noticeWanted } from "@gond/shared";
import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { listPushDevices, removePushDevice, type PushDevice } from "./data/push-devices.ts";
import { signPush } from "./federation.ts";

/** Gond's own relay passes every Gond's pushes to Firebase, which holds no Gond's keys; there is no other. */
export const PUSH_RELAY_URL = "https://api.gond.io";

/** What a phone shows; `card` puts Approve and Deny on it, `withdraw` takes an earlier one away. */
export type PhoneNotice =
  | { v: 1; title: string; body: string; url: string; tag: string; card?: { id: string; allow: string; deny: string } }
  | { v: 1; withdraw: string };

/** AES-256-GCM with the phone's own key: twelve bytes of IV, then the ciphertext and its tag. */
export function sealNotice(key: string, notice: PhoneNotice): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(notice), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** What a phone signs to answer a card from its lock screen, with its answer key. */
export function answerSignature(key: string, parts: { device: string; at: string; approvalId: string; decision: string }): string {
  return createHmac("sha256", Buffer.from(key, "base64url")).update([parts.device, parts.at, parts.approvalId, parts.decision].join("\n")).digest("hex");
}

export function answerSigned(key: string, parts: { device: string; at: string; approvalId: string; decision: string }, signature: string): boolean {
  const expected = Buffer.from(answerSignature(key, parts), "hex");
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(signature) ? signature : "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const collapseOf = (tag: string) => tag.replace(/[^\w.-]/g, "").slice(0, 64) || null;

async function sendTo(device: PushDevice, notice: PhoneNotice, collapse: string | null): Promise<boolean> {
  try {
    const push = await signPush({ token: device.token, data: sealNotice(device.sealKey, notice), collapse, platform: device.platform, quiet: "withdraw" in notice });
    const res = await fetch(`${PUSH_RELAY_URL}/v1/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(push), signal: AbortSignal.timeout(15_000) });
    // The phone gave up its token: the app is gone or its data cleared, and it signs up again when it opens.
    if (res.status === 410) removePushDevice(device.id);
    else if (!res.ok) console.warn(`[gond] phone push failed (${res.status})`);
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch (error) {
    console.warn(`[gond] phone push failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** A notice for every phone of the person's that wants it; how many took it. */
export async function pushToPhones(person: string, notice: Extract<PhoneNotice, { title: string }>, botId: string | null | undefined): Promise<number> {
  const devices = listPushDevices(person).filter((device) => noticeWanted(device.notices, botId));
  const sent = await Promise.all(devices.map((device) => sendTo(device, notice, collapseOf(notice.tag))));
  return sent.filter(Boolean).length;
}

/** Takes a notice away from the person's phones, once what it asked is answered elsewhere or over. */
export async function withdrawFromPhones(person: string, tag: string): Promise<void> {
  // The same collapse key, so a phone that was away gets the withdrawal in place of the notice.
  await Promise.all(listPushDevices(person).map((device) => sendTo(device, { v: 1, withdraw: tag }, collapseOf(tag))));
}
