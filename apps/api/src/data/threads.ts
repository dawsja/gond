import { isNoteKind, isWatchRun, plainMarkdown, QUOTE_CHARS, routineName, type ChatAttachment, type Quote, type Message, type MessageAuthor, type MessageKind, type NoteKind, type Reaction, type ReactionEmoji, type Thread } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { botsChanged, emit, threadChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { federationRow, threadSpace } from "./spaces.ts";

/** What happened to a conversation, for Spaces to pass on: a message posted, or a room's bots changed. */
type ThreadEvent = { type: "posted"; message: Message } | { type: "room"; threadId: string };
type ThreadListener = (event: ThreadEvent) => void;
const listenerHolder = globalThis as typeof globalThis & { __gondThreadListeners?: Set<ThreadListener> };
const threadListeners = () => (listenerHolder.__gondThreadListeners ??= new Set());

export function onThreadEvent(listener: ThreadListener): () => void {
  threadListeners().add(listener);
  return () => void threadListeners().delete(listener);
}

function tell(event: ThreadEvent) {
  for (const listener of threadListeners()) {
    try {
      listener(event);
    } catch (error) {
      console.error("[gond] a conversation listener failed:", error);
    }
  }
}

type ThreadRow = {
  id: string;
  kind: "bot" | "room";
  bot_id: string | null;
  name: string;
  last_read_at: string | null;
  user_id: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  thread_id: string;
  author: string;
  kind: MessageKind;
  body: string;
  attachments: string;
  depth: number;
  approval_id: string | null;
  from_thread_id: string | null;
  claimed_by: string | null;
  answered_at: string | null;
  steered: number;
  spoken: number;
  note: string | null;
  sent_to: string | null;
  reply_to: string | null;
  answering: string | null;
  check_in: number;
  created_at: string;
};

function parseAttachments(text: string): ChatAttachment[] {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? (value as ChatAttachment[]) : [];
  } catch {
    return [];
  }
}

function parseSentTo(text: string | null): string[] | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

type QuotedRow = Pick<MessageRow, "id" | "author" | "body" | "attachments">;

function messageFrom(row: MessageRow, reactions: Reaction[], quote: Quote | null): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    author: row.author,
    kind: row.kind,
    body: row.body,
    attachments: parseAttachments(row.attachments),
    depth: row.depth,
    approvalId: row.approval_id,
    fromThreadId: row.from_thread_id,
    steered: row.steered === 1,
    spoken: row.spoken === 1,
    note: isNoteKind(row.note) ? row.note : null,
    sentTo: parseSentTo(row.sent_to),
    reactions,
    replyTo: quote,
    answering: row.answering,
    waiting: isUnread(row),
    ...(row.check_in === 1 ? { checkIn: true } : {}),
    createdAt: row.created_at,
  };
}

/** The SQL twin of `isUnread`, for a change that must not race the dispatcher's claim. */
const UNREAD = "kind = 'message' AND author = 'you' AND answered_at IS NULL AND claimed_by IS NULL AND steered = 0";

function isUnread(row: Pick<MessageRow, "kind" | "author" | "answered_at" | "claimed_by" | "steered">): boolean {
  return row.kind === "message" && row.author === "you" && row.answered_at === null && row.claimed_by === null && row.steered === 0;
}

function toMessage(row: MessageRow): Message {
  return messageFrom(row, reactionsOf(row.id), row.reply_to ? quoteOf(row.reply_to) : null);
}

