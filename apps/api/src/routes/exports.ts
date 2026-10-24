import { isExportRange } from "@gond/shared";
import { Hono } from "hono";
import { ownsThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { exportChats, exportFileName, exportLabel, exportSince, runExport } from "../chat-export.ts";
import { createExport, deleteExport, exportFile, getExport, listExports, preparingExport } from "../data/exports.ts";

export function exportsRoutes() {
  const app = new Hono<Env>();

  app.get("/exports", (c) => c.json({ exports: listExports(userId(c)) }));

  app.post("/exports", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: unknown; range?: unknown };
    const range = body.range === undefined ? "all" : body.range;
    if (!isExportRange(range)) return c.json({ error: "Pick how far back to go from the list" }, 400);
    const threadId = body.threadId === undefined || body.threadId === null ? null : body.threadId;
    if (threadId !== null && (typeof threadId !== "string" || !ownsThread(c, threadId))) return c.json({ error: "Couldn't find that chat" }, 404);
    const me = userId(c);
    if (preparingExport(me)) return c.json({ error: "An export is already being prepared. Wait for it to finish, or delete it." }, 409);
    const chats = exportChats(me, threadId);
    if (!chats.length) return c.json({ error: "There are no chats to export yet." }, 400);
    const label = exportLabel(threadId ? chats[0]!.name : null, range);
    const job = createExport({ userId: me, threadId, since: exportSince(range), label, total: chats.length });
    void runExport(job, label);
    return c.json({ export: getExport(job.id, me) }, 202);
  });

  app.get("/exports/:id/download", (c) => {
    const file = exportFile(c.req.param("id"), userId(c));
    if (!file) return c.json({ error: "That export isn't kept any more. Start a new one." }, 404);
    return new Response(Buffer.from(file.data), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${exportFileName(file.meta.createdAt, userId(c))}"`,
        "Content-Length": String(file.data.byteLength),
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.delete("/exports/:id", (c) => {
    if (!deleteExport(c.req.param("id"), userId(c))) return c.json({ error: "Couldn't find that export" }, 404);
    return c.body(null, 204);
  });

  return app;
}
