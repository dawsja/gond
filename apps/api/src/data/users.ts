import { AVATAR_MAX_BYTES, type Me, type SignInProvider, type UserRole, type UserSummary } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { adoptLegacyAi } from "./ai.ts";
import { ensurePrimary } from "./bots.ts";
import { pictureType } from "../images.ts";
import { userAccent } from "./prefs.ts";

type UserRow = { id: string; name: string; email: string; role: string | null; createdAt: string | number };

function toRole(value: string | null | undefined): UserRole {
  return value === "admin" ? "admin" : "user";
}

function providerOf(userId: string): SignInProvider {
  const row = ensureDatabase().query('SELECT providerId FROM "account" WHERE userId = ? ORDER BY createdAt LIMIT 1').get(userId) as { providerId: string } | null;
  return row?.providerId === "credential" ? "local" : "oidc";
}

function toIso(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function getUser(id: string): Me | null {
  const row = ensureDatabase().query('SELECT id, name, email, role, createdAt FROM "user" WHERE id = ?').get(id) as UserRow | null;
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: toRole(row.role), provider: providerOf(row.id), avatar: avatarUrl(row.id), accent: userAccent(row.id) };
}

export function isAdmin(user: object | null | undefined): boolean {
  return toRole((user as { role?: string | null } | null | undefined)?.role) === "admin";
}

export function listUsers(): UserSummary[] {
  const db = ensureDatabase();
  const rows = db.query('SELECT id, name, email, role, createdAt FROM "user" ORDER BY createdAt ASC').all() as UserRow[];
  return rows.map((row) => {
    const bots = db.query("SELECT COUNT(*) AS n FROM gond_bots WHERE user_id = ? AND hidden = 0").get(row.id) as { n: number };
    return { id: row.id, name: row.name, email: row.email, role: toRole(row.role), provider: providerOf(row.id), avatar: avatarUrl(row.id), accent: userAccent(row.id), createdAt: toIso(row.createdAt), bots: Number(bots.n) };
  });
}

export function countUsers(): number {
  const row = ensureDatabase().query('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
  return Number(row.n);
}

export function ensureAdmin(): string | null {
  const db = ensureDatabase();
  const admin = db.query('SELECT id FROM "user" WHERE role = ? ORDER BY createdAt ASC LIMIT 1').get("admin") as { id: string } | null;
  if (admin) return admin.id;
  const first = db.query('SELECT id FROM "user" ORDER BY createdAt ASC LIMIT 1').get() as { id: string } | null;
  if (!first) return null;
  db.query('UPDATE "user" SET role = ? WHERE id = ?').run("admin", first.id);
  return first.id;
}

export function adoptOrphans(adminId: string) {
  transaction((db) => {
    db.query("UPDATE gond_bots SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE gond_threads SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE gond_push_subscriptions SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE gond_connections SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE gond_mcp_servers SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE gond_secrets SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE gond_providers SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE gond_skills SET user_id = ? WHERE user_id IS NULL").run(adminId);
    adoptLegacyAi(adminId);
    ensurePrimary(adminId);
    const legacy = db.query("SELECT media_type, data, updated_at FROM gond_avatar WHERE id = 1").get() as { media_type: string; data: Uint8Array; updated_at: string } | null;
    if (legacy) {
      db.query("INSERT OR IGNORE INTO gond_user_avatars (user_id, media_type, data, updated_at) VALUES (?, ?, ?, ?)").run(adminId, legacy.media_type, legacy.data, legacy.updated_at);
      db.query("DELETE FROM gond_avatar WHERE id = 1").run();
    }
  });
}

export function deleteUserData(userId: string): { bots: string[] } {
  return transaction((db) => {
    const bots = (db.query("SELECT id FROM gond_bots WHERE user_id = ?").all(userId) as { id: string }[]).map((r) => r.id);
    for (const id of bots) {
      db.query("DELETE FROM gond_routines WHERE bot_id = ?").run(id);
      db.query("DELETE FROM gond_follow_ups WHERE bot_id = ?").run(id);
      db.query("DELETE FROM gond_approvals WHERE bot_id = ?").run(id);
      db.query("DELETE FROM gond_approval_rules WHERE bot_id = ?").run(id);
      db.query("DELETE FROM gond_delegations WHERE from_bot_id = ? OR to_bot_id = ?").run(id, id);
    }
    db.query("DELETE FROM gond_thread_members WHERE thread_id IN (SELECT id FROM gond_threads WHERE user_id = ?)").run(userId);
    db.query("DELETE FROM gond_threads WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_bots WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_push_subscriptions WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_user_avatars WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_connections WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_mcp_servers WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_secrets WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_composio_keys WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_providers WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_user_ai WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_user_prefs WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_skill_files WHERE skill_id IN (SELECT id FROM gond_skills WHERE user_id = ?)").run(userId);
    db.query("DELETE FROM gond_skills WHERE user_id = ?").run(userId);
    return { bots };
  });
}

export { AVATAR_MAX_BYTES };

type AvatarRow = { media_type: string; data: Uint8Array; updated_at: string };

export function getAvatar(userId: string): { mediaType: string; data: Uint8Array; updatedAt: string } | null {
  const row = ensureDatabase().query("SELECT media_type, data, updated_at FROM gond_user_avatars WHERE user_id = ?").get(userId) as AvatarRow | null;
  return row ? { mediaType: row.media_type, data: row.data, updatedAt: row.updated_at } : null;
}

export function avatarUrl(userId: string): string | null {
  const row = ensureDatabase().query("SELECT updated_at FROM gond_user_avatars WHERE user_id = ?").get(userId) as { updated_at: string } | null;
  return row ? `/api/me/avatar?v=${encodeURIComponent(row.updated_at)}` : null;
}

export function setAvatar(userId: string, data: Uint8Array): string {
  const mediaType = pictureType(data);
  if (!mediaType) throw new Error("Use a PNG, JPEG, WebP or GIF");
  if (data.byteLength > AVATAR_MAX_BYTES) throw new Error("The picture must be under 2 MB");
  const at = now();
  ensureDatabase()
    .query("INSERT INTO gond_user_avatars (user_id, media_type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET media_type = excluded.media_type, data = excluded.data, updated_at = excluded.updated_at")
    .run(userId, mediaType, data, at);
  emit({ topic: "me", userId });
  return avatarUrl(userId)!;
}

export function clearAvatar(userId: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_user_avatars WHERE user_id = ?").run(userId).changes > 0;
  if (changed) emit({ topic: "me", userId });
  return changed;
}