/** A page of messages with their reactions and quotes: two queries for the lot rather than two each. */
function toMessages(rows: MessageRow[]): Message[] {
  if (rows.length === 0) return [];
  const db = ensureDatabase();
  // One statement whatever the page's size: the ids go in as a JSON array.
  const reactionRows = db
    .query("SELECT message_id, author, emoji FROM gond_message_reactions WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid")
    .all(JSON.stringify(rows.map((row) => row.id))) as ({ message_id: string } & Reaction)[];
  const reactions = new Map<string, Reaction[]>();
  for (const { message_id, author, emoji } of reactionRows) reactions.set(message_id, [...(reactions.get(message_id) ?? []), { author, emoji }]);
  const quotedIds = [...new Set(rows.flatMap((row) => (row.reply_to ? [row.reply_to] : [])))];
  const quoted = new Map<string, QuotedRow>();
  if (quotedIds.length) {
    const found = db.query("SELECT id, author, body, attachments FROM gond_messages WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(quotedIds)) as QuotedRow[];
    for (const row of found) quoted.set(row.id, row);
  }
  return rows.map((row) => messageFrom(row, reactions.get(row.id) ?? [], row.reply_to ? quoteFrom(row.reply_to, quoted.get(row.reply_to) ?? null) : null));
}

/** A message as a reply quotes it; null once it is gone. */
function quoteOf(id: string): Quote | null {
  return quoteFrom(id, ensureDatabase().query("SELECT id, author, body, attachments FROM gond_messages WHERE id = ?").get(id) as QuotedRow | null);
}

/**
 * A message asking one question with choices is quoted as that question and its options, whatever
 * came before, so a pick sent as a reply says what it answers.
 */
function quotedWords(body: string): string {
  const rows = [...body.matchAll(/::choices\[[^\]]*\]/g)];
  if (rows.length !== 1) return plainMarkdown(body);
  const question = body.slice(0, rows[0]!.index).trimEnd().split(/\n\s*\n/).at(-1) ?? "";
  return plainMarkdown(`${question}\n\n${rows[0]![0]}`);
}

function quoteFrom(id: string, row: QuotedRow | null): Quote | null {
  if (!row) return null;
  const words = quotedWords(row.body);
  const text = words || parseAttachments(row.attachments)[0]?.name || "";
  return { id, author: row.author, text: text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1)}…` : text };
}

export function reactionsOf(messageId: string): Reaction[] {
  return ensureDatabase().query("SELECT author, emoji FROM gond_message_reactions WHERE message_id = ? ORDER BY created_at, rowid").all(messageId) as Reaction[];
}

/** Puts one author's reaction on a message, replacing theirs, or takes it off with null. */
export function setReaction(message: Message, author: MessageAuthor, emoji: ReactionEmoji | null): Reaction[] {
  const db = ensureDatabase();
  if (emoji) {
    db.query(
      "INSERT INTO gond_message_reactions (message_id, author, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (message_id, author) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at",
    ).run(message.id, author, emoji, now());
  } else {
    db.query("DELETE FROM gond_message_reactions WHERE message_id = ? AND author = ?").run(message.id, author);
  }
  const reactions = reactionsOf(message.id);
  emit({ topic: "reactions", threadId: message.threadId, messageId: message.id, reactions });
  return reactions;
}

function members(threadId: string): string[] {
  const rows = ensureDatabase().query("SELECT bot_id FROM gond_thread_members WHERE thread_id = ? ORDER BY rowid").all(threadId) as { bot_id: string }[];
  return rows.map((r) => r.bot_id);
}

function noticedIn(row: ThreadRow): Thread["noticed"] {
  const db = ensureDatabase();
  const run = db.query("SELECT body, created_at FROM gond_messages WHERE thread_id = ? AND author = 'routine' ORDER BY created_at DESC LIMIT 1").get(row.id) as { body: string; created_at: string } | null;
  if (!run || !isWatchRun(run.body)) return null;
  const said = db
    .query("SELECT body, created_at FROM gond_messages WHERE thread_id = ? AND kind = 'message' AND spoken = 0 AND author NOT IN ('you', 'system', 'routine') AND created_at > ? AND created_at > ? ORDER BY created_at LIMIT 1")
    .get(row.id, run.created_at, row.last_read_at ?? "") as { body: string; created_at: string } | null;
  return said ? { watch: routineName(run.body) ?? "", body: said.body, at: said.created_at } : null;
}

function toThread(row: ThreadRow): Thread {
  const db = ensureDatabase();
  // A line with `from_thread_id` is bots talking to each other (a teammate's message, a handoff, its
  // result, an incident): it shows in the conversation as an exchange, so it is never the line the list
  // previews, dates or sorts by, and only marks the conversation as quietly new.
  const last = db
    .query("SELECT author, body, created_at FROM gond_messages WHERE thread_id = ? AND kind IN ('message', 'approval', 'signin', 'teach') AND from_thread_id IS NULL AND spoken = 0 ORDER BY created_at DESC LIMIT 1")
    .get(row.id) as { author: string; body: string; created_at: string } | null;
  const unread = db
    .query("SELECT COUNT(*) AS n, COUNT(from_thread_id) AS team FROM gond_messages WHERE thread_id = ? AND author NOT IN ('you') AND kind IN ('message', 'approval', 'signin', 'teach') AND spoken = 0 AND created_at > ?")
    .get(row.id, row.last_read_at ?? "") as { n: number; team: number };
  return {
    id: row.id,
    userId: row.user_id ?? "",
    kind: row.kind,
    botId: row.bot_id,
    name: row.name,
    members: members(row.id),
    pinned: row.kind === "room" && Boolean(row.pinned),
    lastMessage: last ? { author: last.author, body: last.body, at: last.created_at } : null,
    unread: Number(unread.n) - Number(unread.team),
    unreadTeam: Number(unread.team) > 0 && Number(unread.n) === Number(unread.team),
    noticed: noticedIn(row),
    space: row.kind === "room" ? threadSpace(row.id, federationRow().key) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getThread(id: string): Thread | null {
  const row = ensureDatabase().query("SELECT * FROM gond_threads WHERE id = ?").get(id) as ThreadRow | null;
  return row ? toThread(row) : null;
}

export function listThreads(options: { kind?: "bot" | "room"; userId?: string } = {}): Thread[] {
  const where: string[] = [];
  const params: string[] = [];
  if (options.kind) {
    where.push("kind = ?");
    params.push(options.kind);
  }
  if (options.userId) {
    where.push("user_id = ?");
    params.push(options.userId);
  }
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_threads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`)
    .all(...params) as ThreadRow[];
  return rows.map(toThread);
}

