import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import {
  PROTOCOL,
  fromB64,
  inviteHash,
  randomB64,
  signedEnvelope,
  signedHello,
  toB64,
  utf8,
  verifySignature,
  type Envelope,
  type ClientFrame,
  type Refusal,
  type RelayFrame,
} from "./protocol.ts";

/**
 * Gond's side of the relay: its identity, sealing and opening envelopes, and one socket to its
 * mailbox that keeps itself connected. The relay never sees a private key or a word of what's
 * inside: an envelope is HPKE (RFC 9180, X25519 + HKDF-SHA256 + AES-128-GCM) for the
 * recipient's box key, with its header as the associated data, and Ed25519-signed by the sender.
 */

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const SEAL_INFO = utf8(`gond-relay/${PROTOCOL} seal`);

/** A Gond server's keys. Keep it secret; `card` is what others get. */
export type Identity = { key: string; secret: string; box: string; boxSecret: string };

/** What a peer needs to write to you: your key, your box key, and your key's word that the box key is yours. */
export type KeyCard = { key: string; box: string; sig: string };

const boxSigned = (box: string) => utf8(`gond-relay/${PROTOCOL} box\n${box}`);
const sealedHeader = (e: Pick<Envelope, "id" | "from" | "to" | "at">) => utf8([e.id, e.from, e.to, String(e.at)].join("\n"));

export async function createIdentity(): Promise<Identity> {
  const signing = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const box = await suite.kem.generateKeyPair();
  return {
    key: toB64(await crypto.subtle.exportKey("raw", signing.publicKey)),
    secret: toB64(await crypto.subtle.exportKey("pkcs8", signing.privateKey)),
    box: toB64(await suite.kem.serializePublicKey(box.publicKey)),
    boxSecret: toB64(await suite.kem.serializePrivateKey(box.privateKey)),
  };
}

async function sign(identity: Identity, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", fromB64(identity.secret), { name: "Ed25519" }, false, ["sign"]);
  return toB64(await crypto.subtle.sign({ name: "Ed25519" }, key, message as Uint8Array<ArrayBuffer>));
}

export async function keyCard(identity: Identity): Promise<KeyCard> {
  return { key: identity.key, box: identity.box, sig: await sign(identity, boxSigned(identity.box)) };
}

export function verifyKeyCard(card: KeyCard): Promise<boolean> {
  return verifySignature(card.key, card.sig, boxSigned(card.box));
}

/** Seals `body` (anything JSON) for one peer. The id is yours to pick; it must be unique among what you send. */
export async function seal(identity: Identity, to: KeyCard, body: unknown, options: { id?: string; at?: number } = {}): Promise<Envelope> {
  if (!(await verifyKeyCard(to))) throw new Error("That key card's box key isn't signed by its key.");
  const header = { id: options.id ?? randomB64(16), from: identity.key, to: to.key, at: options.at ?? Date.now() };
  const sealed = await suite.seal(
    { recipientPublicKey: await suite.kem.deserializePublicKey(fromB64(to.box)), info: SEAL_INFO },
    utf8(JSON.stringify({ ...header, body })),
    sealedHeader(header),
  );
  const unsigned = { v: 1 as const, ...header, enc: toB64(sealed.enc), ct: toB64(sealed.ct) };
  return { ...unsigned, sig: await sign(identity, signedEnvelope(unsigned)) };
}

/** Opens an envelope sealed for you: checks its signature, decrypts it, and checks the inside names the same sender, recipient and id as the outside. */
export async function open(identity: Identity, envelope: Envelope): Promise<{ from: string; id: string; at: number; body: unknown }> {
  const { sig, ...unsigned } = envelope;
  if (envelope.to !== identity.key) throw new Error("That envelope is for another key.");
  if (!(await verifySignature(envelope.from, sig, signedEnvelope(unsigned)))) throw new Error("That envelope's signature doesn't match its sender.");
  const plain = await suite.open(
    { recipientKey: await suite.kem.deserializePrivateKey(fromB64(identity.boxSecret)), enc: fromB64(envelope.enc), info: SEAL_INFO },
    fromB64(envelope.ct),
    sealedHeader(envelope),
  );
  const inner = JSON.parse(new TextDecoder().decode(plain)) as { id: string; from: string; to: string; at: number; body: unknown };
  if (inner.id !== envelope.id || inner.from !== envelope.from || inner.to !== envelope.to || inner.at !== envelope.at) throw new Error("That envelope's inside doesn't match its outside.");
  return { from: inner.from, id: inner.id, at: inner.at, body: inner.body };
}

