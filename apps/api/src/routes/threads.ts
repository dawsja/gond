import { ATTACHMENT_TYPES, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, isReaction, plainMarkdown, roomAnswerer, roomNameFor, type Bot, type ChatAttachment, type Thread } from "@gond/shared";
import { Hono } from "hono";
import { ownThread, ownsThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { getBot, listBots } from "../data/bots.ts";
import { attachmentOwner, createRoom, deleteRoom, getAttachment, getMessage, getThread, listExchange, listMessages, listThreads, markThreadRead, postMessage, searchMessages, setReaction, storeAttachment, updateRoom } from "../data/threads.ts";
import { activeTurns, postFromPerson, stopThread } from "../responder.ts";
import { workFor } from "../work.ts";

const MAX_BODY = 20_000;

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "application/json"]);

/** Who answers a room when nobody is named, by name. */
export function answererOf(members: string[], bots: Bot[]): string | null {
  return roomAnswerer(members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b) && !b!.hidden))?.name ?? null;
}

/** The line a room shows when it is renamed or its bots change, e.g. "Ada joined. Bo left.", and who answers now if that changed. */
export function roomChange(before: Pick<Thread, "name" | "members">, after: Pick<Thread, "name" | "members">, nameOf: (botId: string) => string, answerers: [string | null, string | null] = [null, null]): string | null {
  const lines: string[] = [];
  if (after.name !== before.name) lines.push(`Renamed to ${after.name}.`);
  const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  const joined = after.members.filter((id) => !before.members.includes(id)).map(nameOf);
  const left = before.members.filter((id) => !after.members.includes(id)).map(nameOf);
  if (joined.length) lines.push(`${list(joined)} joined.`);
  if (left.length) lines.push(`${list(left)} left.`);
  if (answerers[1] && answerers[0] !== answerers[1]) lines.push(`${answerers[1]} answers now when nobody's named.`);
  return lines.length ? lines.join(" ") : null;
}

