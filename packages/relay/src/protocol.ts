/**
 * gond-relay's wire protocol, version 1. Everything here is pure, so the Bun server, the
 * Cloudflare Worker and Gond's client share one copy.
 *
 * A Gond server is known by its Ed25519 public key (raw, base64url), which is also the name of
 * its mailbox. It holds one WebSocket to its mailbox, proves the key by signing a challenge, and
 * sends envelopes to other mailboxes. An envelope is sealed for its recipient (HPKE, see
 * client.ts) and signed by its sender; the relay only ever sees who, to whom, when and how big,
 * and an invite's token when it is brought (it holds only the hash until then).
 */

export const PROTOCOL = 1;
export const VERSIONS = [PROTOCOL] as const;

export const LIMITS = {
  /** The largest envelope as sent, JSON and all. Files go in chunks. */
  envelopeBytes: 256 * 1024,
  /** The largest frame a socket takes; an envelope plus its frame. */
  frameBytes: 300 * 1024,
  /** What one mailbox holds for an owner who is away, by count and by size. */
  queued: 2000,
  queuedBytes: 64 * 1024 * 1024,
  /** How long a held envelope waits for its owner before it goes. */
  queueMs: 7 * 24 * 60 * 60 * 1000,
  /** Envelopes one key may send a minute. */
  sendsPerMinute: 120,
  /** Senders one mailbox may let in, and invites it may have open. */
  allowed: 1000,
  invites: 100,
  inviteMs: 30 * 24 * 60 * 60 * 1000,
  /** A socket that hasn't answered its challenge by then is closed. */
  helloMs: 10_000,
  /** A mailbox nobody connected to for this long is removed, with everything in it. */
  idleMs: 90 * 24 * 60 * 60 * 1000,
  /** A push's sealed notice; Firebase takes 4 KB of data in all. */
  pushBytes: 3000,
  /** Pushes one key may send a minute. */
  pushesPerMinute: 120,
  /** How far a push's time may be from the relay's, either way. */
  pushSkewMs: 5 * 60 * 1000,
  /** How often one key may report its usage, and how many tokens an hour a report may add. */
  usageEveryMs: 10 * 60 * 1000,
  usageTokensPerHour: 250_000_000,
  /** Days of daily counts `/v1/usage` gives back. */
  usageDays: 90,
} as const;

export type Envelope = {
  v: 1;
  /** Chosen by the sender, unique per sender; the recipient drops one it has seen. */
  id: string;
  from: string;
  to: string;
  at: number;
  /** HPKE's encapsulated key and the ciphertext, base64url. */
  enc: string;
  ct: string;
  /** Ed25519 by `from` over `signedEnvelope`. */
  sig: string;
};

export type ClientFrame =
  | { t: "hello"; key: string; sig: string }
  | { t: "send"; envelope: Envelope; invite?: string }
  | { t: "ack"; id: string; from: string }
  | { t: "allow"; key: string }
  | { t: "forget"; key: string }
  | { t: "invite"; hash: string; expires: number }
  | { t: "uninvite"; hash: string }
  | { t: "ping" };

export type Refusal =
  | "not_allowed"
  | "too_big"
  | "mailbox_full"
  | "rate_limited"
  | "bad_signature"
  | "bad_envelope"
  | "not_yours"
  | "too_many";

export type RelayFrame =
  | { t: "challenge"; nonce: string; versions: readonly number[] }
  | { t: "ready"; key: string; queued: number }
  | { t: "deliver"; envelope: Envelope }
  | { t: "sent"; id: string }
  | { t: "refused"; id?: string; reason: Refusal; message: string }
  | { t: "ok"; op: "allow" | "forget" | "invite" | "uninvite"; ref: string }
  | { t: "error"; message: string }
  | { t: "pong" };

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
  /** A newer push with the same collapse key replaces an older one still waiting. */
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

