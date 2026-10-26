import { TEACH_MAX_MINUTES, type TeachDraft, type Teaching, type TeachNote, type TeachStatus, type TeachStep } from "@gond/shared";
import { approvalTimeoutMs } from "../config.ts";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { newId, now } from "../ids.ts";

type TeachingRow = {
  id: string;
  user_id: string;
  bot_id: string;
  thread_id: string;
  status: TeachStatus;
  steps: string;
  notes: string;
  skipped: string;
  hidden: string;
  active_ms: number;
  paused_for: string | null;
  full: number;
  draft: string | null;
  previous: string | null;
  started_at: string | null;
  ended_at: string | null;
  ended_why: string | null;
  error: string | null;
  skill_id: string | null;
  message_id: string | null;
  prompt_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Where a teaching is still in the person's hands or the bot's, so another can't start beside it. */
export const OPEN_TEACHING: TeachStatus[] = ["recording", "paused", "review", "looking"];

const parse = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function toTeaching(row: TeachingRow, frames: number, skillSlug: string | null): Teaching {
  const skipped = new Set(parse<number[]>(row.skipped, []));
  const hidden = new Set(parse<number[]>(row.hidden, []));
  const steps = parse<TeachStep[]>(row.steps, []).map((step) => ({ ...step, ...(skipped.has(step.n) ? { skipped: true } : {}), ...(hidden.has(step.n) ? { hidden: true } : {}) }));
  return {
    id: row.id,
    botId: row.bot_id,
    threadId: row.thread_id,
    status: row.status,
    steps,
    notes: parse<TeachNote[]>(row.notes, []),
    activeMs: row.active_ms,
    maxMs: TEACH_MAX_MINUTES * 60_000,
    pausedFor: row.paused_for === "person" || row.paused_for === "away" ? row.paused_for : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedWhy: row.ended_why,
    frames,
    full: row.full === 1,
    draft: parse<TeachDraft | null>(row.draft, null),
    previous: parse<TeachDraft | null>(row.previous, null),
    error: row.error,
    skillSlug,
    createdAt: row.created_at,
  };
}

function row(id: string): TeachingRow | null {
  return ensureDatabase().query("SELECT * FROM gond_teachings WHERE id = ?").get(id) as TeachingRow | null;
}

/** A "Show me how" card nobody started reads as expired, like any card nobody answered. */
function expired(found: TeachingRow): boolean {
  return found.status === "offered" && Date.now() - Date.parse(found.created_at) > approvalTimeoutMs();
}

function build(found: TeachingRow): Teaching {
  if (expired(found)) found = { ...found, status: "discarded", ended_why: "expired" };
  const db = ensureDatabase();
  const frames = (db.query("SELECT COUNT(*) AS n FROM gond_teaching_frames WHERE teaching_id = ?").get(found.id) as { n: number }).n;
  const slug = found.skill_id ? ((db.query("SELECT slug FROM gond_skills WHERE id = ?").get(found.skill_id) as { slug: string } | null)?.slug ?? null) : null;
  return toTeaching(found, frames, slug);
}

/** A teaching, only for the person it belongs to. */
export function getTeaching(id: string, userId: string): Teaching | null {
  const found = row(id);
  return found && found.user_id === userId ? build(found) : null;
}

/** A teaching whoever asks, for the API's own work (the box's stream, a bot's tool). */
export function teachingById(id: string): (Teaching & { userId: string; messageId: string | null; promptId: string | null }) | null {
  const found = row(id);
  return found ? { ...build(found), userId: found.user_id, messageId: found.message_id, promptId: found.prompt_id } : null;
}

/** The teaching a hidden prompt asked its bot to look at, if this message is one. */
export function teachingAskedBy(messageId: string): string | null {
  const found = ensureDatabase().query("SELECT id FROM gond_teachings WHERE prompt_id = ?").get(messageId) as { id: string } | null;
  return found?.id ?? null;
}

export function teachingChanged(id: string) {
  const found = row(id);
  if (found) emit({ topic: "teaching", userId: found.user_id, teaching: build(found) });
}

/** The person's teaching still being shown or looked at, if there is one: one at a time. */
export function openTeaching(userId: string): Teaching | null {
  const found = ensureDatabase()
    .query(`SELECT * FROM gond_teachings WHERE user_id = ? AND status IN (${OPEN_TEACHING.map(() => "?").join(", ")}) ORDER BY created_at DESC LIMIT 1`)
    .get(userId, ...OPEN_TEACHING) as TeachingRow | null;
  return found ? build(found) : null;
}

/** Every teaching left mid-way, for the API to pick up again at start. */
export function unfinishedTeachings(): (Teaching & { userId: string; promptId: string | null })[] {
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_teachings WHERE status IN (${OPEN_TEACHING.map(() => "?").join(", ")})`)
    .all(...OPEN_TEACHING) as TeachingRow[];
  return rows.map((found) => ({ ...build(found), userId: found.user_id, promptId: found.prompt_id }));
}

/** Whether the prompt that asked a bot to look is answered (or gone), so its turn is over. */
export function promptDone(messageId: string): boolean {
  const found = ensureDatabase().query("SELECT answered_at FROM gond_messages WHERE id = ?").get(messageId) as { answered_at: string | null } | null;
  return !found || found.answered_at !== null;
}

export function teachingsIn(threadId: string, statuses: TeachStatus[]): Teaching[] {
  const rows = ensureDatabase()
    .query(`SELECT * FROM gond_teachings WHERE thread_id = ? AND status IN (${statuses.map(() => "?").join(", ")})`)
    .all(threadId, ...statuses) as TeachingRow[];
  return rows.map(build);
}

export function createTeaching(input: { userId: string; botId: string; threadId: string; status: TeachStatus }): string {
  const id = newId("teach");
  const at = now();
  ensureDatabase()
    .query("INSERT INTO gond_teachings (id, user_id, bot_id, thread_id, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.userId, input.botId, input.threadId, input.status, input.status === "recording" ? at : null, at, at);
  return id;
}

type Patch = Partial<{
  status: TeachStatus;
  steps: TeachStep[];
  notes: TeachNote[];
  skipped: number[];
  hidden: number[];
  activeMs: number;
  pausedFor: "person" | "away" | null;
  full: boolean;
  draft: TeachDraft | null;
  previous: TeachDraft | null;
  startedAt: string | null;
  endedAt: string | null;
  endedWhy: string | null;
  error: string | null;
  skillId: string | null;
  messageId: string | null;
  promptId: string | null;
}>;

const COLUMNS: Record<keyof Patch, string> = {
  status: "status",
  steps: "steps",
  notes: "notes",
  skipped: "skipped",
  hidden: "hidden",
  activeMs: "active_ms",
  pausedFor: "paused_for",
  full: "full",
  draft: "draft",
  previous: "previous",
  startedAt: "started_at",
  endedAt: "ended_at",
  endedWhy: "ended_why",
  error: "error",
  skillId: "skill_id",
  messageId: "message_id",
  promptId: "prompt_id",
};

/** Writes what changed; `quiet` leaves the live event to the caller, which sends one for several writes. */
export function updateTeaching(id: string, patch: Patch, options: { from?: TeachStatus[]; quiet?: boolean } = {}): boolean {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch) as [keyof Patch, unknown][]) {
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key]} = ?`);
    if (typeof value === "boolean") values.push(value ? 1 : 0);
    else if (value === null || typeof value === "string" || typeof value === "number") values.push(value);
    else values.push(JSON.stringify(value));
  }
  if (!sets.length) return false;
  const guard = options.from?.length ? ` AND status IN (${options.from.map(() => "?").join(", ")})` : "";
  const changed = ensureDatabase()
    .query(`UPDATE gond_teachings SET ${sets.join(", ")}, updated_at = ? WHERE id = ?${guard}`)
    .run(...values, now(), id, ...(options.from ?? [])).changes;
  if (changed && !options.quiet) teachingChanged(id);
  return changed > 0;
}

