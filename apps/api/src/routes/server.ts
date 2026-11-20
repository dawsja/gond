import { isRetentionDays, type ServerStorage } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { BackupError, backupFile, backupsDir, cleanUpNow, createBackup, databaseStats, deleteBackup, freeBytes, listBackups } from "../backup.ts";
import { dataDir } from "../config.ts";
import { retentionSettings, setRetentionSettings } from "../data/settings.ts";
import { readBody } from "./body.ts";

async function storageReport(): Promise<ServerStorage> {
  const backups = listBackups();
  return { db: await databaseStats(), freeBytes: freeBytes(backups.length ? backupsDir() : dataDir()), backups, retention: retentionSettings() };
}

const failure = (error: unknown, fallback: string) => (error instanceof BackupError ? error.message : fallback);

export function serverRoutes() {
  const app = new Hono<Env>();

  app.get("/server/storage", async (c) => c.json(await storageReport()));

  app.patch("/server/storage", async (c) => {
    const body = await readBody(c);
    if (body.usageKeepDays !== undefined && !isRetentionDays(body.usageKeepDays)) return c.json({ error: "Pick one of the retention periods on offer" }, 400);
    if (body.attachmentsKeepDays !== undefined && !isRetentionDays(body.attachmentsKeepDays)) return c.json({ error: "Pick one of the retention periods on offer" }, 400);
    setRetentionSettings({
      ...(body.usageKeepDays !== undefined ? { usageKeepDays: body.usageKeepDays } : {}),
      ...(body.attachmentsKeepDays !== undefined ? { attachmentsKeepDays: body.attachmentsKeepDays } : {}),
    });
    return c.json(await storageReport());
  });

  app.post("/server/backups", async (c) => {
    try {
      const backup = await createBackup("manual");
      return c.json({ backup, ...(await storageReport()) }, 201);
    } catch (error) {
      return c.json({ error: failure(error, "Couldn't save the backup. Try again in a moment.") }, 500);
    }
  });

  app.get("/server/backups/:name", (c) => {
    const name = c.req.param("name");
    const full = backupFile(name);
    if (!full) return c.json({ error: "Couldn't find that backup" }, 404);
    return new Response(Bun.file(full), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.delete("/server/backups/:name", (c) => (deleteBackup(c.req.param("name")) ? c.body(null, 204) : c.json({ error: "Couldn't find that backup" }, 404)));

  app.post("/server/storage/compact", async (c) => {
    try {
      const result = await cleanUpNow();
      return c.json({ result, ...(await storageReport()) });
    } catch (error) {
      return c.json({ error: failure(error, "Couldn't clean up. Try again in a moment.") }, 500);
    }
  });

  return app;
}
