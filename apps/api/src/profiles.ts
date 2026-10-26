import { ACCENTS, isProfileIcon, MAX_PROFILES, profileLabelError, type Profile } from "@gond/shared";
import { boxConfig, removeBoxAccount } from "./box.ts";
import { endCallsOf } from "./calls.ts";
import { signOutChatGpt } from "./chatgpt.ts";
import { disconnect, forgetComposioCache } from "./composio.ts";
import { ensureDatabase } from "./db/init.ts";
import { setUserAccent, userAccent } from "./data/prefs.ts";
import { insertProfile, profileOf, profilesOf, removeProfileRows, updateProfile, type ProfileRow } from "./data/profiles.ts";
import { listConnections } from "./data/settings.ts";
import { avatarUrl, deleteUserData } from "./data/users.ts";
import { emit } from "./events.ts";
import { signOutGrok } from "./grok.ts";
import { stopAll } from "./responder.ts";
import { leaveAllSpaces } from "./spaces.ts";

const ICON_ERROR = "Pick one of the icons on offer";

/** What waits in a profile: conversations with something new, and cards that need the person. */
function waiting(userId: string): { unread: number; needsYou: number } {
  const db = ensureDatabase();
  const unread = db
    .query(
      `SELECT COUNT(*) AS n FROM gond_threads t WHERE t.user_id = ?
         AND NOT EXISTS (SELECT 1 FROM gond_bots b WHERE b.thread_id = t.id AND b.hidden = 1)
         AND EXISTS (SELECT 1 FROM gond_messages m WHERE m.thread_id = t.id AND m.author != 'you' AND m.kind IN ('message', 'approval', 'signin', 'teach')
           AND m.spoken = 0 AND m.from_thread_id IS NULL AND m.created_at > COALESCE(t.last_read_at, ''))`,
    )
    .get(userId) as { n: number };
  const needsYou = db.query("SELECT COUNT(*) AS n FROM gond_approvals a JOIN gond_bots b ON b.id = a.bot_id WHERE b.user_id = ? AND a.status = 'pending'").get(userId) as { n: number };
  return { unread: Number(unread.n), needsYou: Number(needsYou.n) };
}

function toProfile(row: ProfileRow): Profile {
  return { id: row.id, label: row.label, isDefault: row.isDefault, icon: row.icon, accent: userAccent(row.id), avatar: avatarUrl(row.id), muted: row.muted, ...waiting(row.id) };
}

export function listProfiles(personId: string): Profile[] {
  return profilesOf(personId).map(toProfile);
}

/** A new profile starts empty, as a new person does, in the first colour none of the others wears. */
export function createProfile(personId: string, label: string, icon: string | null = null): Profile | { error: string } {
  const profiles = profilesOf(personId);
  if (profiles.length >= MAX_PROFILES) return { error: `You can have up to ${MAX_PROFILES} profiles. Delete one to make another.` };
  const problem = profileLabelError(label, profiles.map((p) => p.label)) ?? (icon === null || isProfileIcon(icon) ? null : ICON_ERROR);
  if (problem) return { error: problem };
  const worn = new Set(profiles.map((p) => userAccent(p.id)));
  const row = insertProfile(personId, label.trim(), icon);
  const accent = ACCENTS.find((a) => !worn.has(a));
  if (accent) setUserAccent(row.id, accent);
  emit({ topic: "profiles", userId: personId });
  return toProfile(row);
}

/** Any profile's name and icon change, the default's too; null takes the icon off. */
export function editProfile(id: string, change: { label?: string; icon?: string | null }): Profile | { error: string } {
  const profile = profileOf(id);
  if (!profile) return { error: "Couldn't find that profile" };
  if (change.label !== undefined) {
    const others = profilesOf(profile.personId).filter((p) => p.id !== id).map((p) => p.label);
    const problem = profileLabelError(change.label, others);
    if (problem) return { error: problem };
  }
  if (typeof change.icon === "string" && !isProfileIcon(change.icon)) return { error: ICON_ERROR };
  updateProfile(id, { label: change.label?.trim(), icon: change.icon });
  emit({ topic: "profiles", userId: profile.personId });
  emit({ topic: "me", userId: id });
  return toProfile(profileOf(id)!);
}

/**
 * Everything a profile is goes, as when a person is removed: what runs stops, its spaces hear it
 * leave, its plan sign-ins and app connections are given up where they were made, every row of it
 * goes, and so does its account on the computer with every file in it. A default profile is the
 * person, removed only with them.
 */
export async function deleteProfile(id: string): Promise<void> {
  const profile = profileOf(id);
  if (!profile || profile.isDefault) return;
  endCallsOf(id);
  await stopAll(id).catch(() => undefined);
  leaveAllSpaces(id);
  await signOutGrok(id).catch(() => false);
  await signOutChatGpt(id).catch(() => false);
  for (const connection of listConnections(id)) await disconnect(id, connection.toolkit).catch(() => false);
  forgetComposioCache(id);
  deleteUserData(id);
  const box = boxConfig();
  if (box) await removeBoxAccount(box, id).catch((error: unknown) => console.warn(`[gond] could not remove profile ${id}'s account on the box: ${error instanceof Error ? error.message : error}`));
  removeProfileRows(id);
  emit({ topic: "profiles", userId: profile.personId });
}

/** A person's other profiles, gone before the person is. */
export async function deleteProfilesOf(personId: string): Promise<void> {
  for (const profile of profilesOf(personId)) if (!profile.isDefault) await deleteProfile(profile.id);
}