/** An invite token goes in the invite link; the relay is only told its hash until the invitee uses it. */
export function inviteToken(): string {
  return randomB64(32);
}

export type SendResult = { ok: true } | { ok: false; reason: Refusal; message: string };
/** "replaced": another connection with this key took the mailbox over, so this one stays off rather than fight it. */
export type RelayState = "connecting" | "ready" | "closed" | "replaced";

type Waiter = { resolve: (frame: RelayFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export type RelayClientOptions = {
  /** The relay's address, like https://api.gond.io or http://relay.lan:8791. */
  url: string;
  identity: Identity;
  /** Called once per envelope, in order; it's acked only after this resolves, so one that throws comes again on the next connection. */
  onEnvelope: (envelope: Envelope) => Promise<void> | void;
  onState?: (state: RelayState) => void;
  /** How long a request waits for an answer, connecting included. */
  timeoutMs?: number;
  /** How often a ready connection is pinged, and how long its pong may take before it's taken for dead. */
  pingMs?: number;
  pongMs?: number;
};

const PING_MS = 25_000;
const PONG_MS = 10_000;

/** One socket to this server's mailbox, kept open: it reconnects with backoff after any drop until `stop`. */
export class RelayClient {
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ready: Gate;
  private turn: Promise<void> = Promise.resolve();
  private readonly sends = new Map<string, Waiter>();
  private readonly control: Waiter[] = [];
  private readonly seen = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private waitingPong: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RelayClientOptions) {
    this.ready = gate();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.quiet();
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close(1000, "Stopped");
    this.socket = null;
    this.closeGate();
    this.failAll(new Error("The relay connection was stopped."));
    this.options.onState?.("closed");
  }

  async send(envelope: Envelope, invite?: string): Promise<SendResult> {
    const frame = await this.request({ t: "send", envelope, ...(invite ? { invite } : {}) }, (waiter) => this.sends.set(envelope.id, waiter));
    if (frame.t === "sent") return { ok: true };
    if (frame.t === "refused") return { ok: false, reason: frame.reason, message: frame.message };
    throw new Error("The relay answered a send oddly.");
  }

  allow(key: string) {
    return this.controlRequest({ t: "allow", key });
  }

  forget(key: string) {
    return this.controlRequest({ t: "forget", key });
  }

  async invite(token: string, expires: number) {
    return this.controlRequest({ t: "invite", hash: await inviteHash(token), expires });
  }

  async uninvite(token: string) {
    return this.uninviteHash(await inviteHash(token));
  }

  /** Takes back an invite by its hash, which is all a Gond keeps of a token once the link is out. */
  uninviteHash(hash: string) {
    return this.controlRequest({ t: "uninvite", hash });
  }

  private async controlRequest(frame: ClientFrame): Promise<SendResult> {
    const answer = await this.request(frame, (waiter) => this.control.push(waiter));
    return answer.t === "refused" ? { ok: false, reason: answer.reason, message: answer.message } : { ok: true };
  }

  private async request(frame: ClientFrame, register: (waiter: Waiter) => void): Promise<RelayFrame> {
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    return new Promise<RelayFrame>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => ((settled = true), reject(new Error("The relay didn't answer in time."))), timeoutMs);
      const waiter: Waiter = { resolve: (f) => (clearTimeout(timer), resolve(f)), reject: (e) => (clearTimeout(timer), reject(e)), timer };
      void this.ready.promise.then(() => {
        if (settled) return;
        register(waiter);
        this.socket?.send(JSON.stringify(frame));
      });
    });
  }

  private connect() {
    const base = this.options.url.endsWith("/") ? this.options.url : `${this.options.url}/`;
    const url = new URL("v1/connect", base);
    url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
    url.searchParams.set("key", this.options.identity.key);
    this.options.onState?.("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(String(event.data)) as RelayFrame;
      } catch {
        return;
      }
      // Envelopes reach onEnvelope one at a time, in the order the relay sent them; every other frame
      // is read at once, since onEnvelope may itself wait on an answer from the relay.
      if (frame.t === "deliver") this.turn = this.turn.then(() => this.deliver(socket, frame.envelope)).catch(() => undefined);
      else void this.receive(socket, frame);
    };
    socket.onclose = (event) => this.dropped(socket, event.code);
  }

  private dropped(socket: WebSocket, code: number) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.quiet();
    this.closeGate();
    this.failAll(new Error("The relay connection dropped."));
    if (this.stopped) return;
    if (code === 4000) {
      this.stopped = true;
      this.options.onState?.("replaced");
      return;
    }
    this.options.onState?.("closed");
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) * (0.75 + Math.random() / 2);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  /**
   * A connection can die without a close: a router or proxy dropping an idle socket, a machine that
   * slept. Nothing would notice, sends would only time out, and a Gond that only listens would never
   * hear again. So a ready connection is pinged, and one whose pong doesn't come is closed and made again.
   */
  private beat(socket: WebSocket) {
    this.quiet();
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || this.waitingPong) return;
      this.waitingPong = setTimeout(() => {
        this.waitingPong = null;
        try {
          socket.close();
        } catch {
          /* already gone */
        }
        this.dropped(socket, 1006);
      }, this.options.pongMs ?? PONG_MS);
      socket.send(JSON.stringify({ t: "ping" }));
    }, this.options.pingMs ?? PING_MS);
  }

  private quiet() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.waitingPong) clearTimeout(this.waitingPong);
    this.heartbeat = null;
    this.waitingPong = null;
  }

  private async deliver(socket: WebSocket, envelope: Envelope) {
    const seenKey = `${envelope.from}/${envelope.id}`;
    if (!this.seen.has(seenKey)) {
      try {
        await this.options.onEnvelope(envelope);
      } catch {
        return;
      }
      this.seen.add(seenKey);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    }
    socket.send(JSON.stringify({ t: "ack", id: envelope.id, from: envelope.from }));
  }

  private async receive(socket: WebSocket, frame: RelayFrame) {
    switch (frame.t) {
      case "challenge":
        socket.send(JSON.stringify({ t: "hello", key: this.options.identity.key, sig: await sign(this.options.identity, signedHello(frame.nonce)) }));
        return;
      case "ready":
        this.attempt = 0;
        this.ready.open();
        this.beat(socket);
        this.options.onState?.("ready");
        return;
      case "pong":
        if (this.waitingPong) clearTimeout(this.waitingPong);
        this.waitingPong = null;
        return;
      case "sent":
      case "refused": {
        const id = frame.id;
        const waiter = id ? this.sends.get(id) : undefined;
        if (waiter && id) {
          this.sends.delete(id);
          waiter.resolve(frame);
        } else if (frame.t === "refused") {
          this.control.shift()?.resolve(frame);
        }
        return;
      }
      case "ok":
        this.control.shift()?.resolve(frame);
        return;
      default:
        return;
    }
  }

  /** Requests made from here on wait for the next connection; ones already waiting keep waiting for it. */
  private closeGate() {
    if (this.ready.opened) this.ready = gate();
  }

  private failAll(error: Error) {
    for (const waiter of this.sends.values()) waiter.reject(error);
    this.sends.clear();
    for (const waiter of this.control.splice(0)) waiter.reject(error);
  }
}

type Gate = { promise: Promise<void>; opened: boolean; open: () => void };

function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  const g: Gate = { promise, opened: false, open: () => ((g.opened = true), resolve()) };
  return g;
}
