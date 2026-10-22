import { DEFAULT_ACCENT, isAccent, type Accent } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit, settingsChanged } from "../events.ts";
import { now } from "../ids.ts";
import { nextRun } from "./routines.ts";
import { getSettings } from "./settings.ts";


export function validTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone || timezone.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function userTimezone(userId: string | null | undefined): string {
  if (userId) {
    const row = ensureDatabase().query("SELECT timezone FROM gond_user_prefs WHERE user_id = ?").get(userId) as { timezone: string | null } | null;
    if (row?.timezone) return row.timezone;
  }
  return getSettings().timezone || "UTC";
}

export function setUserTimezone(userId: string, timezone: unknown): boolean {
  if (!validTimezone(timezone)) return false;
  const db = ensureDatabase();
  const current = db.query("SELECT timezone FROM gond_user_prefs WHERE user_id = ?").get(userId) as { timezone: string | null } | null;
  if (current?.timezone === timezone) return false;
  const at = now();
  db.query("INSERT INTO gond_user_prefs (user_id, timezone, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at").run(userId, timezone, at);
  const routines = db
    .query("SELECT r.id, r.cron, r.enabled FROM gond_routines r JOIN gond_bots b ON b.id = r.bot_id WHERE b.user_id = ? AND r.timezone != ?")
    .all(userId, timezone) as { id: string; cron: string; enabled: number }[];
  for (const routine of routines) {
    let next: string | null = null;
    if (routine.enabled === 1) {
      try {
        next = nextRun(routine.cron, timezone)?.toISOString() ?? null;
      } catch {
        next = null;
      }
    }
    db.query("UPDATE gond_routines SET timezone = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(timezone, next, at, routine.id);
  }
  if (routines.length) settingsChanged();
  return true;
}

export function userAccent(userId: string): Accent {
  const row = ensureDatabase().query("SELECT accent FROM gond_user_prefs WHERE user_id = ?").get(userId) as { accent: string | null } | null;
  return isAccent(row?.accent) ? row.accent : DEFAULT_ACCENT;
}

export function setUserAccent(userId: string, accent: Accent) {
  ensureDatabase()
    .query("INSERT INTO gond_user_prefs (user_id, accent, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET accent = excluded.accent, updated_at = excluded.updated_at")
    .run(userId, accent === DEFAULT_ACCENT ? null : accent, now());
  emit({ topic: "me", userId });
}

/** The client a person's ChatGPT account registered Gond as; reused on every later sign-in, kept past a sign-out. */
export function chatGptClient(userId: string): string | null {
  const row = ensureDatabase().query("SELECT chatgpt_client FROM gond_user_prefs WHERE user_id = ?").get(userId) as { chatgpt_client: string | null } | null;
  return row?.chatgpt_client ?? null;
}

export function setChatGptClient(userId: string, clientId: string | null) {
  ensureDatabase()
    .query("INSERT INTO gond_user_prefs (user_id, chatgpt_client, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET chatgpt_client = excluded.chatgpt_client, updated_at = excluded.updated_at")
    .run(userId, clientId, now());
}
