import { DEFAULT_PROFILE_LABEL, type ProfileRef } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { newId, now } from "../ids.ts";

type Row = { id: string; person_id: string; label: string; icon: string | null; muted: number; last_active_at: string | null; created_at: string };

export type ProfileRow = ProfileRef & { personId: string; muted: boolean; createdAt: string };

function toProfile(row: Row): ProfileRow {
  return { id: row.id, personId: row.person_id, label: row.label, isDefault: row.id === row.person_id, icon: row.icon, muted: row.muted === 1, createdAt: row.created_at };
}

function rowOf(id: string): Row | null {
  return ensureDatabase().query("SELECT * FROM gond_profiles WHERE id = ?").get(id) as Row | null;
}

/** Whose profile this is: the person signed in. A person's own id is their default profile. */
export function personOf(userId: string): string {
  return rowOf(userId)?.person_id ?? userId;
}

export function profileOf(id: string): ProfileRow | null {
  const row = rowOf(id);
  if (row) return toProfile(row);
  const person = ensureDatabase().query('SELECT id, "createdAt" AS created_at FROM "user" WHERE id = ?').get(id) as { id: string; created_at: string | number } | null;
  return person ? { id, personId: id, label: DEFAULT_PROFILE_LABEL, isDefault: true, icon: null, muted: false, createdAt: String(person.created_at) } : null;
}

/** A person's profiles, the default first, then in the order they were made. */
export function profilesOf(personId: string): ProfileRow[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_profiles WHERE person_id = ? AND id != person_id ORDER BY created_at, id").all(personId) as Row[];
  const own = profileOf(personId);
  return [...(own ? [own] : []), ...rows.map(toProfile)];
}

export function profileIds(personId: string): string[] {
  const rows = ensureDatabase().query("SELECT id FROM gond_profiles WHERE person_id = ? AND id != person_id ORDER BY created_at, id").all(personId) as { id: string }[];
  return [personId, ...rows.map((row) => row.id)];
}

/** Whether a "user" row is a profile rather than someone who signs in. */
export function isExtraProfile(userId: string): boolean {
  const row = rowOf(userId);
  return Boolean(row && row.id !== row.person_id);
}

/**
 * A new profile is a "user" row nobody signs in to: no account row, and an address that can never be
 * anyone's, so an OIDC sign-in can't land on it. It takes the person's name, which is what bots call them.
 */
export function insertProfile(personId: string, label: string, icon: string | null = null): ProfileRow {
  const id = newId("p");
  const at = now();
  transaction((db) => {
    const person = db.query('SELECT name FROM "user" WHERE id = ?').get(personId) as { name: string } | null;
    if (!person) throw new Error("No such person");
    db.query('INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES (?, ?, ?, 0, ?, ?, ?)').run(id, person.name, `${id}@profiles.gond.invalid`, "user", at, at);
    db.query("INSERT INTO gond_profiles (id, person_id, label, icon, created_at) VALUES (?, ?, ?, ?, ?)").run(id, personId, label, icon, at);
  });
  return profileOf(id)!;
}

/** A default profile has no row until something of it is kept: its name, icon, quiet or last use. */
export function updateProfile(id: string, change: { label?: string; icon?: string | null; muted?: boolean }): void {
  const profile = profileOf(id);
  if (!profile) return;
  transaction((db) => {
    db.query("INSERT INTO gond_profiles (id, person_id, label, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").run(id, profile.personId, profile.label, now());
    if (change.label !== undefined) db.query("UPDATE gond_profiles SET label = ? WHERE id = ?").run(change.label, id);
    if (change.icon !== undefined) db.query("UPDATE gond_profiles SET icon = ? WHERE id = ?").run(change.icon, id);
    if (change.muted !== undefined) db.query("UPDATE gond_profiles SET muted = ? WHERE id = ?").run(change.muted ? 1 : 0, id);
  });
}

export function setProfileMuted(id: string, muted: boolean): void {
  updateProfile(id, { muted });
}

/**
 * The profile a session has open: the one it picked, if that is still one of its person's; else the
 * one the person used last; else their default.
 */
export function activeProfile(sessionId: string, personId: string): string {
  const db = ensureDatabase();
  const picked = db.query("SELECT profile_id FROM gond_session_profiles WHERE session_id = ?").get(sessionId) as { profile_id: string } | null;
  if (picked && personOf(picked.profile_id) === personId && profileOf(picked.profile_id)) return picked.profile_id;
  const last = db.query("SELECT id FROM gond_profiles WHERE person_id = ? AND last_active_at IS NOT NULL ORDER BY last_active_at DESC LIMIT 1").get(personId) as { id: string } | null;
  return last && profileOf(last.id) ? last.id : personId;
}

export function setActiveProfile(sessionId: string, profile: ProfileRow): void {
  const at = now();
  transaction((db) => {
    db.query("INSERT INTO gond_session_profiles (session_id, profile_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at").run(sessionId, profile.id, at);
    db.query("INSERT INTO gond_profiles (id, person_id, label, last_active_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at")
      .run(profile.id, profile.personId, profile.label, at, at);
  });
}

/** The rows that make a profile one: what is left once everything in it is gone. */
export function removeProfileRows(id: string): void {
  transaction((db) => {
    db.query("DELETE FROM gond_session_profiles WHERE profile_id = ?").run(id);
    db.query("DELETE FROM gond_profiles WHERE id = ?").run(id);
    db.query('DELETE FROM "user" WHERE id = ?').run(id);
  });
}

/** A session that has ended keeps no row. */
export function forgetEndedSessions(): number {
  const db = ensureDatabase();
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'").get()) return 0;
  return db.query('DELETE FROM gond_session_profiles WHERE session_id NOT IN (SELECT id FROM "session")').run().changes;
}
