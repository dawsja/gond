import { REMOTE_AUTHOR, SPACE_LEVELS, type FederationPeer, type SpaceDefaults, type SpaceGond, type SpaceLevel, type SpaceMember, type SpaceRule, type SpaceStatus, type ThreadSpace } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { newId, now } from "../ids.ts";
import { keyWords } from "../words.ts";

/*
 * Spaces' rows. A space is a room here (`thread_id`) and the same room on every other Gond in it; its
 * id is the same everywhere. The Gond that made it (`host_key`) passes every line on, so a guest
 * only ever talks to the host, and the host to everyone.
 */

export type FederationRow = {
  enabled: number;
  name: string;
  relay: "gond" | "own";
  relay_url: string;
  invites: "everyone" | "admin";
  key: string | null;
  identity: string | null;
  updated_at: string;
};

export function federationRow(): FederationRow {
  const db = ensureDatabase();
  db.query("INSERT OR IGNORE INTO gond_federation (id, updated_at) VALUES (1, ?)").run(now());
  return db.query("SELECT enabled, name, relay, relay_url, invites, key, identity, updated_at FROM gond_federation WHERE id = 1").get() as FederationRow;
}

export function saveFederation(patch: Partial<Pick<FederationRow, "enabled" | "name" | "relay" | "relay_url" | "invites" | "key" | "identity">>) {
  federationRow();
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  ensureDatabase()
    .query(`UPDATE gond_federation SET ${entries.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = 1`)
    .run(...entries.map(([, value]) => value as string | number | null), now());
}

export type PeerRow = { key: string; box: string; sig: string; name: string; relay_url: string; blocked: number; last_seen: string | null };

export function getPeer(key: string): PeerRow | null {
  return ensureDatabase().query("SELECT key, box, sig, name, relay_url, blocked, last_seen FROM gond_peers WHERE key = ?").get(key) as PeerRow | null;
}

/** Records a Gond met through an invite, a join or a space; its name and relay follow what it last said. */
export function savePeer(peer: { key: string; box: string; sig: string; name: string; relayUrl: string }) {
  ensureDatabase()
    .query(
      `INSERT INTO gond_peers (key, box, sig, name, relay_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET box = excluded.box, sig = excluded.sig, name = excluded.name, relay_url = excluded.relay_url`,
    )
    .run(peer.key, peer.box, peer.sig, peer.name.slice(0, 60), peer.relayUrl, now());
}

export function touchPeer(key: string) {
  ensureDatabase().query("UPDATE gond_peers SET last_seen = ? WHERE key = ?").run(now(), key);
}

export function setPeerBlocked(key: string, blocked: boolean) {
  ensureDatabase().query("UPDATE gond_peers SET blocked = ? WHERE key = ?").run(blocked ? 1 : 0, key);
}

/** Whether this person said they read another Gond's words with someone there and they matched; only ever their own say. */
export function setPeerChecked(userId: string, key: string, checked: boolean) {
  const db = ensureDatabase();
  if (checked) db.query("INSERT OR IGNORE INTO gond_peer_checks (user_id, peer_key, checked_at) VALUES (?, ?, ?)").run(userId, key, now());
  else db.query("DELETE FROM gond_peer_checks WHERE user_id = ? AND peer_key = ?").run(userId, key);
}

export function peerChecked(userId: string, key: string): boolean {
  return Boolean(ensureDatabase().query("SELECT 1 FROM gond_peer_checks WHERE user_id = ? AND peer_key = ?").get(userId, key));
}

/** Every Gond this one knows, with whether the asking person checked its words. */
export function listPeers(userId: string): FederationPeer[] {
  const rows = ensureDatabase()
    .query(
      `SELECT p.key, p.name, EXISTS (SELECT 1 FROM gond_peer_checks c WHERE c.user_id = ? AND c.peer_key = p.key) AS verified, p.blocked, p.last_seen,
              (SELECT COUNT(*) FROM gond_space_gonds g JOIN gond_spaces s ON s.id = g.space_id WHERE g.peer_key = p.key AND s.status IN ('joining', 'active')) AS spaces
       FROM gond_peers p ORDER BY p.last_seen DESC`,
    )
    .all(userId) as { key: string; name: string; verified: number; blocked: number; last_seen: string | null; spaces: number }[];
  return rows.map((r) => ({ key: r.key, name: r.name, words: keyWords(r.key), verified: Boolean(r.verified), blocked: Boolean(r.blocked), lastSeen: r.last_seen, spaces: Number(r.spaces) }));
}

