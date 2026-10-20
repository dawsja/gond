import type { Routine, RoutineInput } from "@gond/shared";
import { Cron } from "croner";
import { ensureDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";

type Row = {
  id: string;
  bot_id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: number;
  skill_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

function toRoutine(row: Row): Routine {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled === 1,
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

export function createRoutine(botId: string, input: Omit<RoutineInput, "skillId"> & { skillId?: string | null }): Routine {
  const id = newId("r");
  const at = now();
  const next = input.enabled ? nextRun(input.cron, input.timezone)?.toISOString() ?? null : null;
  ensureDatabase()
    .query("INSERT INTO gond_routines (id, bot_id, name, cron, timezone, prompt, enabled, skill_id, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, botId, input.name, input.cron, input.timezone, input.prompt, input.enabled ? 1 : 0, input.skillId ?? null, next, at, at);
  settingsChanged();
  return getRoutine(id)!;
}

export function updateRoutine(id: string, patch: Partial<RoutineInput>): Routine | null {
  const current = getRoutine(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  const nextRunAt = next.enabled ? nextRun(next.cron, next.timezone)?.toISOString() ?? null : null;
  ensureDatabase()
    .query("UPDATE gond_routines SET name = ?, cron = ?, timezone = ?, prompt = ?, enabled = ?, skill_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.cron, next.timezone, next.prompt, next.enabled ? 1 : 0, next.skillId ?? null, nextRunAt, now(), id);
  settingsChanged();
  return getRoutine(id);
}

export function deleteRoutine(id: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_routines WHERE id = ?").run(id).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

export function claimDueRoutines(at = new Date()): Routine[] {
  const db = ensureDatabase();
  const rows = db.query("SELECT * FROM gond_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(at.toISOString()) as Row[];
  const due: Routine[] = [];
  for (const row of rows) {
    let next: string | null = null;
    try {
      next = nextRun(row.cron, row.timezone, at)?.toISOString() ?? null;
    } catch {
      next = null;
    }
    db.query("UPDATE gond_routines SET last_run_at = ?, next_run_at = ? WHERE id = ?").run(at.toISOString(), next, row.id);
    due.push(toRoutine({ ...row, last_run_at: at.toISOString(), next_run_at: next }));
  }
  if (due.length) settingsChanged();
  return due;
}

export function recordRoutineRun(routineId: string, messageId: string | null) {
  ensureDatabase().query("INSERT INTO gond_routine_runs (id, routine_id, message_id, status, started_at) VALUES (?, ?, ?, 'started', ?)").run(newId("rr"), routineId, messageId, now());
}

export function finishRoutineRun(messageId: string, ok: boolean) {
  const db = ensureDatabase();
  db.query("UPDATE gond_routine_runs SET status = ?, finished_at = ? WHERE message_id = ? AND status = 'started'").run(ok ? "done" : "failed", now(), messageId);
}

function routineOwner(routineId: string): string | null {
  const row = ensureDatabase().query("SELECT b.user_id FROM gond_routines r JOIN gond_bots b ON b.id = r.bot_id WHERE r.id = ?").get(routineId) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

export function routinePrompt(routine: Routine): string {
  const skill = routine.skillId ? getSkillForRoutine(routine.skillId, routineOwner(routine.id)) : null;
  return `[Routine: ${routine.name}]${skill ? ` Use /${skill.slug}.` : ""} ${routine.prompt}`;
}

function getSkillForRoutine(id: string, userId: string | null): { slug: string } | null {
  return ensureDatabase().query("SELECT slug FROM gond_skills WHERE id = ? AND user_id IS ?").get(id, userId) as { slug: string } | null;
}