/** What a relay says about itself at its root address. */
export function info() {
  return { name: "gond-relay", protocol: PROTOCOL, versions: VERSIONS, limits: { envelopeBytes: LIMITS.envelopeBytes, queueDays: LIMITS.queueMs / 86_400_000 } };
}

/** Words for each refusal, written for the Gond that reads them (and its logs). */
export const REFUSALS: Record<Refusal, string> = {
  not_allowed: "That mailbox doesn't take envelopes from this key. It needs an invite first.",
  too_big: `Envelopes are at most ${LIMITS.envelopeBytes} bytes; send big things in chunks.`,
  mailbox_full: "That mailbox is full. Its owner hasn't connected in a while.",
  rate_limited: `At most ${LIMITS.sendsPerMinute} envelopes a minute.`,
  bad_signature: "The envelope's signature doesn't match its sender.",
  bad_envelope: "The envelope isn't shaped like a version 1 envelope.",
  not_yours: "An envelope can only be sent from the key this socket proved.",
  too_many: "Too many invites or allowed keys on this mailbox.",
};

const B64URL = /^[A-Za-z0-9_-]+$/;
/** A raw 32-byte key in base64url, unpadded. */
const KEY = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isKey = (value: unknown): value is string => typeof value === "string" && KEY.test(value);
const isB64 = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && B64URL.test(value);
const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

export function signedHello(nonce: string): Uint8Array {
  return utf8(`gond-relay/${PROTOCOL} hello\n${nonce}`);
}

export function signedEnvelope(e: Omit<Envelope, "sig">): Uint8Array {
  return utf8([`gond-relay/${PROTOCOL} envelope`, e.id, e.from, e.to, String(e.at), e.enc, e.ct].join("\n"));
}

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

export function parseEnvelope(value: unknown): Envelope | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (e.v !== 1 || !isId(e.id) || !isKey(e.from) || !isKey(e.to)) return null;
  if (typeof e.at !== "number" || !Number.isSafeInteger(e.at) || e.at < 0) return null;
  if (!isB64(e.enc, 256) || !isB64(e.ct, LIMITS.envelopeBytes) || !isB64(e.sig, 128)) return null;
  return { v: 1, id: e.id, from: e.from, to: e.to, at: e.at, enc: e.enc, ct: e.ct, sig: e.sig };
}

/** Reads one frame from a client, or null for anything that isn't one. */
export function parseClientFrame(raw: string): ClientFrame | null {
  if (raw.length > LIMITS.frameBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  switch (f.t) {
    case "hello":
      return isKey(f.key) && isB64(f.sig, 128) ? { t: "hello", key: f.key, sig: f.sig } : null;
    case "send": {
      const envelope = parseEnvelope(f.envelope);
      if (!envelope) return null;
      if (f.invite !== undefined && !isB64(f.invite, 128)) return null;
      return f.invite === undefined ? { t: "send", envelope } : { t: "send", envelope, invite: f.invite as string };
    }
    case "ack":
      return isId(f.id) && isKey(f.from) ? { t: "ack", id: f.id, from: f.from } : null;
    case "allow":
    case "forget":
      return isKey(f.key) ? { t: f.t, key: f.key } : null;
    case "invite":
      return isB64(f.hash, 64) && typeof f.expires === "number" && Number.isSafeInteger(f.expires) ? { t: "invite", hash: f.hash, expires: f.expires } : null;
    case "uninvite":
      return isB64(f.hash, 64) ? { t: "uninvite", hash: f.hash } : null;
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
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

/** An invite token is shared once, in the invite link; the relay keeps only its hash. */
export async function inviteHash(token: string): Promise<string> {
  return toB64(await crypto.subtle.digest("SHA-256", utf8(token)));
}

export async function verifySignature(key: string, sig: string, message: Uint8Array): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey("raw", fromB64(key), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromB64(sig), message as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

export function envelopeSize(envelope: Envelope): number {
  return utf8(JSON.stringify(envelope)).length;
}
