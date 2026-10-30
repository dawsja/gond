import { GOND_RELAY_URL, type Federation, type FederationState } from "@gond/shared";
import { RelayClient, createIdentity, inviteToken, keyCard, open, pushRequest, seal, usageReport, type Identity, type KeyCard } from "@gond/relay/client";
import type { PushRequest, UsageReport } from "@gond/relay/protocol";
import type { Envelope } from "@gond/relay/protocol";
import { dropOutboxFor, dueOutbox, enqueue, outboxDueNow, federationRow, firstSight, getPeer, outboxDone, outboxLater, saveFederation, sweepSpaces, touchPeer, type FederationRow } from "./data/spaces.ts";
import { emit } from "./events.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { keyWords } from "./words.ts";

/*
 * This Gond among other Gonds: its keys, its connection to its relay, and the outbox. Everything a
 * space sends goes into the outbox first (`send`), so a restart or a relay that's away loses
 * nothing: each envelope keeps its id across tries, and the other side drops one it has seen.
 * Envelopes go to the recipient's relay, so two Gonds on different relays still meet; this Gond
 * receives on its own.
 */

const RETRY_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
// The relay keeps an envelope 7 days; past that nothing is waiting for it and an old one is a replay.
const KEEP_MS = 8 * 24 * 60 * 60 * 1000;
const STALE_MS = 14 * 24 * 60 * 60 * 1000;
const SEEN_MS = 30 * 24 * 60 * 60 * 1000;
// A socket to another Gond's relay is only for sending, so one nobody sent on for a while goes.
const IDLE_CLIENT_MS = 10 * 60_000;
const MAX_CLIENTS = 64;
// A relay that's away shouldn't hold up every other Gond's envelopes for long.
const PEER_TIMEOUT_MS = 5_000;

type Inbound = (from: string, body: unknown) => Promise<void>;
/** An event the relay won't ever take, like a join whose invite is used up: for Spaces to say so. */
type Undeliverable = (peerKey: string, body: unknown) => void;

type Relay = { client: RelayClient; used: number; busy: number };

type State = {
  identity: Identity | null;
  /** By the relay's canonical address (`normalizeRelayUrl`). */
  clients: Map<string, Relay>;
  /** Every spelling peers gave for each relay, since their rows name the relay as they wrote it. */
  spellings: Map<string, Set<string>>;
  own: string | null;
  state: FederationState;
  inbound: Inbound | null;
  undeliverable: Undeliverable | null;
  flushing: boolean;
  again: boolean;
  timer: ReturnType<typeof setInterval> | null;
};

const holder = globalThis as typeof globalThis & { __gondFederation?: State };
const state = (): State => (holder.__gondFederation ??= { identity: null, clients: new Map(), spellings: new Map(), own: null, state: "off", inbound: null, undeliverable: null, flushing: false, again: false, timer: null });

export function relayUrlOf(row: Pick<FederationRow, "relay" | "relay_url">): string {
  return row.relay === "own" && row.relay_url ? row.relay_url : GOND_RELAY_URL;
}

/**
 * One spelling per relay: the scheme and host lowercased, no default port, no trailing slash,
 * no query or fragment. Null for anything that isn't an http or https address without credentials.
 * Two spellings of one relay would be two sockets with this Gond's key, and the relay keeps only
 * the newer one, so the clients are keyed by this.
 */