export function saveTeachingFrame(teachingId: string, frame: { n: number; step: number | null; width: number; height: number; data: Uint8Array }) {
  ensureDatabase()
    .query("INSERT OR REPLACE INTO gond_teaching_frames (teaching_id, n, step, width, height, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(teachingId, frame.n, frame.step, frame.width, frame.height, frame.data);
}

export function teachingFrame(teachingId: string, n: number): { data: Uint8Array; width: number; height: number } | null {
  const found = ensureDatabase().query("SELECT data, width, height FROM gond_teaching_frames WHERE teaching_id = ? AND n = ?").get(teachingId, n) as { data: Uint8Array; width: number; height: number } | null;
  return found ?? null;
}

export function teachingFrames(teachingId: string): { n: number; step: number | null }[] {
  return ensureDatabase().query("SELECT n, step FROM gond_teaching_frames WHERE teaching_id = ? ORDER BY n").all(teachingId) as { n: number; step: number | null }[];
}

export function deleteTeachingFrames(teachingId: string) {
  ensureDatabase().query("DELETE FROM gond_teaching_frames WHERE teaching_id = ?").run(teachingId);
}

/** A recording's pictures are kept a week after it ended; the steps and the skill stay. */
export const TEACH_FRAMES_KEEP_DAYS = 7;

export function expireTeachingFrames(at = Date.now()): number {
  const before = new Date(at - TEACH_FRAMES_KEEP_DAYS * 24 * 60 * 60_000).toISOString();
  return ensureDatabase()
    .query("DELETE FROM gond_teaching_frames WHERE teaching_id IN (SELECT id FROM gond_teachings WHERE status IN ('saved', 'discarded', 'failed') AND updated_at < ?)")
    .run(before).changes;
}

export function deleteTeaching(id: string) {
  ensureDatabase().query("DELETE FROM gond_teachings WHERE id = ?").run(id);
}

export function deleteTeachingsOf(input: { userId?: string; botId?: string }) {
  const db = ensureDatabase();
  if (input.botId) db.query("DELETE FROM gond_teachings WHERE bot_id = ?").run(input.botId);
  else if (input.userId) db.query("DELETE FROM gond_teachings WHERE user_id = ?").run(input.userId);
}
