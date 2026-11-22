import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

// The database's heavy jobs, on a connection of their own in a worker, so the API's one thread keeps
// answering. Reads in WAL mode never wait on the API's writes; the deletes go in small batches, so a
// write of the API's waits for one batch at most. A file goes in the same transaction that marks it
// removed on its message, so a chat never points at bytes that are gone without saying so.

export type StorageJob =
  | { op: "stats"; file: string }
  | { op: "backup"; file: string; dest: string }
  | { op: "prune"; file: string; usageBefore: string | null; filesBefore: string | null };

export type StorageReply = { result: unknown } | { error: string };

export type Stats = {
  totalBytes: number;
  walBytes: number;
  messagesBytes: number;
  attachmentsBytes: number;
  usageBytes: number;
  exportsBytes: number;
  teachingsBytes: number;
  attachmentCount: number;
  usageCount: number;
};

export type Pruned = { usage: number; files: number; freedBytes: number };

// A row of the usage table is a few short fields; this is roughly what one takes on disk.
const USAGE_ROW_BYTES = 160;
const USAGE_BATCH = 5_000;
// A batch of files stops at this many or this many bytes, whichever comes first: freeing a file means reading every page of it.
const FILE_BATCH = 50;
const FILE_BATCH_BYTES = 32 * 1024 * 1024;

const size = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

function open(file: string): Database {
  const db = new Database(file, { readwrite: true, strict: true });
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

function stats(file: string): Stats {
  const db = open(file);
  try {
    const scalar = (sql: string) => Number((db.query(sql).get() as { n: number | null } | null)?.n ?? 0);
    const files = db.query("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM gond_attachments").get() as { bytes: number; n: number };
    const usage = scalar("SELECT COUNT(*) AS n FROM gond_usage");
    const walBytes = size(`${file}-wal`);
    return {
      totalBytes: size(file) + walBytes + size(`${file}-shm`),
      walBytes,
      messagesBytes: scalar("SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS n FROM gond_messages"),
      attachmentsBytes: Number(files.bytes),
      usageBytes: usage * USAGE_ROW_BYTES,
      exportsBytes: scalar("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM gond_export_files"),
      teachingsBytes: scalar("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM gond_teaching_frames"),
      attachmentCount: Number(files.n),
      usageCount: usage,
    };
  } finally {
    db.close();
  }
}

function backup(file: string, dest: string): number {
  const db = open(file);
  try {
    db.query("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
  return size(dest);
}

function prune(file: string, usageBefore: string | null, filesBefore: string | null): Pruned {
  const db = open(file);
  const out: Pruned = { usage: 0, files: 0, freedBytes: 0 };
  try {
    if (usageBefore) {
      for (;;) {
        const changed = db.query("DELETE FROM gond_usage WHERE rowid IN (SELECT rowid FROM gond_usage WHERE created_at < ? LIMIT ?)").run(usageBefore, USAGE_BATCH).changes;
        out.usage += changed;
        if (changed < USAGE_BATCH) break;
      }
    }
    if (filesBefore) {
      const pick = db.query("SELECT rowid, id, message_id, size FROM gond_attachments WHERE created_at < ? LIMIT ?");
      const readMessage = db.query("SELECT attachments FROM gond_messages WHERE id = ?");
      const writeMessage = db.query("UPDATE gond_messages SET attachments = ? WHERE id = ?");
      const removeBatch = db.transaction((batch: FileRow[]) => {
        for (const [messageId, ids] of byMessage(batch)) {
          const row = readMessage.get(messageId) as { attachments: string } | null;
          if (row) writeMessage.run(markRemoved(row.attachments, ids), messageId);
        }
        return db.query(`DELETE FROM gond_attachments WHERE rowid IN (${batch.map(() => "?").join(", ")})`).run(...batch.map((file) => file.rowid)).changes;
      });
      for (;;) {
        const rows = pick.all(filesBefore, FILE_BATCH) as FileRow[];
        if (!rows.length) break;
        const batch: FileRow[] = [];
        let bytes = 0;
        for (const row of rows) {
          if (batch.length && bytes + row.size > FILE_BATCH_BYTES) break;
          batch.push(row);
          bytes += row.size;
        }
        out.files += removeBatch(batch);
        out.freedBytes += bytes;
      }
    }
    if (out.usage || out.files) db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } finally {
    db.close();
  }
  out.freedBytes += out.usage * USAGE_ROW_BYTES;
  return out;
}

type FileRow = { rowid: number; id: string; message_id: string | null; size: number };

function byMessage(files: FileRow[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of files) if (file.message_id) out.set(file.message_id, (out.get(file.message_id) ?? new Set()).add(file.id));
  return out;
}

export function markRemoved(attachments: string, ids: Set<string>): string {
  try {
    const list = JSON.parse(attachments) as unknown;
    if (!Array.isArray(list)) return attachments;
    return JSON.stringify(list.map((file) => (file && typeof file === "object" && ids.has((file as { id?: string }).id ?? "") ? { ...file, removed: true } : file)));
  } catch {
    return attachments;
  }
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<StorageJob>) => {
  const job = event.data;
  try {
    const result = job.op === "stats" ? stats(job.file) : job.op === "backup" ? backup(job.file, job.dest) : prune(job.file, job.usageBefore, job.filesBefore);
    postMessage({ result } satisfies StorageReply);
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies StorageReply);
  }
};