export type SpaceRow = { id: string; thread_id: string; user_id: string; host_key: string; status: SpaceStatus; created_at: string };

const SPACE_COLUMNS = "id, thread_id, user_id, host_key, status, created_at";

export function getSpace(id: string): SpaceRow | null {
  return ensureDatabase().query(`SELECT ${SPACE_COLUMNS} FROM gond_spaces WHERE id = ?`).get(id) as SpaceRow | null;
}

export function spaceOfThread(threadId: string): SpaceRow | null {
  return ensureDatabase().query(`SELECT ${SPACE_COLUMNS} FROM gond_spaces WHERE thread_id = ?`).get(threadId) as SpaceRow | null;
}

export function spacesWith(peerKey: string): SpaceRow[] {
  return ensureDatabase()
    .query(`SELECT ${SPACE_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ")} FROM gond_spaces s JOIN gond_space_gonds g ON g.space_id = s.id WHERE g.peer_key = ? AND s.status IN ('joining', 'active')`)
    .all(peerKey) as SpaceRow[];
}

export function spacesOf(userId: string): SpaceRow[] {
  return ensureDatabase().query(`SELECT ${SPACE_COLUMNS} FROM gond_spaces WHERE user_id = ? AND status IN ('joining', 'active')`).all(userId) as SpaceRow[];
}

export function allLiveSpaces(): SpaceRow[] {
  return ensureDatabase().query(`SELECT ${SPACE_COLUMNS} FROM gond_spaces WHERE status IN ('joining', 'active')`).all() as SpaceRow[];
}

