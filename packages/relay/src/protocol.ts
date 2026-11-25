export const PROTOCOL = 1;
export const VERSIONS = [PROTOCOL] as const;

export const LIMITS = {
  /** A push's sealed notice; Firebase takes 4 KB of data in all. */
  pushBytes: 3000,
  pushesPerMinute: 120,
  pushSkewMs: 5 * 60 * 1000,
  usageEveryMs: 10 * 60 * 1000,
  usageTokensPerHour: 250_000_000,
  usageDays: 90,
} as const;

/**
 * A notice for a phone, which the relay passes to Firebase (`/v1/push`). The notice is sealed by the
 * Gond for that phone alone, so the relay sees only which Gond, which phone, when and how big.
 */
export type PushRequest = {
  v: 1;
  from: string;
  at: number;
  /** Chosen by the sender, so two pushes in the same millisecond sign differently. */
  id: string;
  platform: PushPlatform;
  /** The phone's Firebase registration token. */
  token: string;
  /** The sealed notice, base64url. */
  data: string;
  collapse: string | null;
  /**
   * Shows nothing by itself: what it carries changes what the phone already shows (a card answered
   * elsewhere). An iPhone must show every alert, so a quiet one goes there as a background push.
   */
  quiet?: true;
  /** Ed25519 by `from` over `signedPush`. */
  sig: string;
};

export type PushResult = "sent" | "gone" | "failed";

/**
 * A Gond's count of the tokens its bots used since its admin turned sharing on (`epoch` names that
 * time), which the relay adds to the public total (`/v1/usage`). Only the number crosses: no people,
 * bots, models or messages. A running total, so a report sent twice counts once.
 */
export type UsageReport = {
  v: 1;
  from: string;
  at: number;
  /** Chosen when sharing was turned on; a new one starts the count from nothing. */
  epoch: string;
  tokens: number;
  /** Ed25519 by `from` over `signedUsage`. */
  sig: string;
};

/**
 * What anyone may read at `/v1/usage`: every reporting Gond's tokens together, how many Gonds, since
 * when, and what was counted each UTC day of the last `usageDays`, oldest first (days with none left out).
 */
export type UsageTotals = { tokens: number; gonds: number; since: number | null; days: { day: string; tokens: number }[] };

export const PUSH_PLATFORMS = ["android", "ios"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export function info() {
  return { name: "gond-relay", protocol: PROTOCOL, versions: VERSIONS };
}

const B64URL = /^[A-Za-z0-9_-]+$/;
/** A raw 32-byte key in base64url, unpadded. */
const KEY = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isKey = (value: unknown): value is string => typeof value === "string" && KEY.test(value);
const isB64 = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && B64URL.test(value);
const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

export function signedPush(p: Omit<PushRequest, "sig">): Uint8Array {
  // `quiet` came later, so a push without it signs exactly as before.
  return utf8([`gond-relay/${PROTOCOL} push`, p.id, p.from, String(p.at), p.platform, p.token, p.data, p.collapse ?? "", ...(p.quiet ? ["quiet"] : [])].join("\n"));
}

export function signedUsage(u: Omit<UsageReport, "sig">): Uint8Array {
  return utf8([`gond-relay/${PROTOCOL} usage`, u.from, String(u.at), u.epoch, String(u.tokens)].join("\n"));
}

export function parseUsage(value: unknown): UsageReport | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  if (u.v !== 1 || !isKey(u.from) || !isId(u.epoch) || !isB64(u.sig, 128)) return null;
  if (typeof u.at !== "number" || !Number.isSafeInteger(u.at) || u.at < 0) return null;
  if (typeof u.tokens !== "number" || !Number.isSafeInteger(u.tokens) || u.tokens < 0) return null;
  return { v: 1, from: u.from, at: u.at, epoch: u.epoch, tokens: u.tokens, sig: u.sig };
}

const PUSH_TOKEN = /^[\w:.-]{20,512}$/;
const COLLAPSE = /^[\w.-]{1,64}$/;

export function parsePush(value: unknown): PushRequest | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (p.v !== 1 || !isKey(p.from) || !isId(p.id) || !(PUSH_PLATFORMS as readonly unknown[]).includes(p.platform)) return null;
  if (typeof p.at !== "number" || !Number.isSafeInteger(p.at) || p.at < 0) return null;
  if (typeof p.token !== "string" || !PUSH_TOKEN.test(p.token) || !isB64(p.data, LIMITS.pushBytes) || !isB64(p.sig, 128)) return null;
  if (p.collapse !== null && (typeof p.collapse !== "string" || !COLLAPSE.test(p.collapse))) return null;
  if (p.quiet !== undefined && p.quiet !== true) return null;
  return { v: 1, from: p.from, at: p.at, id: p.id, platform: p.platform as PushPlatform, token: p.token, data: p.data, collapse: p.collapse, ...(p.quiet ? { quiet: true as const } : {}), sig: p.sig };
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomB64(bytes: number): string {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function verifySignature(key: string, sig: string, message: Uint8Array): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey("raw", fromB64(key), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromB64(sig), message as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}
