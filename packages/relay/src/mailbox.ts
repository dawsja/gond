import {
  LIMITS,
  REFUSALS,
  VERSIONS,
  envelopeSize,
  inviteHash,
  randomB64,
  signedEnvelope,
  signedHello,
  verifySignature,
  type ClientFrame,
  type Envelope,
  type Refusal,
  type RelayFrame,
} from "./protocol.ts";

/**
 * The mailboxes, over any SQLite: one file for every mailbox on a self-hosted relay
 * (bun:sqlite), or each mailbox's own database inside its Durable Object on Cloudflare.
 * Rows always carry their mailbox, so both read the same.
 */

export type SqlValue = string | number | null;
export interface Sql {
  all(query: string, ...params: SqlValue[]): Record<string, SqlValue>[];
  run(query: string, ...params: SqlValue[]): void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS relay_mailboxes (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS relay_allowed (mailbox TEXT NOT NULL, sender TEXT NOT NULL, PRIMARY KEY (mailbox, sender))`,
  `CREATE TABLE IF NOT EXISTS relay_invites (mailbox TEXT NOT NULL, hash TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (mailbox, hash))`,
  `CREATE TABLE IF NOT EXISTS relay_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, mailbox TEXT NOT NULL, sender TEXT NOT NULL, id TEXT NOT NULL, held_at INTEGER NOT NULL, size INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE (mailbox, sender, id))`,
  `CREATE INDEX IF NOT EXISTS relay_queue_mailbox ON relay_queue (mailbox, seq)`,
  `CREATE TABLE IF NOT EXISTS relay_sends (key TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL)`,
];

export type Store = ReturnType<typeof createStore>;

export function createStore(sql: Sql, now: () => number = Date.now) {
  for (const statement of SCHEMA) sql.run(statement);

  const count = (query: string, ...params: SqlValue[]) => Number(sql.all(query, ...params)[0]?.n ?? 0);

  return {
    now,

    touch(key: string) {
      sql.run(`INSERT INTO relay_mailboxes (key, seen_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET seen_at = excluded.seen_at`, key, now());
    },

    allows(mailbox: string, sender: string): boolean {
      return count(`SELECT COUNT(*) AS n FROM relay_allowed WHERE mailbox = ? AND sender = ?`, mailbox, sender) > 0;
    },

    allow(mailbox: string, sender: string): Refusal | null {
      if (this.allows(mailbox, sender)) return null;
      if (count(`SELECT COUNT(*) AS n FROM relay_allowed WHERE mailbox = ?`, mailbox) >= LIMITS.allowed) return "too_many";
      sql.run(`INSERT OR IGNORE INTO relay_allowed (mailbox, sender) VALUES (?, ?)`, mailbox, sender);
      return null;
    },

    /** Stops taking a sender's envelopes and drops the ones held from them. */
    forget(mailbox: string, sender: string) {
      sql.run(`DELETE FROM relay_allowed WHERE mailbox = ? AND sender = ?`, mailbox, sender);
      sql.run(`DELETE FROM relay_queue WHERE mailbox = ? AND sender = ?`, mailbox, sender);
    },

    invite(mailbox: string, hash: string, expires: number): Refusal | null {
      const until = Math.min(expires, now() + LIMITS.inviteMs);
      const open = count(`SELECT COUNT(*) AS n FROM relay_invites WHERE mailbox = ? AND expires_at > ? AND hash != ?`, mailbox, now(), hash);
      if (open >= LIMITS.invites) return "too_many";
      sql.run(`INSERT INTO relay_invites (mailbox, hash, expires_at) VALUES (?, ?, ?) ON CONFLICT (mailbox, hash) DO UPDATE SET expires_at = excluded.expires_at`, mailbox, hash, until);
      return null;
    },

    uninvite(mailbox: string, hash: string) {
      sql.run(`DELETE FROM relay_invites WHERE mailbox = ? AND hash = ?`, mailbox, hash);
    },

    /** An invite lets one sender in, once. */
    takeInvite(mailbox: string, hash: string): boolean {
      const open = count(`SELECT COUNT(*) AS n FROM relay_invites WHERE mailbox = ? AND hash = ? AND expires_at > ?`, mailbox, hash, now()) > 0;
      sql.run(`DELETE FROM relay_invites WHERE mailbox = ? AND hash = ?`, mailbox, hash);
      return open;
    },

    enqueue(envelope: Envelope): Refusal | null {
      const size = envelopeSize(envelope);
      if (size > LIMITS.envelopeBytes) return "too_big";
      const held = sql.all(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM relay_queue WHERE mailbox = ?`, envelope.to)[0];
      if (Number(held?.n ?? 0) >= LIMITS.queued || Number(held?.bytes ?? 0) + size > LIMITS.queuedBytes) return "mailbox_full";
      sql.run(
        `INSERT OR IGNORE INTO relay_queue (mailbox, sender, id, held_at, size, body) VALUES (?, ?, ?, ?, ?, ?)`,
        envelope.to, envelope.from, envelope.id, now(), size, JSON.stringify(envelope),
      );
      return null;
    },

    pending(mailbox: string): Envelope[] {
      return sql.all(`SELECT body FROM relay_queue WHERE mailbox = ? ORDER BY seq`, mailbox).map((row) => JSON.parse(String(row.body)) as Envelope);
    },

    ack(mailbox: string, sender: string, id: string) {
      sql.run(`DELETE FROM relay_queue WHERE mailbox = ? AND sender = ? AND id = ?`, mailbox, sender, id);
    },

    /** Counts one send against the key's minute; false once it's spent. */
    spend(key: string, limit: number = LIMITS.sendsPerMinute): boolean {
      const minute = Math.floor(now() / 60_000);
      const row = sql.all(`SELECT minute, count FROM relay_sends WHERE key = ?`, key)[0];
      const used = row && Number(row.minute) === minute ? Number(row.count) : 0;
      if (used >= limit) return false;
      sql.run(`INSERT INTO relay_sends (key, minute, count) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET minute = excluded.minute, count = excluded.count`, key, minute, used + 1);
      return true;
    },

    /** Drops what waited too long, spent invites, and mailboxes nobody has opened in months. */
    sweep() {
      const at = now();
      sql.run(`DELETE FROM relay_queue WHERE held_at < ?`, at - LIMITS.queueMs);
      sql.run(`DELETE FROM relay_invites WHERE expires_at <= ?`, at);
      sql.run(`DELETE FROM relay_sends WHERE minute < ?`, Math.floor(at / 60_000) - 1);
      for (const row of sql.all(`SELECT key FROM relay_mailboxes WHERE seen_at < ?`, at - LIMITS.idleMs)) {
        const key = String(row.key);
        for (const table of ["relay_queue", "relay_allowed", "relay_invites"]) sql.run(`DELETE FROM ${table} WHERE mailbox = ?`, key);
        sql.run(`DELETE FROM relay_mailboxes WHERE key = ?`, key);
      }
    },
  };
}

