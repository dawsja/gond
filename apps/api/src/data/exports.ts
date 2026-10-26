import { EXPORT_KEEP_DAYS, EXPORTS_LISTED, type ChatExport, type ExportStatus } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { emit } from "../events.ts";
import { newId, now } from "../ids.ts";

type ExportRow = {
  id: string;
  user_id: string;
  thread_id: string | null;
  since: string | null;
  label: string;
  status: ExportStatus;
  done: number;
  total: number;
  size: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
};

/** What an export was asked to gather: one conversation or all of them, from a moment or from the start. */
export type ExportJob = { id: string; userId: string; threadId: string | null; since: string | null };

function toExport(row: ExportRow): ChatExport {
  return { id: row.id, label: row.label, status: row.status, done: row.done, total: row.total, size: row.size, error: row.error, createdAt: row.created_at, finishedAt: row.finished_at, expiresAt: row.expires_at };
}

function row(id: string): ExportRow | null {
  return ensureDatabase().query("SELECT * FROM gond_exports WHERE id = ?").get(id) as ExportRow | null;
}

function changed(userId: string, id: string) {
  const found = row(id);
  emit({ topic: "exports", userId, id, export: found && found.user_id === userId ? toExport(found) : null });
}

export function getExport(id: string, userId: string): ChatExport | null {
  const found = row(id);
  return found && found.user_id === userId ? toExport(found) : null;
}

export function listExports(userId: string): ChatExport[] {
  expireExports();
  const rows = ensureDatabase().query("SELECT * FROM gond_exports WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(userId, EXPORTS_LISTED) as ExportRow[];
  return rows.map(toExport);
}

export function preparingExport(userId: string): ChatExport | null {
  const found = ensureDatabase().query("SELECT * FROM gond_exports WHERE user_id = ? AND status = 'preparing' LIMIT 1").get(userId) as ExportRow | null;
  return found ? toExport(found) : null;
}

/** Starts the row for a new export, and lets go of the person's oldest past what the list shows. */
export function createExport(input: { userId: string; threadId: string | null; since: string | null; label: string; total: number }): ExportJob {
  const id = newId("x");
  transaction((db) => {
    db.query("INSERT INTO gond_exports (id, user_id, thread_id, since, label, status, total, created_at) VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?)").run(id, input.userId, input.threadId, input.since, input.label, input.total, now());
    db.query("DELETE FROM gond_exports WHERE user_id = ? AND status != 'preparing' AND id NOT IN (SELECT id FROM gond_exports WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)").run(input.userId, input.userId, EXPORTS_LISTED);
  });
  changed(input.userId, id);
  return { id, userId: input.userId, threadId: input.threadId, since: input.since };
}

/** Whether the export is still wanted: false once the person deleted it, or was deleted. */
export function exportWanted(id: string): boolean {
  return row(id)?.status === "preparing";
}

export function exportProgress(job: ExportJob, done: number) {
  ensureDatabase().query("UPDATE gond_exports SET done = ? WHERE id = ? AND status = 'preparing'").run(done, job.id);
  changed(job.userId, job.id);
}

export function finishExport(job: ExportJob, data: Uint8Array) {
  const at = new Date();
  const expires = new Date(at.getTime() + EXPORT_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const kept = transaction((db) => {
    if (row(job.id)?.status !== "preparing") return false;
    db.query("INSERT INTO gond_export_files (export_id, data) VALUES (?, ?)").run(job.id, data);
    db.query("UPDATE gond_exports SET status = 'ready', done = total, size = ?, finished_at = ?, expires_at = ? WHERE id = ?").run(data.byteLength, at.toISOString(), expires.toISOString(), job.id);
    return true;
  });
  if (kept) changed(job.userId, job.id);
  return kept;
}

export function failExport(job: ExportJob, error: string) {
  ensureDatabase().query("UPDATE gond_exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'preparing'").run(error, now(), job.id);
  changed(job.userId, job.id);
}

export function exportFile(id: string, userId: string): { meta: ChatExport; data: Uint8Array } | null {
  const found = row(id);
  if (!found || found.user_id !== userId || found.status !== "ready" || (found.expires_at && found.expires_at <= now())) return null;
  const file = ensureDatabase().query("SELECT data FROM gond_export_files WHERE export_id = ?").get(id) as { data: Uint8Array } | null;
  return file ? { meta: toExport(found), data: file.data } : null;
}

/** Takes an export away, a preparing one included: its job sees it gone and stops. */
export function deleteExport(id: string, userId: string): boolean {
  const gone = ensureDatabase().query("DELETE FROM gond_exports WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  if (gone) changed(userId, id);
  return gone;
}

/** Lets go of the files of exports past their time; the row stays, marked expired, until newer ones push it out. */
export function expireExports(at = now()): number {
  return transaction((db) => {
    const ids = (db.query("SELECT id FROM gond_exports WHERE status = 'ready' AND expires_at <= ?").all(at) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      db.query("DELETE FROM gond_export_files WHERE export_id = ?").run(id);
      db.query("UPDATE gond_exports SET status = 'expired' WHERE id = ?").run(id);
    }
    return ids.length;
  });
}
