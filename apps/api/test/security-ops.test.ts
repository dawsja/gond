import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackupInfo } from "@gond/shared";

let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "gond-secops-"));
  process.env.GOND_DATA_DIR = dir;
  const { ensureDatabase } = await import("../src/db/init.ts");
  const db = ensureDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, role TEXT, createdAt TEXT, updatedAt TEXT);`);
  db.query('INSERT OR REPLACE INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("u-admin", "admin", "admin@example.com", "admin", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  db.query('INSERT OR REPLACE INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("u-user", "user", "user@example.com", "user", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
});

afterAll(async () => {
  const { closeDb } = await import("../src/db/sqlite.ts");
  const { resetDbReady } = await import("../src/db/init.ts");
  closeDb();
  resetDbReady();
  Bun.gc(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("Backups, retention, cleanup and shutdown", () => {
  test("a backup is a valid standalone copy made beside the API, keeps the newest of each kind and refuses traversal", async () => {
    const { backupFile, backupsDir, createBackup, deleteBackup, listBackups } = await import("../src/backup.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const base = new Date("2026-11-20T12:00:00Z");

    const making = createBackup("pre-update", base);
    // The copy is a worker's: the API's own connection answers while it runs.
    expect((ensureDatabase().query("SELECT 1 AS one").get() as { one: number }).one).toBe(1);
    const b1 = await making;
    const b2 = await createBackup("pre-update", new Date(base.getTime() + 1_000));
    const b3 = await createBackup("pre-update", new Date(base.getTime() + 2_000));
    const manual = await createBackup("manual", new Date(base.getTime() + 3_000));

    expect(listBackups().filter((b) => b.reason === "pre-update").map((b) => b.name)).toEqual([b3.name, b2.name]);
    expect(backupFile(b1.name)).toBeNull();
    expect(backupFile("../gond.db")).toBeNull();
    expect(backupFile("evil.db")).toBeNull();
    expect(listBackups().some((b) => b.name.endsWith(".tmp"))).toBe(false);

    const snap = new Database(backupFile(manual.name)!, { readonly: true });
    const row = snap.query("SELECT id FROM gond_settings WHERE id = 1").get() as { id: number } | null;
    snap.close();
    expect(row?.id).toBe(1);

    // A copy an earlier run left half made is cleared before the next one.
    const partial = path.join(backupsDir(), "gond-2026-11-19T120000Z-manual.db.tmp");
    writeFileSync(partial, "half");
    await createBackup("manual", new Date(base.getTime() + 4_000));
    expect(existsSync(partial)).toBe(false);

    expect(deleteBackup(manual.name)).toBe(true);
    expect(backupFile(manual.name)).toBeNull();
  });

  test("a backup that won't fit removes older ones of its kind only when that's enough, and never the newest", async () => {
    const { roomFor, HEADROOM } = await import("../src/backup.ts");
    const MB = 1024 * 1024;
    const backup = (name: string, reason: BackupInfo["reason"], at: string): BackupInfo => ({ name, reason, size: 100 * MB, createdAt: at });
    const saved = [backup("new-update", "pre-update", "2026-11-03"), backup("old-update", "pre-update", "2026-11-02"), backup("manual", "manual", "2026-11-01")];
    expect(roomFor(HEADROOM + 100 * MB, 100 * MB, saved, "pre-update")).toEqual([]);
    expect(roomFor(HEADROOM + 20 * MB, 100 * MB, saved, "pre-update")).toEqual(["old-update"]);
    // Removing the older one still isn't enough: nothing goes.
    expect(roomFor(HEADROOM, 300 * MB, saved, "pre-update")).toBeNull();
    // A manual backup never removes an update's.
    expect(roomFor(HEADROOM, 50 * MB, saved, "manual")).toBeNull();
  });

  test("cleanup removes aged usage and files in a worker, and reports what the database can use again", async () => {
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { setRetentionSettings } = await import("../src/data/settings.ts");
    const { cleanUpNow, databaseStats } = await import("../src/backup.ts");
    const db = ensureDatabase();

    db.query("INSERT INTO gond_usage (user_id, bot_id, thread_id, source, model, input, output, cache_read, cache_write, cost, created_at) VALUES (?, NULL, NULL, 'openai', 'm', 10, 5, 0, 0, NULL, ?)").run("u-admin", "2025-01-01T00:00:00.000Z");
    db.query("INSERT INTO gond_usage (user_id, bot_id, thread_id, source, model, input, output, cache_read, cache_write, cost, created_at) VALUES (?, NULL, NULL, 'openai', 'm', 20, 5, 0, 0, NULL, ?)").run("u-admin", "2026-11-19T00:00:00.000Z");
    for (let i = 0; i < 60; i += 1) db.query("INSERT INTO gond_attachments (id, message_id, name, media_type, size, data, created_at) VALUES (?, NULL, 'old.bin', 'application/octet-stream', 1024, ?, ?)").run(`f_old_${i}`, new Uint8Array(1024), "2025-01-01T00:00:00.000Z");
    db.query("INSERT INTO gond_attachments (id, message_id, name, media_type, size, data, created_at) VALUES (?, NULL, 'new.bin', 'application/octet-stream', 512, ?, ?)").run("f_new", new Uint8Array(512), "2026-11-19T00:00:00.000Z");

    const before = await databaseStats();
    expect(before.attachmentCount).toBe(61);
    expect(before.usageCount).toBe(2);

    setRetentionSettings({ usageKeepDays: 30, attachmentsKeepDays: 30 });
    const result = await cleanUpNow(new Date("2026-11-20T00:00:00.000Z"));
    expect(result.prunedUsage).toBe(1);
    expect(result.prunedAttachments).toBe(60);
    expect(result.freedBytes).toBeGreaterThanOrEqual(60 * 1024);
    expect(result.db.attachmentCount).toBe(1);
    expect(result.db.usageCount).toBe(1);
    setRetentionSettings({ usageKeepDays: 0, attachmentsKeepDays: 0 });
  });

  test("a file cleanup removes stays on its message by name, marked removed, beside the ones still kept", async () => {
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { setRetentionSettings } = await import("../src/data/settings.ts");
    const { cleanUpNow } = await import("../src/backup.ts");
    const { createBot } = await import("../src/data/bots.ts");
    const { getAttachment, listMessages, postMessage, storeAttachment } = await import("../src/data/threads.ts");
    const { transcriptLines } = await import("../src/transcript.ts");
    const { botInputSchema } = await import("@gond/shared");
    const db = ensureDatabase();
    const bot = createBot(botInputSchema.parse({ name: "Keeper" }), "u-admin");
    const old = storeAttachment({ name: "receipt.png", mediaType: "image/png", data: new Uint8Array(2048) });
    const recent = storeAttachment({ name: "lease.pdf", mediaType: "application/pdf", data: new Uint8Array(512) });
    const message = postMessage({ threadId: bot.threadId, author: "you", body: "Both", attachments: [old, recent], answered: true });
    db.query("UPDATE gond_attachments SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);

    setRetentionSettings({ attachmentsKeepDays: 30 });
    await cleanUpNow(new Date("2026-11-20T00:00:00.000Z"));
    setRetentionSettings({ attachmentsKeepDays: 0 });

    const [after] = listMessages(bot.threadId).filter((m) => m.id === message.id);
    expect(after!.attachments).toEqual([{ ...old, removed: true }, recent]);
    expect(getAttachment(old.id)).toBeNull();
    expect(getAttachment(recent.id)).not.toBeNull();
    expect(transcriptLines([after!], [bot], bot)).toContain("receipt.png (removed since, to save space), lease.pdf");
  });

  test("server storage routes serve backups, update retention and enforce admin-only access", async () => {
    const { Hono } = await import("hono");
    const { requireAdmin } = await import("../src/access.ts");
    const { serverRoutes } = await import("../src/routes/server.ts");

    const build = (role: "admin" | "user") => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("session" as never, { user: { id: role === "admin" ? "u-admin" : "u-user", role } } as never);
        await next();
      });
      app.use("/api/server/*", requireAdmin);
      app.route("/api", serverRoutes());
      return app;
    };

    const userApp = build("user");
    expect((await userApp.request("/api/server/storage")).status).toBe(403);
    expect((await userApp.request("/api/server/backups", { method: "POST" })).status).toBe(403);

    const adminApp = build("admin");
    const initial = await adminApp.request("/api/server/storage");
    expect(initial.status).toBe(200);
    const body = (await initial.json()) as { freeBytes: number; retention: { usageKeepDays: number } };
    expect(body.freeBytes).toBeGreaterThan(0);
    expect(body.retention.usageKeepDays).toBe(0);

    const patched = await adminApp.request("/api/server/storage", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ usageKeepDays: 90 }) });
    expect(patched.status).toBe(200);
    expect((await patched.json()) as Record<string, unknown>).toMatchObject({ retention: { usageKeepDays: 90 } });
    expect((await adminApp.request("/api/server/storage", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ usageKeepDays: 12 }) })).status).toBe(400);

    const created = await adminApp.request("/api/server/backups", { method: "POST" });
    expect(created.status).toBe(201);
    const { backup } = (await created.json()) as { backup: { name: string } };
    const dl = await adminApp.request(`/api/server/backups/${encodeURIComponent(backup.name)}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect((await dl.arrayBuffer()).byteLength).toBeGreaterThan(0);

    expect((await adminApp.request(`/api/server/backups/${encodeURIComponent(backup.name)}`, { method: "DELETE" })).status).toBe(204);
    expect((await adminApp.request(`/api/server/backups/${encodeURIComponent(backup.name)}`)).status).toBe(404);
  });

  test("checkpointAndCloseDb checkpoints WAL and allows clean reopen", async () => {
    const { checkpointAndCloseDb, getDb } = await import("../src/db/sqlite.ts");
    const { resetDbReady, ensureDatabase } = await import("../src/db/init.ts");
    checkpointAndCloseDb();
    resetDbReady();
    const reopened = ensureDatabase();
    expect(reopened).toBe(getDb());
    expect((reopened.query("SELECT id FROM gond_settings WHERE id = 1").get() as { id: number }).id).toBe(1);
  });
});
