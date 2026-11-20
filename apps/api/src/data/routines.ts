import type { Routine, RoutineInput, RoutineTrigger } from "@gond/shared";
import { Cron } from "croner";
import { ensureDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { botOwner } from "./bots.ts";

type Row = {
  id: string;
  bot_id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: number;
  watch: number;
  once: number;
  skill_id: string | null;
  event: string | null;
  event_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

function eventOf(raw: string | null): RoutineTrigger | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RoutineTrigger;
  } catch {
    return null;
  }
}

function toRoutine(row: Row): Routine {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    watch: row.watch === 1,
    once: row.once === 1,
    trigger: eventOf(row.event),
    skillId: row.skill_id,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function nextRun(cron: string, timezone: string, from = new Date()): Date | null {
  const job = new Cron(cron, { timezone, paused: true });
  const next = job.nextRun(from);
  job.stop();
  return next;
}

export function previewRuns(cron: string, timezone: string, count = 3): string[] {
  const job = new Cron(cron, { timezone, paused: true });
  const runs = job.nextRuns(count).map((d) => d.toISOString());
  job.stop();
  return runs;
}

export function listRoutines(botId?: string): Routine[] {
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_routines ${botId ? "WHERE bot_id = ?" : ""} ORDER BY created_at ASC`)
    .all(...(botId ? [botId] : [])) as Row[];
  return rows.map(toRoutine);
}

export function getRoutine(id: string): Routine | null {
  const row = ensureDatabase().query("SELECT * FROM gond_routines WHERE id = ?").get(id) as Row | null;
  return row ? toRoutine(row) : null;
}

/** A routine an app's event starts has no cron and no next run: it runs when the event arrives. */
function nextRunAt(routine: { enabled: boolean; cron: string; timezone: string; trigger?: RoutineTrigger | null }): string | null {
  return routine.enabled && !routine.trigger ? (nextRun(routine.cron, routine.timezone)?.toISOString() ?? null) : null;
}

export function createRoutine(botId: string, input: Omit<RoutineInput, "skillId" | "watch"> & { skillId?: string | null; watch?: boolean; once?: boolean; trigger?: RoutineTrigger | null }): Routine {
  const id = newId("r");
  const at = now();
  const trigger = input.trigger ?? null;
  const cron = trigger ? "" : input.cron;
  ensureDatabase()
    .query("INSERT INTO gond_routines (id, bot_id, name, cron, timezone, prompt, enabled, watch, once, skill_id, event, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, botId, input.name, cron, input.timezone, input.prompt, input.enabled ? 1 : 0, input.watch ? 1 : 0, input.once && !trigger ? 1 : 0, input.skillId ?? null, trigger ? JSON.stringify(trigger) : null, nextRunAt({ ...input, cron, trigger }), at, at);
  settingsChanged(botOwner(botId));
  return getRoutine(id)!;
}

export function updateRoutine(id: string, patch: Partial<RoutineInput>): Routine | null {
  const current = getRoutine(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  ensureDatabase()
    .query("UPDATE gond_routines SET name = ?, cron = ?, timezone = ?, prompt = ?, enabled = ?, watch = ?, skill_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.cron, next.timezone, next.prompt, next.enabled ? 1 : 0, next.watch ? 1 : 0, next.skillId ?? null, nextRunAt(next), now(), id);
  settingsChanged(routineOwner(id));
  return getRoutine(id);
}

export function deleteRoutine(id: string): boolean {
  const owner = routineOwner(id);
  const changed = ensureDatabase().query("DELETE FROM gond_routines WHERE id = ?").run(id).changes;
  if (changed) settingsChanged(owner);
  return changed > 0;
}

/** The trigger Composio keeps for a routine while it is on, or null once it is given up. */
export function setRoutineEventId(id: string, eventId: string | null): void {
  ensureDatabase().query("UPDATE gond_routines SET event_id = ? WHERE id = ?").run(eventId, id);
}

export function routineEventId(id: string): string | null {
  return (ensureDatabase().query("SELECT event_id FROM gond_routines WHERE id = ?").get(id) as { event_id: string | null } | null)?.event_id ?? null;
}

/** The routine an arriving event is for, by the trigger Composio named, with its owner. */
export function routineForEvent(eventId: string): { routine: Routine; userId: string } | null {
  const row = ensureDatabase().query("SELECT r.*, b.user_id AS owner FROM gond_routines r JOIN gond_bots b ON b.id = r.bot_id WHERE r.event_id = ?").get(eventId) as (Row & { owner: string | null }) | null;
  return row?.owner ? { routine: toRoutine(row), userId: row.owner } : null;
}

/** Every routine that waits on an app's event and is on, with its owner, for subscribing at start. */
export function armedRoutines(): { routine: Routine; userId: string; eventId: string }[] {
  const rows = ensureDatabase().query("SELECT r.*, b.user_id AS owner FROM gond_routines r JOIN gond_bots b ON b.id = r.bot_id WHERE r.event_id IS NOT NULL").all() as (Row & { owner: string | null })[];
  return rows.flatMap((row) => (row.owner && row.event_id ? [{ routine: toRoutine(row), userId: row.owner, eventId: row.event_id }] : []));
}

/** A person's routines that wait on events, for when their apps change under them. */
export function eventRoutinesOf(userId: string): Routine[] {
  const rows = ensureDatabase().query("SELECT r.* FROM gond_routines r JOIN gond_bots b ON b.id = r.bot_id WHERE b.user_id = ? AND r.event IS NOT NULL").all(userId) as Row[];
  return rows.map(toRoutine);
}

/** A run of this routine that is posted and not yet picked up, which a new event can join. */
export function waitingRun(routineId: string): { messageId: string; body: string } | null {
  return ensureDatabase()
    .query("SELECT m.id AS messageId, m.body FROM gond_routine_runs r JOIN gond_messages m ON m.id = r.message_id WHERE r.routine_id = ? AND r.status = 'started' AND m.answered_at IS NULL AND m.claimed_by IS NULL ORDER BY r.started_at DESC LIMIT 1")
    .get(routineId) as { messageId: string; body: string } | null;
}

/** Joins an event to a waiting run, only while nothing has picked it up; whether it did. */
export function joinWaitingRun(messageId: string, body: string): boolean {
  return ensureDatabase().query("UPDATE gond_messages SET body = ? WHERE id = ? AND answered_at IS NULL AND claimed_by IS NULL").run(body, messageId).changes > 0;
}

export function runsSince(routineId: string, since: string): number {
  return (ensureDatabase().query("SELECT COUNT(*) AS n FROM gond_routine_runs WHERE routine_id = ? AND started_at >= ?").get(routineId, since) as { n: number }).n;
}

export function claimDueRoutines(at = new Date()): Routine[] {
  const db = ensureDatabase();
  const rows = db.query("SELECT * FROM gond_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(at.toISOString()) as Row[];
  const due: Routine[] = [];
  for (const row of rows) {
    let next: string | null = null;
    try {
      next = row.once ? null : (nextRun(row.cron, row.timezone, at)?.toISOString() ?? null);
    } catch {
      next = null;
    }
    const enabled = row.once ? 0 : row.enabled;
    db.query("UPDATE gond_routines SET last_run_at = ?, next_run_at = ?, enabled = ? WHERE id = ?").run(at.toISOString(), next, enabled, row.id);
    due.push(toRoutine({ ...row, enabled, last_run_at: at.toISOString(), next_run_at: next }));
  }
  for (const botId of new Set(due.map((routine) => routine.botId))) settingsChanged(botOwner(botId));
  return due;
}

export function recordRoutineRun(routineId: string, messageId: string | null) {
  ensureDatabase().query("INSERT INTO gond_routine_runs (id, routine_id, message_id, status, started_at) VALUES (?, ?, ?, 'started', ?)").run(newId("rr"), routineId, messageId, now());
}

export function finishRoutineRun(messageId: string, ok: boolean) {
  const db = ensureDatabase();
  db.query("UPDATE gond_routine_runs SET status = ?, finished_at = ? WHERE message_id = ? AND status = 'started'").run(ok ? "done" : "failed", now(), messageId);
  // A reminder that has said its piece is done with; one that failed stays, switched off, for the person to see.
  if (!ok) return;
  const done = db.query("DELETE FROM gond_routines WHERE once = 1 AND enabled = 0 AND id IN (SELECT routine_id FROM gond_routine_runs WHERE message_id = ?) RETURNING bot_id").all(messageId) as { bot_id: string }[];
  for (const botId of new Set(done.map((row) => row.bot_id))) settingsChanged(botOwner(botId));
}

function routineOwner(routineId: string): string | null {
  const row = ensureDatabase().query("SELECT b.user_id FROM gond_routines r JOIN gond_bots b ON b.id = r.bot_id WHERE r.id = ?").get(routineId) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

export function routinePrompt(routine: Routine): string {
  const skill = routine.skillId ? getSkillForRoutine(routine.skillId, routineOwner(routine.id)) : null;
  return `[${routine.watch ? "Watch" : "Routine"}: ${routine.name}]${skill ? ` Use /${skill.slug}.` : ""} ${routine.prompt}`;
}

function getSkillForRoutine(id: string, userId: string | null): { slug: string } | null {
  return ensureDatabase().query("SELECT slug FROM gond_skills WHERE id = ? AND user_id IS ?").get(id, userId) as { slug: string } | null;
}
