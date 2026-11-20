import type { BackupInfo, BackupReason, CompactResult, DatabaseStats } from "@gond/shared";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statfsSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { dataDir, ensureDataDir } from "./config.ts";
import { expireExports } from "./data/exports.ts";
import { retentionSettings } from "./data/settings.ts";
import { ensureDatabase } from "./db/init.ts";
import { dbPath } from "./db/sqlite.ts";
import type { Pruned, StorageJob, StorageReply } from "./storage-worker.ts";

const BACKUP_FILE = /^gond-(\d{4}-\d{2}-\d{2}T\d{6}Z)-(manual|pre-update)\.db$/;
// Each backup is a whole copy of the database, files included, on the same disk as the database.
const KEEP: Record<BackupReason, number> = { "pre-update": 2, manual: 3 };
// What a backup must leave free on the disk, past its own size, so the database itself never runs out.
export const HEADROOM = 256 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_MS: Record<StorageJob["op"], number> = { stats: 2 * 60_000, backup: 30 * 60_000, prune: 30 * 60_000 };

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export function backupsDir(): string {
  return path.join(dataDir(), "backups");
}

function ensureBackupsDir(): string {
  ensureDataDir();
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function stampOf(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/^(\d{4})(\d{2})(\d{2})T/, "$1-$2-$3T");
}

function isoFromStamp(stamp: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z` : new Date().toISOString();
}

export function listBackups(): BackupInfo[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    const match = BACKUP_FILE.exec(name);
    if (!match) continue;
    try {
      const info = statSync(path.join(dir, name));
      if (!info.isFile()) continue;
      out.push({ name, reason: match[2] as BackupReason, size: info.size, createdAt: isoFromStamp(match[1]!) });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/** Validates a backup filename and returns its absolute path if present, or null. */
export function backupFile(name: string): string | null {
  if (!BACKUP_FILE.test(name)) return null;
  const full = path.join(backupsDir(), name);
  return existsSync(full) ? full : null;
}

export function deleteBackup(name: string): boolean {
  const full = backupFile(name);
  if (!full) return false;
  try {
    unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

function trimBackups(reason: BackupReason, keep: number) {
  for (const old of listBackups().filter((b) => b.reason === reason).slice(keep)) deleteBackup(old.name);
}

/** A copy cut short (the API stopped, the disk filled) is never a backup. */
function clearPartial(dir: string) {
  for (const name of readdirSync(dir)) if (name.endsWith(".db.tmp") && BACKUP_FILE.test(name.slice(0, -4)) && !running.has(name)) rmQuietly(path.join(dir, name));
}

function rmQuietly(file: string) {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

export function freeBytes(dir: string): number {
  const disk = statfsSync(dir);
  return disk.bavail * disk.bsize;
}

/** About what a backup takes: the database's pages that hold data, since a copy leaves the free ones out. */
export function backupSizeEstimate(): number {
  const db = ensureDatabase();
  const pragma = (name: string) => Number((db.query(`PRAGMA ${name}`).get() as Record<string, number>)[name] ?? 0);
  return Math.max(0, pragma("page_count") - pragma("freelist_count")) * pragma("page_size");
}

const running = new Set<string>();
let heavy: Promise<unknown> = Promise.resolve();

/** One job in a worker of its own: started, answered once, and stopped, or stopped at its time limit. */
function inWorker<T>(job: StorageJob): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL("./storage-worker.ts", import.meta.url));
    const done = (finish: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      finish();
    };
    const timer = setTimeout(() => done(() => reject(new BackupError("That took too long and was stopped. Try again when Gond is less busy."))), JOB_MS[job.op]);
    worker.onmessage = (event: MessageEvent<StorageReply>) => done(() => ("error" in event.data ? reject(new BackupError(event.data.error)) : resolve(event.data.result as T)));
    worker.onerror = (event) => done(() => reject(new BackupError(event.message || "The database job stopped.")));
    worker.postMessage(job);
  });
}

/** Backups and cleanups take turns: two at once would only race each other for the disk. */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = heavy.then(work, work);
  heavy = next.catch(() => undefined);
  return next;
}

const sizeText = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/**
 * Which backups to remove so a new one of `reason` fits, oldest first: only those of its own kind beyond
 * the newest, since the new one stands in for them. None when it fits already; null when even removing
 * them all leaves too little, so nothing is removed for a backup that can't be made.
 */
export function roomFor(free: number, need: number, backups: BackupInfo[], reason: BackupReason): string[] | null {
  let room = free;
  const out: string[] = [];
  if (room >= need + HEADROOM) return out;
  for (const old of backups.filter((b) => b.reason === reason).slice(Math.max(0, KEEP[reason] - 1)).reverse()) {
    out.push(old.name);
    room += old.size;
    if (room >= need + HEADROOM) return out;
  }
  return null;
}

/** Makes room for a backup, or says how much it needs, so a full disk never takes the database down with it. */
function makeRoom(dir: string, reason: BackupReason, need: number) {
  const plan = roomFor(freeBytes(dir), need, listBackups(), reason);
  if (!plan) throw new BackupError(`There isn't enough free disk space for a backup: it needs about ${sizeText(need + HEADROOM)}, and ${sizeText(freeBytes(dir))} is free. Delete an older backup or free up some space, then try again.`);
  for (const name of plan) deleteBackup(name);
}