export function challenge(): { nonce: string; frame: RelayFrame } {
  const nonce = randomB64(32);
  return { nonce, frame: { t: "challenge", nonce, versions: VERSIONS } };
}

/** A hello proves the socket holds the private half of the mailbox's key. */
export async function provesKey(mailbox: string, nonce: string, frame: ClientFrame | null): Promise<boolean> {
  return frame?.t === "hello" && frame.key === mailbox && (await verifySignature(frame.key, frame.sig, signedHello(nonce)));
}

/**
 * What the recipient's side does with an envelope: let it in if its sender is allowed or brings
 * a live invite, then hold it until the owner acks it. Held first, delivered after, so nothing
 * is lost to a socket that drops mid-send.
 */
export function receive(store: Store, envelope: Envelope, invite: string | null): Refusal | null {
  if (!store.allows(envelope.to, envelope.from)) {
    if (!invite || !store.takeInvite(envelope.to, invite)) return "not_allowed";
    const refused = store.allow(envelope.to, envelope.from);
    if (refused) return refused;
  }
  return store.enqueue(envelope);
}

export type Route = (envelope: Envelope, inviteHash: string | null) => Promise<Refusal | null>;

/** One frame from a mailbox's owner, once its socket has proved the key. */
export async function ownerFrame(store: Store, key: string, frame: ClientFrame, route: Route): Promise<RelayFrame | null> {
  const refused = (reason: Refusal, id?: string): RelayFrame => ({ t: "refused", id, reason, message: REFUSALS[reason] });
  switch (frame.t) {
    case "hello":
      return { t: "error", message: "This socket already said hello." };
    case "ping":
      return { t: "pong" };
    case "ack":
      store.ack(key, frame.from, frame.id);
      return null;
    case "allow": {
      const reason = store.allow(key, frame.key);
      return reason ? refused(reason) : { t: "ok", op: "allow", ref: frame.key };
    }
    case "forget":
      store.forget(key, frame.key);
      return { t: "ok", op: "forget", ref: frame.key };
    case "invite": {
      const reason = store.invite(key, frame.hash, frame.expires);
      return reason ? refused(reason) : { t: "ok", op: "invite", ref: frame.hash };
    }
    case "uninvite":
      store.uninvite(key, frame.hash);
      return { t: "ok", op: "uninvite", ref: frame.hash };
    case "send": {
      const { envelope } = frame;
      // Spent before anything is checked, so a key sending frames that fail costs its own minute too.
      if (!store.spend(key)) return refused("rate_limited", envelope.id);
      if (envelope.from !== key) return refused("not_yours", envelope.id);
      if (envelopeSize(envelope) > LIMITS.envelopeBytes) return refused("too_big", envelope.id);
      const { sig, ...signed } = envelope;
      if (!(await verifySignature(envelope.from, sig, signedEnvelope(signed)))) return refused("bad_signature", envelope.id);
      const reason = await route(envelope, frame.invite ? await inviteHash(frame.invite) : null);
      return reason ? refused(reason, envelope.id) : { t: "sent", id: envelope.id };
    }
  }
}
