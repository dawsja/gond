import { APPROVAL_LEVELS, AVATAR_MAX_BYTES, BOT_EXPRESSIONS, BOT_SHAPES, DEFAULT_MODEL, type ApprovalLevel, type Bot, type BotExpression, type BotInput, type BotShape } from "@gond/shared";
import type { Database } from "bun:sqlite";
import { ensureDatabase, transaction } from "../db/init.ts";
import { botsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { pictureType } from "../images.ts";

type Row = {
  id: string;
  name: string;
  title: string;
  description: string;
  voice: string;
  color: string;
  expression: string;
  shape: string;
  tilt: number;
  model: string;
  approval: string;
  is_primary: number;
  thread_id: string;
  hidden: number;
  pinned: number;
  notify: number;
  position: number;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  avatar_at: string | null;
};

function toBot(row: Row): Bot {
  return {
    id: row.id,
    userId: row.user_id ?? "",
    name: row.name,
    title: row.title,
    description: row.description,
    color: row.color,
    avatar: row.avatar_at ? `/api/bots/${row.id}/avatar?v=${encodeURIComponent(row.avatar_at)}` : null,
    expression: (BOT_EXPRESSIONS as readonly string[]).includes(row.expression) ? (row.expression as BotExpression) : "happy",
    shape: (BOT_SHAPES as readonly string[]).includes(row.shape) ? (row.shape as BotShape) : "cog",
    approval: (APPROVAL_LEVELS as readonly string[]).includes(row.approval) ? (row.approval as ApprovalLevel) : "ask",
    threadId: row.thread_id,
    primary: row.is_primary === 1,
    hidden: row.hidden === 1,
    pinned: row.pinned === 1,
    notify: row.notify !== 0,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = "SELECT *, (SELECT updated_at FROM gond_bot_avatars WHERE bot_id = gond_bots.id) AS avatar_at FROM gond_bots";

export function listBots(options: { includeHidden?: boolean; userId?: string } = {}): Bot[] {
  const db = ensureDatabase();
  const where: string[] = [];
  const params: string[] = [];
  if (!options.includeHidden) where.push("hidden = 0");
  if (options.userId) {
    where.push("user_id = ?");
    params.push(options.userId);
  }
  const rows = db.query(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, position ASC, created_at ASC`).all(...params) as Row[];
  return rows.map(toBot);
}

export function getBot(id: string): Bot | null {
  const row = ensureDatabase().query(`${SELECT} WHERE id = ?`).get(id) as Row | null;
  return row ? toBot(row) : null;
}

export function getBotByThread(threadId: string): Bot | null {
  const row = ensureDatabase().query(`${SELECT} WHERE thread_id = ?`).get(threadId) as Row | null;
  return row ? toBot(row) : null;
}

export function getPrimary(userId: string): Bot | null {
  const row = ensureDatabase().query(`${SELECT} WHERE user_id = ? AND is_primary = 1 AND hidden = 0 ORDER BY position ASC LIMIT 1`).get(userId) as Row | null;
  return row ? toBot(row) : null;
}

function keepOnePrimary(db: Database, userId: string | null) {
  if (!userId) return;
  const kept = db.query("SELECT id FROM gond_bots WHERE user_id = ? AND is_primary = 1 AND hidden = 0 ORDER BY position ASC, created_at ASC LIMIT 1").get(userId) as { id: string } | null;
  const chosen = kept ?? (db.query("SELECT id FROM gond_bots WHERE user_id = ? AND hidden = 0 ORDER BY position ASC, created_at ASC LIMIT 1").get(userId) as { id: string } | null);
  db.query("UPDATE gond_bots SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ? AND is_primary != CASE WHEN id = ? THEN 1 ELSE 0 END").run(chosen?.id ?? "", userId, chosen?.id ?? "");
}

export function ensurePrimary(userId: string) {
  transaction((db) => keepOnePrimary(db, userId));
}

export function setPrimary(userId: string, botId: string): Bot | null {
  const bot = transaction((db) => {
    const row = db.query(`${SELECT} WHERE id = ? AND user_id = ? AND hidden = 0`).get(botId, userId) as Row | null;
    if (!row) return null;
    db.query("UPDATE gond_bots SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?").run(botId, userId);
    return toBot(db.query(`${SELECT} WHERE id = ?`).get(botId) as Row);
  });
  if (bot) botsChanged(userId);
  return bot;
}

export function createBot(input: BotInput, userId: string): Bot {
  const id = newId("bot");
  const threadId = newId("t");
  const at = now();
  return transaction((db) => {
    const max = db.query("SELECT COALESCE(MAX(position), 0) AS p FROM gond_bots WHERE user_id = ?").get(userId) as { p: number };
    db.query(
      `INSERT INTO gond_threads (id, kind, bot_id, name, user_id, created_at, updated_at) VALUES (?, 'bot', ?, ?, ?, ?, ?)`,
    ).run(threadId, id, input.name, userId, at, at);
    db.query("INSERT INTO gond_thread_members (thread_id, bot_id) VALUES (?, ?)").run(threadId, id);
    db.query(
      `INSERT INTO gond_bots (id, name, title, description, voice, color, expression, shape, tilt, model, approval, notify, thread_id, position, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.title,
      input.description,

      "",
      input.color,
      input.expression,
      input.shape ?? "cog",
      0,
      DEFAULT_MODEL,
      input.approval,
      input.notify ? 1 : 0,
      threadId,
      Number(max.p) + 1,
      userId,
      at,
      at,
    );
    keepOnePrimary(db, userId);
    botsChanged(userId);
    return toBot(db.query(`${SELECT} WHERE id = ?`).get(id) as Row);
  });
}

export function updateBot(id: string, patch: Partial<BotInput> & { hidden?: boolean; pinned?: boolean; position?: number }): Bot | null {
  const current = getBot(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: now() };
  transaction((db) => {
    db.query(
      `UPDATE gond_bots SET name = ?, title = ?, description = ?, color = ?, expression = ?, shape = ?, approval = ?, notify = ?, hidden = ?, pinned = ?, position = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.name,
      next.title,
      next.description,
      next.color,
      next.expression,
      next.shape,
      next.approval,
      next.notify ? 1 : 0,
      next.hidden ? 1 : 0,
      next.pinned ? 1 : 0,
      next.position,
      next.updatedAt,
      id,
    );
    if (patch.name) db.query("UPDATE gond_threads SET name = ? WHERE id = ?").run(patch.name, current.threadId);
    if (patch.hidden !== undefined && patch.hidden !== current.hidden) keepOnePrimary(db, current.userId);
  });
  botsChanged(current.userId);
  return getBot(id);
}

export function deleteBot(id: string): Bot | null {
  const bot = getBot(id);
  if (!bot) return null;
  transaction((db) => {
    db.query("DELETE FROM gond_threads WHERE id = ?").run(bot.threadId);
    db.query("DELETE FROM gond_thread_members WHERE bot_id = ?").run(id);
    db.query("DELETE FROM gond_approvals WHERE bot_id = ?").run(id);
    db.query("DELETE FROM gond_approval_rules WHERE bot_id = ?").run(id);
    db.query("DELETE FROM gond_routines WHERE bot_id = ?").run(id);
    db.query("DELETE FROM gond_follow_ups WHERE bot_id = ?").run(id);
    db.query("DELETE FROM gond_bot_avatars WHERE bot_id = ?").run(id);
    db.query("DELETE FROM gond_bots WHERE id = ?").run(id);
    keepOnePrimary(db, bot.userId);
  });
  botsChanged(bot.userId);
  return bot;
}

export function findBot(ref: string, bots = listBots({ includeHidden: true })): Bot | null {
  const wanted = ref.trim().replace(/^@/, "").toLowerCase();
  if (!wanted) return null;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return bots.find((b) => b.id === ref) ?? bots.find((b) => b.name.toLowerCase() === wanted) ?? bots.find((b) => squash(b.name) === squash(wanted)) ?? null;
}

export function getBotAvatar(botId: string): { mediaType: string; data: Uint8Array } | null {
  const row = ensureDatabase().query("SELECT media_type, data FROM gond_bot_avatars WHERE bot_id = ?").get(botId) as { media_type: string; data: Uint8Array } | null;
  return row ? { mediaType: row.media_type, data: row.data } : null;
}

export function setBotAvatar(botId: string, data: Uint8Array): Bot | null {
  const mediaType = pictureType(data);
  if (!mediaType) throw new Error("Use a PNG, JPEG, WebP or GIF");
  if (data.byteLength > AVATAR_MAX_BYTES) throw new Error("The picture must be under 2 MB");
  const bot = getBot(botId);
  if (!bot) return null;
  ensureDatabase()
    .query("INSERT INTO gond_bot_avatars (bot_id, media_type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET media_type = excluded.media_type, data = excluded.data, updated_at = excluded.updated_at")
    .run(botId, mediaType, data, now());
  botsChanged(bot.userId);
  return getBot(botId);
}

export function clearBotAvatar(botId: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_bot_avatars WHERE bot_id = ?").run(botId).changes > 0;
  if (changed) botsChanged(getBot(botId)?.userId);
  return changed;
}