export type ThreadRef = Pick<Thread, "id" | "kind" | "name">;

/** A person's conversations by id, kind and name: what a lookup needs, without each one's last message and counts. */
export function threadRefs(userId: string): ThreadRef[] {
  return ensureDatabase().query("SELECT id, kind, name FROM gond_threads WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as ThreadRef[];
}

export function threadOwner(threadId: string): string | null {
  const row = ensureDatabase().query("SELECT user_id FROM gond_threads WHERE id = ?").get(threadId) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

export function createRoom(name: string, botIds: string[], userId: string): Thread {
  const id = newId("room");
  const at = now();
  transaction((db) => {
    db.query("INSERT INTO gond_threads (id, kind, bot_id, name, user_id, created_at, updated_at) VALUES (?, 'room', NULL, ?, ?, ?, ?)").run(id, name, userId, at, at);
    for (const botId of new Set(botIds)) db.query("INSERT INTO gond_thread_members (thread_id, bot_id) VALUES (?, ?)").run(id, botId);
  });
  botsChanged(userId);
  return getThread(id)!;
}

export function updateRoom(id: string, patch: { name?: string; members?: string[]; pinned?: boolean }): Thread | null {
  const thread = getThread(id);
  if (!thread || thread.kind !== "room") return null;
  transaction((db) => {
    if (patch.name) db.query("UPDATE gond_threads SET name = ?, updated_at = ? WHERE id = ?").run(patch.name, now(), id);
    if (patch.pinned !== undefined) db.query("UPDATE gond_threads SET pinned = ? WHERE id = ?").run(patch.pinned ? 1 : 0, id);
    if (patch.members) {
      db.query("DELETE FROM gond_thread_members WHERE thread_id = ?").run(id);
      for (const botId of new Set(patch.members)) db.query("INSERT INTO gond_thread_members (thread_id, bot_id) VALUES (?, ?)").run(id, botId);
    }
  });
  botsChanged(thread.userId);
  if (patch.members) tell({ type: "room", threadId: id });
  return getThread(id);
}

export function deleteRoom(id: string): boolean {
  const thread = getThread(id);
  if (!thread || thread.kind !== "room") return false;
  ensureDatabase().query("DELETE FROM gond_threads WHERE id = ?").run(id);
  botsChanged(thread.userId);
  return true;
}

export function markThreadRead(id: string) {
  ensureDatabase().query("UPDATE gond_threads SET last_read_at = ? WHERE id = ?").run(now(), id);
  botsChanged(threadOwner(id));
}

type NewMessage = {
  threadId: string;
  author: MessageAuthor;
  body: string;
  kind?: MessageKind;
  attachments?: ChatAttachment[];
  depth?: number;
  approvalId?: string | null;
  fromThreadId?: string | null;

  answered?: boolean;

  wake?: boolean;

  steered?: boolean;
  /** Said on a call: kept for the bot, never shown, previewed, counted or searched. */
  spoken?: boolean;
  /** A note between bots: an action to act on, or information. */
  note?: NoteKind | null;

  replyTo?: string | null;

  answering?: string | null;
  /** A room line for the router: held back from the dispatcher until `routed` says whom it is for. */
  routing?: boolean;
  /** The primary bot's line from a check-in. */
  checkIn?: boolean;
};

export function postMessage(input: NewMessage): Message {
  const id = newId("m");
  const at = now();
  const kind = input.kind ?? "message";
  const needsAnswer = !input.answered && !input.steered && ((kind === "message" && (input.author === "you" || input.author === "routine" || Boolean(input.fromThreadId) || Boolean(input.wake))) || kind === "prompt");
  transaction((db) => {
    db.query(
      `INSERT INTO gond_messages (id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, answered_at, steered, spoken, note, reply_to, answering, claimed_by, check_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.threadId, input.author, kind, input.body, JSON.stringify(input.attachments ?? []), input.depth ?? 0, input.approvalId ?? null, input.fromThreadId ?? null, needsAnswer ? null : at, input.steered ? 1 : 0, input.spoken ? 1 : 0, input.note ?? null, input.replyTo ?? null, input.answering ?? null, needsAnswer && input.routing ? ROUTING : null, input.checkIn ? 1 : 0, at);
    db.query("UPDATE gond_threads SET updated_at = ? WHERE id = ?").run(at, input.threadId);
    if (input.author === "you") db.query("UPDATE gond_threads SET last_read_at = ? WHERE id = ?").run(at, input.threadId);
    for (const file of input.attachments ?? []) db.query("UPDATE gond_attachments SET message_id = ? WHERE id = ?").run(id, file.id);
  });
  threadChanged(input.threadId);
  const message = getMessage(id)!;
  tell({ type: "posted", message });
  return message;
}

/** The claim a room line holds while the router decides whom it is for, so no turn takes it first. */
const ROUTING = "routing";

/** Records whom the router judged a line was for. */
export function setSentTo(id: string, botIds: string[]) {
  ensureDatabase().query("UPDATE gond_messages SET sent_to = ? WHERE id = ?").run(JSON.stringify(botIds), id);
}

/** The message a bot's line in a room was answering, if it was one. */
export function answeringOf(id: string): Message | null {
  const row = ensureDatabase().query("SELECT answering FROM gond_messages WHERE id = ?").get(id) as { answering: string | null } | null;
  return row?.answering ? getMessage(row.answering) : null;
}

/**
 * Takes back a person's line no bot has read yet, with its files; false when a bot already took it.
 * One statement decides, so it can't race the dispatcher's claim.
 */
export function unsendMessage(id: string): boolean {
  const message = transaction((db) => {
    const row = db.query(`DELETE FROM gond_messages WHERE id = ? AND ${UNREAD} RETURNING thread_id`).get(id) as { thread_id: string } | null;
    if (row) db.query("DELETE FROM gond_attachments WHERE message_id = ?").run(id);
    return row;
  });
  if (!message) return false;
  threadChanged(message.thread_id, true);
  return true;
}

/** Rewrites a person's line no bot has read yet; null when a bot already took it. */
export function editMessage(id: string, body: string): Message | null {
  const row = ensureDatabase().query(`UPDATE gond_messages SET body = ? WHERE id = ? AND ${UNREAD} RETURNING *`).get(body, id) as MessageRow | null;
  if (!row) return null;
  threadChanged(row.thread_id, true);
  return toMessage(row);
}

/** The failure lines and setup cards that say a turn couldn't answer this message, for Try again to clear. */
export function failuresAnswering(message: Pick<Message, "id" | "threadId">, setupCard: string): Message[] {
  const rows = ensureDatabase()
    .query("SELECT * FROM gond_messages WHERE thread_id = ? AND answering = ? AND ((kind = 'event' AND author = 'system') OR (kind = 'signin' AND approval_id = ?))")
    .all(message.threadId, message.id, setupCard) as MessageRow[];
  return toMessages(rows);
}

/** Every card of this kind in the person's conversations, oldest first. */
export function cardsOf(userId: string, approvalId: string): Message[] {
  const rows = ensureDatabase()
    .query("SELECT m.* FROM gond_messages m JOIN gond_threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.kind = 'signin' AND m.approval_id = ? ORDER BY m.rowid")
    .all(userId, approvalId) as MessageRow[];
  return toMessages(rows);
}

/** The people with a card of this kind in any conversation. */
export function cardHolders(approvalId: string): string[] {
  const rows = ensureDatabase()
    .query("SELECT DISTINCT t.user_id AS user FROM gond_messages m JOIN gond_threads t ON t.id = m.thread_id WHERE m.kind = 'signin' AND m.approval_id = ? AND t.user_id IS NOT NULL")
    .all(approvalId) as { user: string }[];
  return rows.map((row) => row.user);
}

/** Takes a message out of its conversation, as a routine run with nothing to say does. */
export function dropMessage(id: string) {
  const message = getMessage(id);
  if (!message) return;
  ensureDatabase().query("DELETE FROM gond_messages WHERE id = ?").run(id);
  threadChanged(message.threadId, true);
}

export function getMessage(id: string): Message | null {
  const row = ensureDatabase().query("SELECT * FROM gond_messages WHERE id = ?").get(id) as MessageRow | null;
  return row ? toMessage(row) : null;
}

/** `shown` is what the person sees: what was said on a call stays the bot's. */
export function listMessages(threadId: string, options: { after?: string | null; before?: string | null; limit?: number; includeSent?: boolean; shown?: boolean } = {}): Message[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const db = ensureDatabase();
  const where = `${options.includeSent ? "(thread_id = ? OR from_thread_id = ?)" : "thread_id = ?"}${options.shown ? " AND spoken = 0" : ""}`;
  const ids = options.includeSent ? [threadId, threadId] : [threadId];
  if (options.after) {
    const rows = db.query(`SELECT * FROM gond_messages WHERE ${where} AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT ?`).all(...ids, options.after, limit) as MessageRow[];
    return toMessages(rows);
  }
  const rows = db
    .query(`SELECT * FROM gond_messages WHERE ${where} ${options.before ? "AND created_at < ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...(options.before ? [...ids, options.before, limit] : [...ids, limit])) as MessageRow[];
  return toMessages(rows.reverse());
}

export function listExchange(threadId: string, withThreadId: string, limit = 500): Message[] {
  const rows = ensureDatabase()
    .query(
      `SELECT * FROM gond_messages WHERE kind = 'message' AND ((thread_id = ? AND from_thread_id = ?) OR (thread_id = ? AND from_thread_id = ?)) ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(threadId, withThreadId, withThreadId, threadId, limit) as MessageRow[];
  return toMessages(rows);
}

export function recentMessages(threadId: string, count: number): Message[] {
  const rows = ensureDatabase()
    .query("SELECT * FROM gond_messages WHERE thread_id = ? AND kind IN ('message', 'approval', 'signin', 'teach') ORDER BY created_at DESC LIMIT ?")
    .all(threadId, count) as MessageRow[];
  return toMessages(rows.reverse());
}

/** The words of a search, each matched anywhere in a message (case aside), in any order. */
function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

/**
 * Words of three characters or more go through the trigram index, walked from the newest message
 * back so a common word stops at the limit instead of sorting every match; shorter words, which a
 * trigram index can't hold, are checked with LIKE (and alone, scan newest first as before).
 * Messages are written in time order, so the index's rowid order is newest first.
 */
export function searchMessages(query: string, userId: string, limit = 50): Message[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const indexed = terms.filter((term) => [...term].length >= 3);
  const likes = terms.filter((term) => [...term].length < 3).map((term) => `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  const short = likes.map(() => "AND m.body LIKE ? ESCAPE '\\'").join(" ");
  const db = ensureDatabase();
  const rows = indexed.length
    ? db
        .query(
          `SELECT m.* FROM (SELECT rowid AS r FROM gond_messages_fts WHERE gond_messages_fts MATCH ? ORDER BY rowid DESC) f
           JOIN gond_messages m ON m.rowid = f.r JOIN gond_threads t ON t.id = m.thread_id
           WHERE t.user_id = ? AND m.kind = 'message' AND m.spoken = 0 ${short} LIMIT ?`,
        )
        .all(indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "), userId, ...likes, limit)
    : db.query(`SELECT m.* FROM gond_messages m JOIN gond_threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.kind = 'message' AND m.spoken = 0 ${short} ORDER BY m.created_at DESC LIMIT ?`).all(userId, ...likes, limit);
  return toMessages(rows as MessageRow[]);
}

export function claimPendingMessages(owner: string, room: (userId: string) => number): Message[] {
  return transaction((db) => {
    const rows = db
      .query(
        `SELECT m.*, t.user_id AS owner_id FROM gond_messages m LEFT JOIN gond_threads t ON t.id = m.thread_id
         WHERE m.answered_at IS NULL AND m.claimed_by IS NULL AND m.kind IN ('message', 'prompt') ORDER BY m.created_at ASC`,
      )
      .all() as (MessageRow & { owner_id: string | null })[];
    const taken = new Map<string, number>();
    const claimed: Message[] = [];
    for (const row of rows) {
      const userId = row.owner_id ?? "";
      const count = taken.get(userId) ?? 0;
      if (count >= room(userId)) continue;
      taken.set(userId, count + 1);
      db.query("UPDATE gond_messages SET claimed_by = ? WHERE id = ?").run(owner, row.id);
      claimed.push(toMessage(row));
    }
    return claimed;
  });
}

export function botLinesSincePerson(threadId: string): number {
  const row = ensureDatabase()
    .query(
      `SELECT COUNT(*) AS n FROM gond_messages WHERE thread_id = ? AND kind = 'message' AND author NOT IN ('you', 'system', 'routine')
       AND created_at > COALESCE((SELECT MAX(created_at) FROM gond_messages WHERE thread_id = ? AND author = 'you'), '')`,
    )
    .get(threadId, threadId) as { n: number };
  return row.n;
}

/**
 * Whether the bot in `ownThreadId` opened its exchange with `otherThreadId`: since the last line
 * that set it working there (the person's, a routine's or Gond's), its first line to the other bot
 * came before any line of the other's to it, so what the other says back is part of that errand.
 */
export function openedExchange(ownThreadId: string, otherThreadId: string, before: string): boolean {
  const row = ensureDatabase()
    .query(
      `SELECT thread_id FROM gond_messages
       WHERE ((thread_id = ?1 AND from_thread_id = ?2) OR (thread_id = ?2 AND from_thread_id = ?1))
         AND author NOT IN ('you', 'system', 'routine') AND created_at < ?3
         AND created_at > COALESCE((SELECT MAX(created_at) FROM gond_messages WHERE thread_id = ?2 AND author IN ('you', 'system', 'routine') AND created_at < ?3), '')
       ORDER BY created_at, rowid LIMIT 1`,
    )
    .get(otherThreadId, ownThreadId, before) as { thread_id: string } | null;
  return row?.thread_id === otherThreadId;
}

/**
 * Whether the bot in `ownThreadId` asked the bot in `otherThreadId` to act, on the errand it is on
 * now, so a line back from the other is a report it waits on; false while one already waits.
 */
export function awaitsReport(ownThreadId: string, otherThreadId: string, at: string): boolean {
  if (!openedExchange(ownThreadId, otherThreadId, at)) return false;
  const row = ensureDatabase()
    .query(
      `SELECT
         EXISTS (SELECT 1 FROM gond_messages WHERE thread_id = ?2 AND from_thread_id = ?1 AND note = 'action' AND created_at < ?3
           AND created_at > COALESCE((SELECT MAX(created_at) FROM gond_messages WHERE thread_id = ?1 AND author IN ('you', 'system', 'routine') AND created_at < ?3), '')) AS asked,
         EXISTS (SELECT 1 FROM gond_messages WHERE thread_id = ?1 AND from_thread_id = ?2 AND answered_at IS NULL) AS waiting`,
    )
    .get(ownThreadId, otherThreadId, at) as { asked: number; waiting: number };
  return Boolean(row.asked) && !row.waiting;
}

export function markAnswered(id: string) {
  ensureDatabase().query("UPDATE gond_messages SET answered_at = ?, claimed_by = NULL WHERE id = ?").run(now(), id);
}

export function closePending(threadId: string): number {
  const changed = ensureDatabase()
    .query("UPDATE gond_messages SET answered_at = ?, claimed_by = NULL WHERE thread_id = ? AND answered_at IS NULL AND kind IN ('message', 'prompt')")
    .run(now(), threadId).changes;
  if (changed) threadChanged(threadId);
  return changed;
}

export function closeSentFrom(threadId: string, since: string | null = null): number {
  const db = ensureDatabase();
  const where = `from_thread_id = ? AND thread_id != ? AND answered_at IS NULL ${since ? "AND created_at >= ?" : ""}`;
  const args = since ? [threadId, threadId, since] : [threadId, threadId];
  const threads = db.query(`SELECT DISTINCT thread_id FROM gond_messages WHERE ${where}`).all(...args) as { thread_id: string }[];
  const changed = db.query(`UPDATE gond_messages SET answered_at = ?, claimed_by = NULL WHERE ${where}`).run(now(), ...args).changes;
  for (const row of threads) threadChanged(row.thread_id);
  return changed;
}

/** Whether a line is still held for the router, not answered or stopped in the meantime. */
export function stillRouting(id: string): boolean {
  return Boolean(ensureDatabase().query("SELECT 1 FROM gond_messages WHERE id = ? AND claimed_by = ? AND answered_at IS NULL").get(id, ROUTING));
}

/** A routed line that every bot it is for took mid-answer: it needs no turn of its own. */
export function markSteered(id: string) {
  ensureDatabase().query("UPDATE gond_messages SET steered = 1, answered_at = ?, claimed_by = NULL WHERE id = ? AND answered_at IS NULL").run(now(), id);
}

export function unsteer(id: string) {
  const message = getMessage(id);
  if (!message) return;
  ensureDatabase().query("UPDATE gond_messages SET steered = 0, answered_at = NULL, claimed_by = NULL WHERE id = ?").run(id);
  threadChanged(message.threadId);
}

export function releaseClaim(id: string) {
  ensureDatabase().query("UPDATE gond_messages SET claimed_by = NULL WHERE id = ?").run(id);
}

export function threadBusy(threadId: string): boolean {
  const row = ensureDatabase().query("SELECT COUNT(*) AS n FROM gond_messages WHERE thread_id = ? AND answered_at IS NULL AND kind = 'message'").get(threadId) as { n: number };
  return Number(row.n) > 0;
}

export function storeAttachment(file: { name: string; mediaType: string; data: Uint8Array }): ChatAttachment {
  const id = newId("f");
  ensureDatabase()
    .query("INSERT INTO gond_attachments (id, message_id, name, media_type, size, data, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)")
    .run(id, file.name, file.mediaType, file.data.byteLength, file.data, now());
  return { id, name: file.name, mediaType: file.mediaType, size: file.data.byteLength };
}

export function attachmentOwner(id: string): string | null {
  const row = ensureDatabase()
    .query("SELECT t.user_id FROM gond_attachments a JOIN gond_messages m ON m.id = a.message_id JOIN gond_threads t ON t.id = m.thread_id WHERE a.id = ?")
    .get(id) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

export function getAttachment(id: string): { meta: ChatAttachment; data: Uint8Array } | null {
  const row = ensureDatabase().query("SELECT id, name, media_type, size, data FROM gond_attachments WHERE id = ?").get(id) as
    | { id: string; name: string; media_type: string; size: number; data: Uint8Array }
    | null;
  if (!row) return null;
  return { meta: { id: row.id, name: row.name, mediaType: row.media_type, size: row.size }, data: row.data };
}

/**
 * A conversation's lines as the person sees them (hidden prompts and old activity lines left out), in
 * the order they were written, a page at a time after `afterRowid` and from `since` on: an export
 * reads every line, so it pages by rowid, which two lines written in the same millisecond never share.
 */
export function messagesInOrder(threadId: string, options: { afterRowid?: number; since?: string | null; limit?: number } = {}): { messages: Message[]; last: number } {
  const rows = ensureDatabase()
    .query("SELECT rowid AS r, * FROM gond_messages WHERE thread_id = ? AND rowid > ? AND created_at >= ? AND kind NOT IN ('prompt', 'activity') ORDER BY rowid LIMIT ?")
    .all(threadId, options.afterRowid ?? 0, options.since ?? "", options.limit ?? 500) as (MessageRow & { r: number })[];
  return { messages: toMessages(rows), last: rows.at(-1)?.r ?? options.afterRowid ?? 0 };
}
