import { ensureDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
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
