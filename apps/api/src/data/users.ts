import { AVATAR_MAX_BYTES, OIDC_PROVIDER_ID, type Me, type SignInProvider, type UserRole, type UserSummary } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { adoptLegacyAi } from "./ai.ts";
import { ensurePrimary } from "./bots.ts";
import { pictureType } from "../images.ts";
import { userAccent, userTalk } from "./prefs.ts";
import { isExtraProfile, personOf, profileIds, profileOf } from "./profiles.ts";

type UserRow = { id: string; name: string; email: string; role: string | null; createdAt: string | number };

function toRole(value: string | null | undefined): UserRole {
  return value === "admin" ? "admin" : "user";
}

/** Which sign-ins an account has: its password, and the OIDC provider's, once linked or made through it. */
export function signInsOf(userId: string): { password: boolean; oidc: boolean } {
  const rows = ensureDatabase().query('SELECT providerId FROM "account" WHERE userId = ?').all(userId) as { providerId: string }[];
  return { password: rows.some((r) => r.providerId === "credential"), oidc: rows.some((r) => r.providerId === OIDC_PROVIDER_ID) };
}

/** The account a username signs in to with a password, and that password's hash. */
export function passwordAccount(username: string): { userId: string; hash: string } | null {
  const row = ensureDatabase()
    .query('SELECT a.userId AS userId, a.password AS hash FROM "account" a JOIN "user" u ON u.id = a.userId WHERE u.username = ? AND a.providerId = \'credential\' AND a.password IS NOT NULL')
    .get(username) as { userId: string; hash: string } | null;
  return row;
}

/** Whether an account with a password hasn't linked the provider's sign-in yet, so one made through the provider could move to it. */
export function unlinkedPasswordAccount(): boolean {
  return Boolean(
    ensureDatabase()
      .query('SELECT 1 FROM "account" a WHERE a.providerId = \'credential\' AND NOT EXISTS (SELECT 1 FROM "account" b WHERE b.userId = a.userId AND b.providerId = ?) LIMIT 1')
      .get(OIDC_PROVIDER_ID),
  );
}

/** What a person has made, over all their profiles: bots, and conversations they wrote in. */
export function contentsOf(personId: string): { bots: number; chats: number } {
  const db = ensureDatabase();
  let bots = 0;
  let chats = 0;
  for (const id of profileIds(personId)) {
    bots += Number((db.query("SELECT COUNT(*) AS n FROM gond_bots WHERE user_id = ? AND hidden = 0").get(id) as { n: number }).n);
    chats += Number((db.query("SELECT COUNT(*) AS n FROM gond_threads t WHERE t.user_id = ? AND EXISTS (SELECT 1 FROM gond_messages m WHERE m.thread_id = t.id AND m.author = 'you')").get(id) as { n: number }).n);
  }
  return { bots, chats };
}

/** The provider's sign-in moves from one account to another, so signing in with it opens the other. */
export function moveProviderSignIn(fromId: string, toId: string): void {
  ensureDatabase().query('UPDATE "account" SET userId = ? WHERE userId = ? AND providerId = ?').run(toId, fromId, OIDC_PROVIDER_ID);
}

/** The sign-in side of a person, once everything else of theirs is gone: sessions, sign-ins and the account itself. */
export function forgetAccount(personId: string): void {
  transaction((db) => {
    db.query('DELETE FROM gond_session_profiles WHERE session_id IN (SELECT id FROM "session" WHERE userId = ?)').run(personId);
    db.query('DELETE FROM "session" WHERE userId = ?').run(personId);
    db.query('DELETE FROM "account" WHERE userId = ?').run(personId);
    db.query("DELETE FROM gond_profiles WHERE person_id = ?").run(personId);
    db.query('DELETE FROM "user" WHERE id = ?').run(personId);
  });
}

function providerOf(userId: string): SignInProvider {
  const row = ensureDatabase().query('SELECT providerId FROM "account" WHERE userId = ? ORDER BY createdAt LIMIT 1').get(userId) as { providerId: string } | null;
  return row?.providerId === "credential" ? "local" : "oidc";
}

