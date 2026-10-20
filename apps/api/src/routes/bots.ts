import { AVATAR_MAX_BYTES, BOT_TEMPLATES, botInputSchema, botPatchSchema, pickBotName } from "@gond/shared";
import { Hono } from "hono";
import { ownBot, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { boxConfig, deleteBotHome } from "../box.ts";
import { clearBotAvatar, createBot, deleteBot, getBotAvatar, getPrimary, listBots, setBotAvatar, setPrimary, updateBot } from "../data/bots.ts";
import { listRules, removeRule } from "../data/approvals.ts";
import { postMessage } from "../data/threads.ts";
import { stopBot, syncSoul } from "../responder.ts";
import { addFromTemplate, greet, templateById } from "../templates.ts";
import { allowedToolkits } from "../toolkits.ts";

export function botsRoutes() {
  const app = new Hono<Env>();

  app.get("/bots", (c) => c.json({ bots: listBots({ includeHidden: c.req.query("hidden") === "1", userId: userId(c) }) }));

  app.get("/bots/name", (c) => c.json({ name: pickBotName(listBots({ includeHidden: true, userId: userId(c) }).map((b) => b.name)) }));

  app.get("/templates", (c) => c.json({ templates: BOT_TEMPLATES }));

  app.post("/bots", async (c) => {
    const parsed = botInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad bot" }, 400);
    const bot = createBot({ ...parsed.data, toolkits: allowedToolkits(parsed.data.toolkits) }, userId(c));
    postMessage({ threadId: bot.threadId, author: "system", kind: "event", body: `${bot.name} joined${bot.title ? ` as ${bot.title}` : ""}.`, answered: true });
    await syncSoul(bot);
    greet(bot);
    return c.json({ bot }, 201);
  });

  app.post("/bots/from-template", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { templateId?: string; toolkits?: string[]; enableRoutine?: boolean };
    const template = templateById(String(body.templateId ?? ""));
    if (!template) return c.json({ error: "No such template" }, 404);
    const bot = await addFromTemplate(template, userId(c), { toolkits: allowedToolkits(Array.isArray(body.toolkits) ? body.toolkits.map(String) : template.toolkits), enableRoutine: body.enableRoutine === true });
    return c.json({ bot }, 201);
  });

  app.get("/bots/:id", (c) => {
    const bot = ownBot(c, c.req.param("id"));
    return bot ? c.json({ bot, rules: listRules(bot.id) }) : c.json({ error: "No such bot" }, 404);
  });

  app.patch("/bots/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = botPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad bot" }, 400);
    const extra: { hidden?: boolean; pinned?: boolean; position?: number } = {};
    if (typeof body.hidden === "boolean") extra.hidden = body.hidden;
    if (typeof body.pinned === "boolean") extra.pinned = body.pinned;
    if (typeof body.position === "number") extra.position = body.position;
    if (!ownBot(c, c.req.param("id"))) return c.json({ error: "No such bot" }, 404);
    const toolkits = parsed.data.toolkits !== undefined ? { toolkits: allowedToolkits(parsed.data.toolkits) } : {};
    const bot = updateBot(c.req.param("id"), { ...parsed.data, ...toolkits, ...extra });
    if (!bot) return c.json({ error: "No such bot" }, 404);
    await syncSoul(bot);
    return c.json({ bot });
  });

  app.get("/bots/:id/avatar", (c) => {
    const bot = ownBot(c, c.req.param("id"));
    const avatar = bot ? getBotAvatar(bot.id) : null;
    if (!avatar) return c.json({ error: "No picture" }, 404);
    return new Response(Buffer.from(avatar.data), {
      headers: { "Content-Type": avatar.mediaType, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  });

  app.put("/bots/:id/avatar", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Send the picture as a file" }, 400);
    if (file.size > AVATAR_MAX_BYTES) return c.json({ error: "The picture must be under 2 MB" }, 413);
    try {
      return c.json({ bot: setBotAvatar(bot.id, new Uint8Array(await file.arrayBuffer())) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save the picture" }, 400);
    }
  });

  app.delete("/bots/:id/avatar", (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    clearBotAvatar(bot.id);
    return c.body(null, 204);
  });

  app.post("/bots/:id/primary", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const previous = getPrimary(userId(c));
    const primary = setPrimary(userId(c), bot.id);
    if (!primary) return c.json({ error: "A hidden bot can't be the primary one" }, 400);
    await syncSoul(primary);
    if (previous && previous.id !== primary.id) await syncSoul({ ...previous, primary: false });
    return c.json({ bot: primary });
  });

  app.delete("/bots/:id", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    await stopBot(bot);
    deleteBot(bot.id);
    const box = boxConfig(userId(c));
    if (box && c.req.query("keepFiles") !== "1") await deleteBotHome(box, bot.id).catch(() => undefined);
    return c.body(null, 204);
  });

  app.get("/bots/:id/rules", (c) => (ownBot(c, c.req.param("id")) ? c.json({ rules: listRules(c.req.param("id")) }) : c.json({ error: "No such bot" }, 404)));
  app.delete("/bots/:id/rules", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { rule?: string };
    if (!body.rule) return c.json({ error: "Missing rule" }, 400);
    if (!ownBot(c, c.req.param("id"))) return c.json({ error: "No such bot" }, 404);
    removeRule(c.req.param("id"), body.rule);
    return c.body(null, 204);
  });

  return app;
}