export function threadsRoutes() {
  const app = new Hono<Env>();

  app.get("/threads", (c) => {
    const busy = new Set([...activeTurns().values()].map((t) => t.threadId));
    return c.json({ threads: listThreads({ userId: userId(c) }).map((t) => ({ ...t, busy: busy.has(t.id) })) });
  });

  app.get("/threads/:id", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "Couldn't find that conversation" }, 404);
    const bot = thread.botId ? getBot(thread.botId) : null;
    const turns = [...activeTurns().values()].filter((t) => t.threadId === thread.id);

    return c.json({ thread, bot, busy: turns.map((t) => t.botId), answering: turns.map((t) => t.messageId) });
  });

  app.get("/threads/:id/work", (c) => {
    const id = c.req.param("id");
    if (!ownsThread(c, id)) return c.json({ error: "Couldn't find that conversation" }, 404);
    return c.json({ work: workFor(id) });
  });

  app.get("/threads/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!ownsThread(c, id)) return c.json({ error: "Couldn't find that conversation" }, 404);
    const messages = listMessages(id, { after: c.req.query("after") ?? null, before: c.req.query("before") ?? null, limit: Number(c.req.query("limit")) || 200, includeSent: true });
    return c.json({ messages });
  });

  app.put("/threads/:id/messages/:messageId/reaction", async (c) => {
    const id = c.req.param("id");
    const message = ownsThread(c, id) ? getMessage(c.req.param("messageId")) : null;
    if (!message || message.threadId !== id) return c.json({ error: "Couldn't find that message" }, 404);
    if (message.kind !== "message" || ["you", "system", "routine"].includes(message.author)) return c.json({ error: "Only a bot's message takes a reaction" }, 400);
    const body = (await c.req.json().catch(() => null)) as { emoji?: unknown } | null;
    const emoji = body?.emoji ?? null;
    if (emoji !== null && !isReaction(emoji)) return c.json({ error: "Pick one of the reactions on offer" }, 400);
    return c.json({ reactions: setReaction(message, "you", emoji) });
  });

  // "Less like this" under something a bot noticed on its own: the bot hears it as a hidden prompt and tightens the watch.
  app.post("/threads/:id/messages/:messageId/less", async (c) => {
    const thread = ownThread(c, c.req.param("id"));
    const message = thread ? getMessage(c.req.param("messageId")) : null;
    if (!thread || !message || message.threadId !== thread.id) return c.json({ error: "Couldn't find that message" }, 404);
    if (message.kind !== "message" || !getBot(message.author)) return c.json({ error: "Only something a bot said takes this" }, 400);
    const body = (await c.req.json().catch(() => null)) as { watch?: unknown } | null;
    const watch = typeof body?.watch === "string" ? body.watch.replace(/["\r\n]/g, " ").trim().slice(0, 80) : "";
    const said = plainMarkdown(message.body).slice(0, 300);
    postMessage({
      threadId: thread.id,
      author: "system",
      kind: "prompt",
      body: `The person tapped "Less like this" on what you noticed${watch ? ` from your watch "${watch}"` : ""}: "${said}". It wasn't worth telling them. Tighten that watch with update_routine so this kind of thing doesn't come up again, then answer in one short line saying what you'll leave out from now on. This line is from Gond, not the person.`,
    });
    return c.body(null, 204);
  });

  app.get("/threads/:id/exchange", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    const other = ownThread(c, c.req.query("with") ?? "");
    if (!thread || !other) return c.json({ error: "Couldn't find that conversation" }, 404);
    return c.json({ thread, other, messages: listExchange(thread.id, other.id) });
  });

  app.post("/threads/:id/messages", async (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "Couldn't find that conversation" }, 404);
    let body = "";

    let after = false;
    let replyTo: string | null = null;
    const attachments: ChatAttachment[] = [];
    const type = c.req.header("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      body = String(form.get("body") ?? "");
      after = form.get("after") === "1";
      replyTo = typeof form.get("replyTo") === "string" ? String(form.get("replyTo")) : null;
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (files.length > MAX_ATTACHMENTS) return c.json({ error: `At most ${MAX_ATTACHMENTS} files per message` }, 400);
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: `${file.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }, 400);
        const mediaType = (ATTACHMENT_TYPES as readonly string[]).includes(file.type) ? file.type : file.type.startsWith("text/") ? "text/plain" : "";
        if (!mediaType) return c.json({ error: `${file.name}: images, PDFs and text files only` }, 400);
        attachments.push(storeAttachment({ name: file.name.slice(0, 200), mediaType, data: new Uint8Array(await file.arrayBuffer()) }));
      }
    } else {
      const json = (await c.req.json().catch(() => ({}))) as { body?: string; after?: boolean; replyTo?: unknown };
      body = String(json.body ?? "");
      after = json.after === true;
      replyTo = typeof json.replyTo === "string" ? json.replyTo : null;
    }
    const quoted = replyTo ? getMessage(replyTo) : null;
    if (replyTo && (quoted?.threadId !== thread.id || quoted.kind !== "message")) return c.json({ error: "That message isn't in this conversation" }, 400);
    body = body.trim();
    if (!body && attachments.length === 0) return c.json({ error: "Say something" }, 400);
    if (body.length > MAX_BODY) return c.json({ error: "That message is too long" }, 400);
    const message = await postFromPerson(thread, { body, attachments, after, replyTo });
    return c.json({ message }, 201);
  });

  app.post("/threads/:id/read", (c) => {
    if (!ownsThread(c, c.req.param("id"))) return c.json({ error: "Couldn't find that conversation" }, 404);
    markThreadRead(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/threads/:id/interrupt", async (c) => {
    if (!ownsThread(c, c.req.param("id"))) return c.json({ error: "Couldn't find that conversation" }, 404);
    const { stopped, dropped } = await stopThread(c.req.param("id"));
    return c.json({ ok: true, stopped, dropped });
  });

  app.post("/rooms", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; members?: string[] };
    const mine = listBots({ includeHidden: true, userId: userId(c) });
    const members = [...new Set(Array.isArray(body.members) ? body.members.map(String) : [])].filter((id) => mine.some((b) => b.id === id));
    if (members.length === 0) return c.json({ error: "Add at least one bot" }, 400);
    const name = (String(body.name ?? "").trim() || roomNameFor(mine.filter((b) => members.includes(b.id)))).slice(0, 80);
    const thread = createRoom(name, members, userId(c));
    const answerer = answererOf(members, listBots({ includeHidden: true, userId: userId(c) }));
    const who = members.length > 1 && answerer ? ` With nobody named, ${answerer} answers; mention a bot with @, or by name, to address it.` : "";
    postMessage({ threadId: thread.id, author: "system", kind: "event", body: `Room created with ${members.length} bot${members.length === 1 ? "" : "s"}.${who}`, answered: true });
    return c.json({ thread }, 201);
  });

  app.patch("/rooms/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; members?: unknown; pinned?: unknown };
    const before = ownThread(c, c.req.param("id"));
    if (!before || before.kind !== "room") return c.json({ error: "Couldn't find that room" }, 404);
    const bots = listBots({ includeHidden: true, userId: userId(c) });
    const known = new Set(bots.map((b) => b.id));
    const members = Array.isArray(body.members) ? [...new Set(body.members.map(String).filter((id) => known.has(id)))] : undefined;
    if (members && members.length === 0) return c.json({ error: "Keep at least one bot in the room" }, 400);
    const given = body.name === undefined ? undefined : String(body.name).trim().slice(0, 80);
    const name = given === "" ? roomNameFor(bots.filter((b) => (members ?? before.members).includes(b.id))).slice(0, 80) : given;
    if (body.pinned !== undefined && typeof body.pinned !== "boolean") return c.json({ error: "Pinned must be on or off" }, 400);
    const thread = updateRoom(before.id, { name, members, pinned: body.pinned as boolean | undefined });
    if (!thread) return c.json({ error: "Couldn't find that room" }, 404);
    const change = roomChange(before, thread, (id) => bots.find((b) => b.id === id)?.name ?? "A bot", thread.members.length > 1 ? [answererOf(before.members, bots), answererOf(thread.members, bots)] : [null, null]);
    if (change) postMessage({ threadId: thread.id, author: "system", kind: "event", body: change, answered: true });
    return c.json({ thread: getThread(thread.id) ?? thread });
  });

  app.delete("/rooms/:id", async (c) => {
    if (!ownsThread(c, c.req.param("id"))) return c.json({ error: "Couldn't find that room" }, 404);
    await stopThread(c.req.param("id"));
    return deleteRoom(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "Couldn't find that room" }, 404);
  });

  app.get("/attachments/:id", (c) => {
    const file = attachmentOwner(c.req.param("id")) === userId(c) ? getAttachment(c.req.param("id")) : null;
    if (!file) return c.json({ error: "Couldn't find that file" }, 404);

    // Only types that can't run script open in the tab; the rest (HTML, SVG, anything a bot made) download.
    const inline = c.req.query("download") === undefined && INLINE_TYPES.has(file.meta.mediaType);
    return new Response(Buffer.from(file.data), {
      headers: {
        "Content-Type": file.meta.mediaType || "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`,
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json({ messages: [] });
    return c.json({ messages: searchMessages(q, userId(c)) });
  });

  return app;
}