/**
 * A standalone copy of the database (`VACUUM INTO`, consistent as of one moment), made by a worker on a
 * connection of its own so the API keeps answering, written under a temporary name and renamed into
 * `<dataDir>/backups/` readable only by Gond's own user.
 */
export function createBackup(reason: BackupReason = "manual", at = new Date()): Promise<BackupInfo> {
  return oneAtATime(async () => {
    const dir = ensureBackupsDir();
    clearPartial(dir);
    makeRoom(dir, reason, backupSizeEstimate());
    let offset = 0;
    let name = "";
    do name = `gond-${stampOf(new Date(at.getTime() + offset++ * 1000))}-${reason}.db`;
    while (existsSync(path.join(dir, name)));
    const dest = path.join(dir, name);
    const temp = `${dest}.tmp`;
    running.add(path.basename(temp));
    try {
      await inWorker<number>({ op: "backup", file: dbPath(), dest: temp });
      chmodSync(temp, 0o600);
      renameSync(temp, dest);
    } catch (error) {
      rmQuietly(temp);
      throw error;
    } finally {
      running.delete(path.basename(temp));
    }
    trimBackups(reason, KEEP[reason]);
    return { name, reason, size: statSync(dest).size, createdAt: isoFromStamp(BACKUP_FILE.exec(name)![1]!) };
  });
}

/** How big the database and what's in it are; read by a worker, since it counts every message. */
export function databaseStats(): Promise<DatabaseStats> {
  ensureDatabase();
  return inWorker<DatabaseStats>({ op: "stats", file: dbPath() });
}

/**
 * Removes usage history and uploaded files older than the person's retention windows, and chat exports
 * past their time, in small batches in a worker. The space is free for the database to use again; the
 * file on disk keeps its size, since shrinking it would hold every write until the whole file is rewritten.
 */
export function pruneDatabase(at = new Date()): Promise<Pruned & { exports: number }> {
  return oneAtATime(async () => {
    const retention = retentionSettings();
    const before = (days: number) => (days > 0 ? new Date(at.getTime() - days * DAY_MS).toISOString() : null);
    const exports = expireExports(at.toISOString());
    const usageBefore = before(retention.usageKeepDays);
    const filesBefore = before(retention.attachmentsKeepDays);
    const pruned = usageBefore || filesBefore ? await inWorker<Pruned>({ op: "prune", file: dbPath(), usageBefore, filesBefore }) : { usage: 0, files: 0, freedBytes: 0 };
    return { ...pruned, exports };
  });
}

export async function cleanUpNow(at = new Date()): Promise<CompactResult> {
  const pruned = await pruneDatabase(at);
  return { freedBytes: pruned.freedBytes, prunedUsage: pruned.usage, prunedAttachments: pruned.files, prunedExports: pruned.exports, db: await databaseStats() };
}

const SWEEP_MS = 24 * 60 * 60 * 1000;
const holder = globalThis as typeof globalThis & { __gondLastRetentionSweep?: number };

/** Daily background sweep called from the dispatcher's minute tick. */
export function runScheduledRetention(at = Date.now()) {
  if (holder.__gondLastRetentionSweep && at - holder.__gondLastRetentionSweep < SWEEP_MS) return;
  holder.__gondLastRetentionSweep = at;
  void pruneDatabase(new Date(at))
    .then(({ usage, files, exports }) => {
      if (usage || files || exports) console.info(`[gond] Storage cleanup: removed ${usage} usage row(s), ${files} old file(s), ${exports} expired export(s)`);
    })
    .catch((error: unknown) => console.warn(`[gond] storage cleanup failed: ${error instanceof Error ? error.message : error}`));
}