export function normalizeRelayUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  const host = url.hostname.replace(/\.$/, "") + (url.port ? `:${url.port}` : "");
  return `${url.protocol}//${host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Whether this Gond may open a socket to a relay another Gond named: never loopback, link-local
 * (cloud metadata among it), unspecified, localhost or a single-label name like a Compose
 * service, unless it is this Gond's own relay. A LAN relay stays allowed. Names aren't resolved,
 * so a public name that resolves to one of those isn't caught here.
 */
export function peerRelayAllowed(raw: string, ownUrl: string | null): boolean {
  const canonical = normalizeRelayUrl(raw);
  if (!canonical) return false;
  if (ownUrl && canonical === (normalizeRelayUrl(ownUrl) ?? ownUrl)) return true;
  const host = new URL(canonical).hostname;
  if (host.startsWith("[")) return !blockedIpv6(host.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !blockedIpv4(host);
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return host.includes(".");
}

function blockedIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number) as [number, number];
  return a === 127 || a === 0 || (a === 169 && b === 254);
}

function blockedIpv6(host: string): boolean {
  const groups = expandIpv6(host);
  if (!groups) return true;
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  // An IPv4 address mapped into IPv6 (::ffff:a.b.c.d) reaches that IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return blockedIpv4(`${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`);
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 literal as URL writes it (hex, `::` allowed, no dotted tail). */
function expandIpv6(host: string): number[] | null {
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const part = (text: string) => (text ? text.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** This Gond's keys, made the first time they're needed and kept encrypted with the secret key. */
async function identity(): Promise<Identity> {
  const current = state();
  if (current.identity) return current.identity;
  const row = federationRow();
  if (row.identity) {
    current.identity = JSON.parse(decryptSecret(row.identity)) as Identity;
    return current.identity;
  }
  const made = await createIdentity();
  saveFederation({ key: made.key, identity: encryptSecret(JSON.stringify(made)) });
  current.identity = made;
  return made;
}

export function ownKey(): string | null {
  return state().identity?.key ?? federationRow().key;
}

/** A push for one phone, signed with this Gond's key, which the relay checks before passing it to Firebase. */
export async function signPush(input: { token: string; data: string; collapse: string | null; platform: PushRequest["platform"]; quiet?: boolean }): Promise<PushRequest> {
  return pushRequest(await identity(), input);
}

/** This server's token count for the public total, signed with this Gond's key. */
export async function signUsage(input: { epoch: string; tokens: number }): Promise<UsageReport> {
  return usageReport(await identity(), input);
}

export async function ownCard(): Promise<KeyCard> {
  return keyCard(await identity());
}

export function federationEnabled(): boolean {
  return Boolean(federationRow().enabled);
}

export function federationFor(admin: boolean): Federation {
  const row = federationRow();
  return {
    enabled: Boolean(row.enabled),
    name: row.name,
    relay: row.relay,
    relayUrl: relayUrlOf(row),
    invites: row.invites,
    state: row.enabled ? state().state : "off",
    words: row.key ? keyWords(row.key) : null,
    canInvite: Boolean(row.enabled) && (row.invites === "everyone" || admin),
  };
}

function setState(next: FederationState) {
  const current = state();
  if (current.state === next) return;
  current.state = next;
  emit({ topic: "spaces" });
}

export function onInbound(handler: Inbound, undeliverable: Undeliverable) {
  state().inbound = handler;
  state().undeliverable = undeliverable;
}

/** The key a relay's client is kept under: its canonical address, so any spelling of this Gond's own relay is its own client. */
export function relayKey(raw: string): string {
  return normalizeRelayUrl(raw) ?? raw.trim();
}

function remember(key: string, spelling: string) {
  const spellings = state().spellings;
  const known = spellings.get(key) ?? new Set<string>();
  if (known.size < 8) known.add(spelling);
  spellings.set(key, known);
}

/** A client for a relay, made and connected the first time; null when too many are open and none is idle. */
function clientFor(raw: string): Relay | null {
  const current = state();
  const key = relayKey(raw);
  remember(key, raw);
  const known = current.clients.get(key);
  if (known) return known;
  if (current.clients.size >= MAX_CLIENTS && !evictOne()) return null;
  const own = key === current.own;
  const client = new RelayClient({
    url: key,
    identity: current.identity!,
    ...(own ? {} : { timeoutMs: PEER_TIMEOUT_MS }),
    onEnvelope: (envelope) => {
      // Only this Gond's own relay delivers to it: anything another relay pushes down a socket
      // opened to send would skip its own relay's limits. It's acked all the same, so an honest
      // relay doesn't keep it and send it again on every connection.
      if (key === state().own) return receive(envelope);
      console.warn(`[gond] dropped an envelope that came in on a socket to another relay (${key})`);
    },
    onState: (next) => {
      if (key === state().own) setState(next);
      // Back on the relay: what waited out a dropped connection goes now, not after its backoff.
      if (next === "ready") {
        for (const spelling of state().spellings.get(key) ?? [key]) outboxDueNow(spelling);
        void flush();
      }
    },
  });
  const relay: Relay = { client, used: Date.now(), busy: 0 };
  current.clients.set(key, relay);
  client.start();
  return relay;
}

function dropClient(key: string) {
  const current = state();
  current.clients.get(key)?.client.stop();
  current.clients.delete(key);
}

/** Closes sockets to other relays nobody sent on lately. */
function closeIdle() {
  const current = state();
  const before = Date.now() - IDLE_CLIENT_MS;
  for (const [key, relay] of current.clients) if (key !== current.own && relay.busy === 0 && relay.used < before) dropClient(key);
}

function evictOne(): boolean {
  const current = state();
  let oldest: [string, Relay] | null = null;
  for (const entry of current.clients) if (entry[0] !== current.own && entry[1].busy === 0 && (!oldest || entry[1].used < oldest[1].used)) oldest = entry;
  if (!oldest) return false;
  dropClient(oldest[0]);
  return true;
}

/** The connection this Gond receives on: its own relay. */
function ownClient(): RelayClient | null {
  const current = state();
  return current.own ? (current.clients.get(current.own)?.client ?? null) : null;
}

async function receive(envelope: Envelope) {
  const current = state();
  const peer = getPeer(envelope.from);
  // A blocked Gond's envelopes are dropped unread; one this Gond never met only ever brings a join.
  if (peer?.blocked) return;
  if (Date.now() - envelope.at > STALE_MS) return;
  if (!firstSight(envelope.from, envelope.id)) return;
  let opened: Awaited<ReturnType<typeof open>>;
  try {
    opened = await open(current.identity!, envelope);
  } catch (error) {
    console.warn(`[gond] dropped an envelope that didn't open: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (peer) touchPeer(peer.key);
  try {
    await current.inbound?.(opened.from, opened.body);
  } catch (error) {
    console.error("[gond] a space event failed:", error);
  }
}