export function createSpace(input: { id?: string; threadId: string; userId: string; hostKey: string; status: SpaceStatus }): SpaceRow {
  const id = input.id ?? newId("space");
  const at = now();
  ensureDatabase().query("INSERT INTO gond_spaces (id, thread_id, user_id, host_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.threadId, input.userId, input.hostKey, input.status, at, at);
  return getSpace(id)!;
}

export function setSpaceStatus(id: string, status: SpaceStatus) {
  ensureDatabase().query("UPDATE gond_spaces SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
}

export function spaceGonds(spaceId: string): string[] {
  return (ensureDatabase().query("SELECT peer_key FROM gond_space_gonds WHERE space_id = ? ORDER BY rowid").all(spaceId) as { peer_key: string }[]).map((r) => r.peer_key);
}

export function addSpaceGond(spaceId: string, peerKey: string) {
  ensureDatabase().query("INSERT OR IGNORE INTO gond_space_gonds (space_id, peer_key) VALUES (?, ?)").run(spaceId, peerKey);
}

/** Takes a Gond out of a space, with everyone who was there from it. */
export function removeSpaceGond(spaceId: string, peerKey: string) {
  transaction((db) => {
    db.query("DELETE FROM gond_space_gonds WHERE space_id = ? AND peer_key = ?").run(spaceId, peerKey);
    db.query("DELETE FROM gond_space_members WHERE space_id = ? AND peer_key = ?").run(spaceId, peerKey);
  });
}

export type MemberInput = { id: string; kind: "person" | "bot"; name: string; color: string | null };

/** The people and bots another Gond has in a space, as that Gond last said. */
export function setGondMembers(spaceId: string, peerKey: string, members: MemberInput[]) {
  transaction((db) => {
    db.query("DELETE FROM gond_space_members WHERE space_id = ? AND peer_key = ?").run(spaceId, peerKey);
    for (const m of members) {
      db.query("INSERT OR REPLACE INTO gond_space_members (space_id, peer_key, member_id, kind, name, color) VALUES (?, ?, ?, ?, ?, ?)").run(spaceId, peerKey, m.id, m.kind, m.name, m.color);
    }
  });
}

/** A member as the Gond it is from declared it in a space; null for anyone that Gond never named there. */
export function declaredMember(spaceId: string, peerKey: string, memberId: string): MemberInput | null {
  const row = ensureDatabase().query("SELECT member_id, kind, name, color FROM gond_space_members WHERE space_id = ? AND peer_key = ? AND member_id = ?").get(spaceId, peerKey, memberId) as { member_id: string; kind: "person" | "bot"; name: string; color: string | null } | null;
  return row ? { id: row.member_id, kind: row.kind, name: row.name, color: row.color } : null;
}

export function spaceMembers(spaceId: string): SpaceMember[] {
  const rows = ensureDatabase().query("SELECT member_id, peer_key, kind, name, color FROM gond_space_members WHERE space_id = ? ORDER BY rowid").all(spaceId) as { member_id: string; peer_key: string; kind: "person" | "bot"; name: string; color: string | null }[];
  return rows.map((r) => ({ id: r.member_id, kind: r.kind, name: r.name, color: r.color, gond: r.peer_key }));
}

/**
 * A line from another Gond is written here by `remote:<Gond>:<member>`: the Gond's key makes a
 * member's id its own, since two Gonds pick their ids apart.
 */
export function remoteAuthor(peerKey: string, memberId: string): string {
  return `${REMOTE_AUTHOR}${peerKey.slice(0, 12)}:${memberId}`;
}

export function memberOfAuthor(threadId: string, author: string): (SpaceMember & { gondName: string }) | null {
  if (!author.startsWith(REMOTE_AUTHOR)) return null;
  const [prefix, ...rest] = author.slice(REMOTE_AUTHOR.length).split(":");
  const memberId = rest.join(":");
  const row = ensureDatabase()
    .query(
      `SELECT m.member_id, m.peer_key, m.kind, m.name, m.color, p.name AS gond_name FROM gond_space_members m
       JOIN gond_spaces s ON s.id = m.space_id LEFT JOIN gond_peers p ON p.key = m.peer_key
       WHERE s.thread_id = ? AND m.member_id = ? AND substr(m.peer_key, 1, 12) = ?`,
    )
    .get(threadId, memberId, prefix ?? "") as { member_id: string; peer_key: string; kind: "person" | "bot"; name: string; color: string | null; gond_name: string | null } | null;
  return row ? { id: row.member_id, kind: row.kind, name: row.name, color: row.color, gond: row.peer_key, gondName: row.gond_name || "another Gond" } : null;
}

/** Who a line from another Gond is by, in any space: "Sam (Sam's Gond)", for an export or a notice. */
export function remoteName(author: string): string | null {
  if (!author.startsWith(REMOTE_AUTHOR)) return null;
  const [prefix, ...rest] = author.slice(REMOTE_AUTHOR.length).split(":");
  const row = ensureDatabase()
    .query("SELECT m.name, p.name AS gond FROM gond_space_members m LEFT JOIN gond_peers p ON p.key = m.peer_key WHERE m.member_id = ? AND substr(m.peer_key, 1, 12) = ? LIMIT 1")
    .get(rest.join(":"), prefix ?? "") as { name: string; gond: string | null } | null;
  return row ? `${row.name} (${row.gond || "another Gond"})` : null;
}

/** The Gonds in a space, `verified` as the space's own person checked them. */
export function gondsOf(space: Pick<SpaceRow, "id" | "host_key" | "user_id">): SpaceGond[] {
  return spaceGonds(space.id).map((key) => {
    const peer = getPeer(key);
    return { key, name: peer?.name || "Another Gond", words: keyWords(key), verified: peerChecked(space.user_id, key), host: key === space.host_key };
  });
}

/** What a conversation needs to draw a space; null for any other conversation. */
export function threadSpace(threadId: string, ownKey: string | null): ThreadSpace | null {
  const space = spaceOfThread(threadId);
  if (!space) return null;
  return { id: space.id, host: space.host_key === ownKey, status: space.status, gonds: gondsOf(space), members: spaceMembers(space.id) };
}

export function spaceDefaults(userId: string): SpaceDefaults {
  const row = ensureDatabase().query("SELECT space_level, space_bots FROM gond_user_prefs WHERE user_id = ?").get(userId) as { space_level: string | null; space_bots: string | null } | null;
  const stored = SPACE_LEVELS.includes(row?.space_level as SpaceLevel) ? (row!.space_level as SpaceLevel) : "talk";
  // Always allow is never a default: it is chosen for one bot in one space.
  const level = stored === "full" ? "act" : stored;
  // No bot joins a space until the person picks it; "*" is every bot, new ones included.
  if (row?.space_bots === ALL_BOTS) return { level, bots: null };
  try {
    const parsed = row?.space_bots ? (JSON.parse(row.space_bots) as unknown) : [];
    return { level, bots: Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [] };
  } catch {
    return { level, bots: [] };
  }
}

const ALL_BOTS = "*";

export function setSpaceDefaults(userId: string, defaults: SpaceDefaults) {
  ensureDatabase()
    .query("INSERT INTO gond_user_prefs (user_id, space_level, space_bots, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET space_level = excluded.space_level, space_bots = excluded.space_bots, updated_at = excluded.updated_at")
    .run(userId, defaults.level, defaults.bots ? JSON.stringify(defaults.bots) : ALL_BOTS, now());
}

/** A bot's rules in a space; one with none yet has the owner's default level, memory and other bots off. */
export function ruleOf(spaceId: string, botId: string, userId: string): SpaceRule {
  const row = ensureDatabase().query("SELECT level, memory, people_wake, bots_wake, relay FROM gond_space_rules WHERE space_id = ? AND bot_id = ?").get(spaceId, botId) as { level: SpaceLevel; memory: number; people_wake: number; bots_wake: number; relay: number } | null;
  return row
    ? { botId, level: row.level, memory: Boolean(row.memory), peopleWake: Boolean(row.people_wake), botsWake: Boolean(row.bots_wake), relay: Boolean(row.relay) }
    : { botId, level: spaceDefaults(userId).level, memory: false, peopleWake: true, botsWake: false, relay: false };
}

export function setRule(spaceId: string, rule: SpaceRule) {
  ensureDatabase()
    .query("INSERT INTO gond_space_rules (space_id, bot_id, level, memory, people_wake, bots_wake, relay) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (space_id, bot_id) DO UPDATE SET level = excluded.level, memory = excluded.memory, people_wake = excluded.people_wake, bots_wake = excluded.bots_wake, relay = excluded.relay")
    .run(spaceId, rule.botId, rule.level, rule.memory ? 1 : 0, rule.peopleWake ? 1 : 0, rule.botsWake ? 1 : 0, rule.relay ? 1 : 0);
}

/** Puts every bot on Always allow in a space back to asking first; the bots it changed. */
export function endAlwaysAllow(spaceId: string): string[] {
  const rows = ensureDatabase().query("UPDATE gond_space_rules SET level = 'act' WHERE space_id = ? AND level = 'full' RETURNING bot_id").all(spaceId) as { bot_id: string }[];
  return rows.map((r) => r.bot_id);
}

export function saveInvite(input: { hash: string; spaceId: string; userId: string; expiresAt: string }) {
  ensureDatabase().query("INSERT INTO gond_space_invites (hash, space_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(input.hash, input.spaceId, input.userId, input.expiresAt, now());
}

/** The invites to a space nobody has used yet and that are still good, by hash, for the relay to forget. */
export function openInvites(spaceId: string): string[] {
  return (ensureDatabase().query("SELECT hash FROM gond_space_invites WHERE space_id = ? AND used_by IS NULL AND expires_at > ?").all(spaceId, now()) as { hash: string }[]).map((r) => r.hash);
}

/** Spends an invite for one Gond: the space it opens, or null when it's unknown, used or out of date. */
export function takeInvite(hash: string, spaceId: string, by: string): string | null {
  return transaction((db) => {
    const row = db.query("SELECT space_id, expires_at, used_by FROM gond_space_invites WHERE hash = ?").get(hash) as { space_id: string; expires_at: string; used_by: string | null } | null;
    if (!row || row.space_id !== spaceId || row.expires_at <= now()) return null;
    if (row.used_by && row.used_by !== by) return null;
    db.query("UPDATE gond_space_invites SET used_by = ? WHERE hash = ?").run(by, hash);
    return row.space_id;
  });
}

export function linkLine(spaceId: string, lineId: string, messageId: string) {
  ensureDatabase().query("INSERT OR IGNORE INTO gond_space_lines (space_id, line_id, message_id) VALUES (?, ?, ?)").run(spaceId, lineId, messageId);
}

export function messageOfLine(spaceId: string, lineId: string): string | null {
  const row = ensureDatabase().query("SELECT message_id FROM gond_space_lines WHERE space_id = ? AND line_id = ?").get(spaceId, lineId) as { message_id: string } | null;
  return row?.message_id ?? null;
}

export function lineOfMessage(messageId: string): string | null {
  const row = ensureDatabase().query("SELECT line_id FROM gond_space_lines WHERE message_id = ?").get(messageId) as { line_id: string } | null;
  return row?.line_id ?? null;
}

/** Whether an envelope from this Gond arrived before; the first time also marks it, so a resent one is dropped. */
export function firstSight(peerKey: string, envelopeId: string): boolean {
  const changes = ensureDatabase().query("INSERT OR IGNORE INTO gond_space_seen (peer_key, envelope_id, at) VALUES (?, ?, ?)").run(peerKey, envelopeId, now()).changes;
  return changes > 0;
}

export type OutboxRow = { id: string; peer_key: string; body: string; attempts: number; next_at: string; created_at: string };

export function enqueue(peerKey: string, body: unknown): string {
  const id = newId("env").replace(/[^A-Za-z0-9_-]/g, "");
  const at = now();
  ensureDatabase().query("INSERT INTO gond_space_outbox (id, peer_key, body, next_at, created_at) VALUES (?, ?, ?, ?, ?)").run(id, peerKey, JSON.stringify(body), at, at);
  return id;
}

/**
 * What can go now, oldest first. A Gond's rows go in the order they were written (rowid, since two
 * can share a millisecond), and none goes while an older one to that Gond is still waiting out its
 * retry: a line must never arrive ahead of the members list that names its author.
 */
export function dueOutbox(limit = 50): OutboxRow[] {
  const at = now();
  return ensureDatabase()
    .query(
      `SELECT o.id, o.peer_key, o.body, o.attempts, o.next_at, o.created_at FROM gond_space_outbox o
       WHERE o.next_at <= ? AND NOT EXISTS (SELECT 1 FROM gond_space_outbox e WHERE e.peer_key = o.peer_key AND e.rowid < o.rowid AND e.next_at > ?)
       ORDER BY o.rowid LIMIT ?`,
    )
    .all(at, at, limit) as OutboxRow[];
}

export function outboxDone(id: string) {
  ensureDatabase().query("DELETE FROM gond_space_outbox WHERE id = ?").run(id);
}

export function outboxLater(id: string, nextAt: string) {
  ensureDatabase().query("UPDATE gond_space_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?").run(nextAt, id);
}

/** What waits for Gonds on this relay goes on the next flush, however long its backoff was. */
export function outboxDueNow(relayUrl: string) {
  ensureDatabase().query("UPDATE gond_space_outbox SET next_at = ? WHERE peer_key IN (SELECT key FROM gond_peers WHERE relay_url = ?)").run(now(), relayUrl);
}

export function dropOutboxFor(peerKey: string) {
  ensureDatabase().query("DELETE FROM gond_space_outbox WHERE peer_key = ?").run(peerKey);
}

/** Forgets envelope ids old enough that anything that old is refused anyway, and gives up on what never went. */
export function sweepSpaces(before: { seen: string; outbox: string }) {
  const db = ensureDatabase();
  db.query("DELETE FROM gond_space_seen WHERE at < ?").run(before.seen);
  db.query("DELETE FROM gond_space_outbox WHERE created_at < ?").run(before.outbox);
  db.query("DELETE FROM gond_space_invites WHERE expires_at < ?").run(before.outbox);
}