function toIso(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * A person, or one of their profiles: a profile has the person's name, address and sign-in, and its
 * own role (never the admin's), picture, colour and way of talking.
 */
export function getUser(id: string): Me | null {
  const db = ensureDatabase();
  const row = db.query('SELECT id, name, email, role, createdAt FROM "user" WHERE id = ?').get(id) as UserRow | null;
  const profile = row ? profileOf(row.id) : null;
  if (!row || !profile) return null;
  const person = profile.isDefault ? row : ((db.query('SELECT id, name, email, role, createdAt FROM "user" WHERE id = ?').get(profile.personId) as UserRow | null) ?? row);
  return {
    id: row.id,
    name: person.name,
    email: person.email,
    role: toRole(row.role),
    provider: providerOf(person.id),
    avatar: avatarUrl(row.id),
    accent: userAccent(row.id),
    ...userTalk(row.id),
    profile: { id: profile.id, label: profile.label, isDefault: profile.isDefault, icon: profile.icon },
  };
}

export function isAdmin(user: object | null | undefined): boolean {
  return toRole((user as { role?: string | null } | null | undefined)?.role) === "admin";
}

export function listUsers(): UserSummary[] {
  const db = ensureDatabase();
  const rows = (db.query('SELECT id, name, email, role, createdAt FROM "user" ORDER BY createdAt ASC').all() as UserRow[]).filter((row) => !isExtraProfile(row.id));
  return rows.map((row) => {
    const bots = db.query("SELECT COUNT(*) AS n FROM gond_bots WHERE user_id = ? AND hidden = 0").get(row.id) as { n: number };
    const profiles = db.query("SELECT COUNT(*) AS n FROM gond_profiles WHERE person_id = ? AND id != person_id").get(row.id) as { n: number };
    return { id: row.id, name: row.name, email: row.email, role: toRole(row.role), provider: providerOf(row.id), avatar: avatarUrl(row.id), accent: userAccent(row.id), ...userTalk(row.id), createdAt: toIso(row.createdAt), bots: Number(bots.n), profiles: Number(profiles.n) + 1 };
  });
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
    for (const id of bots) db.query("DELETE FROM gond_secret_requests WHERE bot_id = ?").run(id);
    // Attachments hang off messages without a cascade, so they go before the conversations take the messages.
    db.query("DELETE FROM gond_attachments WHERE message_id IN (SELECT m.id FROM gond_messages m JOIN gond_threads t ON t.id = m.thread_id WHERE t.user_id = ?)").run(userId);
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
    db.query("DELETE FROM gond_check_ins WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_skill_files WHERE skill_id IN (SELECT id FROM gond_skills WHERE user_id = ?)").run(userId);
    db.query("DELETE FROM gond_skills WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_exports WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_teachings WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_usage WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_plan_limits WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_peer_checks WHERE user_id = ?").run(userId);
    db.query("DELETE FROM gond_space_invites WHERE user_id = ?").run(userId);
    return { bots };
  });
}

export { AVATAR_MAX_BYTES };

type AvatarRow = { media_type: string; data: Uint8Array; updated_at: string };

/** A profile without a picture of its own wears the person's. */
function avatarRow(userId: string): AvatarRow | null {
  const query = ensureDatabase().query("SELECT media_type, data, updated_at FROM gond_user_avatars WHERE user_id = ?");
  const own = query.get(userId) as AvatarRow | null;
  if (own) return own;
  const person = personOf(userId);
  return person === userId ? null : (query.get(person) as AvatarRow | null);
}

export function getAvatar(userId: string): { mediaType: string; data: Uint8Array; updatedAt: string } | null {
  const row = avatarRow(userId);
  return row ? { mediaType: row.media_type, data: row.data, updatedAt: row.updated_at } : null;
}

export function avatarUrl(userId: string): string | null {
  const row = avatarRow(userId);
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