/** Starts or restarts this Gond's place among other Gonds, as its settings now say. */
export async function startFederation() {
  stopFederation();
  const row = federationRow();
  if (!row.enabled) {
    setState("off");
    return;
  }
  const current = state();
  await identity();
  current.own = relayKey(relayUrlOf(row));
  setState("connecting");
  clientFor(relayUrlOf(row));
  current.timer = setInterval(() => void flush(), 5_000);
  void flush();
}

function stopFederation() {
  const current = state();
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
  for (const relay of current.clients.values()) relay.client.stop();
  current.clients.clear();
  current.own = null;
  setState("off");
}

/** Lets a Gond's envelopes into this Gond's mailbox, or stops them. */
export async function allowPeer(key: string, allowed: boolean) {
  const client = ownClient();
  if (!client) return;
  await (allowed ? client.allow(key) : client.forget(key)).catch(() => undefined);
}

/**
 * Takes back invites at the relay by their hashes (what this Gond keeps of a token), so nobody can
 * bring one in later. True when the relay confirmed every one; false when it isn't reachable now.
 */
export async function closeInvites(hashes: string[]): Promise<boolean> {
  const client = ownClient();
  if (!client) return false;
  const done = await Promise.all(hashes.map((hash) => client.uninviteHash(hash).then((answer) => answer.ok, () => false)));
  return done.every(Boolean);
}

/** A one-use invite: its token, after the relay has been told to let in whoever brings it. */
export async function openInvite(expires: number): Promise<string> {
  const client = ownClient();
  if (!client) throw new Error("This Gond isn't connected to its relay right now. Try again in a moment.");
  const token = inviteToken();
  const done = await client.invite(token, expires);
  if (!done.ok) throw new Error("The relay wouldn't take another invite. Try again later.");
  return token;
}

/** Puts an event in the outbox for a Gond; it goes as soon as the relay takes it. */
export function send(peerKey: string, body: unknown, invite?: string) {
  enqueue(peerKey, invite ? { event: body, invite } : { event: body });
  void flush();
}

export async function flush() {
  const current = state();
  if (current.flushing) {
    current.again = true;
    return;
  }
  if (!current.own || !current.identity) return;
  current.flushing = true;
  try {
    do {
      current.again = false;
      sweepSpaces({ seen: new Date(Date.now() - SEEN_MS).toISOString(), outbox: new Date(Date.now() - KEEP_MS).toISOString() });
      closeIdle();
      await Promise.all([...byPeer(dueOutbox()).values()].map(deliverAll));
    } while (current.again);
  } finally {
    current.flushing = false;
  }
}

type OutboxItem = ReturnType<typeof dueOutbox>[number];

function byPeer(rows: OutboxItem[]): Map<string, OutboxItem[]> {
  const groups = new Map<string, OutboxItem[]>();
  for (const row of rows) groups.set(row.peer_key, [...(groups.get(row.peer_key) ?? []), row]);
  return groups;
}

const retryAt = (attempts: number) => new Date(Date.now() + RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)]!).toISOString();

/**
 * One Gond's rows, in order, beside every other Gond's. Once one has to wait, the rest of that
 * Gond's stop for this flush; `dueOutbox` holds them behind it until it goes.
 */
async function deliverAll(rows: OutboxItem[]) {
  for (const row of rows) if (!(await deliver(row.id, row.peer_key, row.body, row.attempts))) return;
}

/** Sends one row; false when it has to wait for a later try. */
async function deliver(id: string, peerKey: string, raw: string, attempts: number): Promise<boolean> {
  const current = state();
  const peer = getPeer(peerKey);
  if (!peer || peer.blocked) {
    outboxDone(id);
    return true;
  }
  const later = () => (outboxLater(id, retryAt(attempts)), false);
  const who = peer.name || peer.key.slice(0, 8);
  if (!peerRelayAllowed(peer.relay_url, current.own)) {
    console.warn(`[gond] won't open a connection to ${who}'s relay at that address (${peer.relay_url})`);
    return later();
  }
  const relay = clientFor(peer.relay_url);
  if (!relay) return later();
  const { event, invite } = JSON.parse(raw) as { event: unknown; invite?: string };
  relay.busy++;
  relay.used = Date.now();
  try {
    const envelope = await seal(current.identity!, { key: peer.key, box: peer.box, sig: peer.sig }, event, { id });
    const sent = await relay.client.send(envelope, invite);
    if (sent.ok) outboxDone(id);
    else if (sent.reason === "not_allowed" && invite) {
      // An invite the relay no longer knows was used or ran out: waiting won't change that.
      outboxDone(id);
      current.undeliverable?.(peerKey, event);
    } else if (sent.reason === "not_allowed" || sent.reason === "mailbox_full" || sent.reason === "rate_limited") return later();
    else {
      console.warn(`[gond] the relay refused an envelope for ${who}: ${sent.message}`);
      outboxDone(id);
    }
    return true;
  } catch {
    return later();
  } finally {
    relay.busy--;
    relay.used = Date.now();
  }
}

/** Forgets everything waiting to go to a Gond, for one that was blocked. */
export function dropFor(peerKey: string) {
  dropOutboxFor(peerKey);
}
