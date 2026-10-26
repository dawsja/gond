import { Hono, type Context } from "hono";
import { ownBot, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { recordingFrame, boxConfig } from "../box.ts";
import { getTeaching, openTeaching, teachingFrame } from "../data/teachings.ts";
import { addNote, discardTeaching, editDraft, finishTeaching, lookAfterReview, pauseTeaching, reviseTeaching, saveTeaching, skipStep, startTeaching, TeachError, tryTeaching } from "../teach.ts";

const IMAGE_HEADERS = {
  "Content-Type": "image/jpeg",
  "Content-Security-Policy": "sandbox",
  "Cache-Control": "private, max-age=3600",
  "X-Content-Type-Options": "nosniff",
};

/** "Show me how": starting, pausing and ending a recording, and what happens to the bot's draft of it. */
export function teachingsRoutes() {
  const app = new Hono<Env>();

  const failed = (c: Context<Env>, error: unknown) => {
    if (error instanceof TeachError) return c.json({ error: error.message }, error.status as 400);
    console.error("[gond] show me how failed:", error);
    return c.json({ error: "Something went wrong. Try again in a moment." }, 500);
  };
  const body = async (c: Context<Env>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  app.get("/teachings/open", (c) => c.json({ teaching: openTeaching(userId(c)) }));

  app.get("/teachings/:id", (c) => {
    const teaching = getTeaching(c.req.param("id"), userId(c));
    return teaching ? c.json({ teaching }) : c.json({ error: "Couldn't find that recording" }, 404);
  });

  // From a bot's screen: starts at once, and the card goes in the bot's own chat.
  app.post("/teachings", async (c) => {
    const { botId } = await body(c);
    if (typeof botId !== "string" || !ownBot(c, botId)) return c.json({ error: "Couldn't find that bot" }, 404);
    try {
      return c.json({ teaching: await startTeaching(userId(c), { botId }) });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/teachings/:id/start", async (c) => {
    try {
      return c.json({ teaching: await startTeaching(userId(c), { teachingId: c.req.param("id") }) });
    } catch (error) {
      return failed(c, error);
    }
  });

  for (const action of ["pause", "resume"] as const) {
    app.post(`/teachings/:id/${action}`, async (c) => {
      try {
        return c.json({ teaching: await pauseTeaching(userId(c), c.req.param("id"), action === "pause") });
      } catch (error) {
        return failed(c, error);
      }
    });
  }

  app.post("/teachings/:id/done", async (c) => {
    const id = c.req.param("id");
    const teaching = getTeaching(id, userId(c));
    if (!teaching) return c.json({ error: "Couldn't find that recording" }, 404);
    if (teaching.status !== "recording" && teaching.status !== "paused") return c.json({ teaching });
    await finishTeaching(id, "done");
    return c.json({ teaching: getTeaching(id, userId(c)) });
  });

  app.post("/teachings/:id/discard", async (c) => {
    const id = c.req.param("id");
    if (!getTeaching(id, userId(c))) return c.json({ error: "Couldn't find that recording" }, 404);
    await discardTeaching(id);
    return c.json({ teaching: getTeaching(id, userId(c)) });
  });

  app.post("/teachings/:id/notes", async (c) => {
    const { text } = await body(c);
    try {
      return c.json({ teaching: addNote(userId(c), c.req.param("id"), typeof text === "string" ? text : "") });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.patch("/teachings/:id/steps/:n", async (c) => {
    const { skipped } = await body(c);
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1 || typeof skipped !== "boolean") return c.json({ error: "Pick a step to skip or keep" }, 400);
    try {
      return c.json({ teaching: skipStep(userId(c), c.req.param("id"), n, skipped) });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/teachings/:id/look", async (c) => {
    const { hidden } = await body(c);
    const list = Array.isArray(hidden) ? hidden.filter((n): n is number => Number.isInteger(n)) : [];
    try {
      return c.json({ teaching: lookAfterReview(userId(c), c.req.param("id"), list) });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/teachings/:id/try", (c) => {
    try {
      return c.json({ teaching: tryTeaching(userId(c), c.req.param("id")) });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/teachings/:id/save", async (c) => {
    try {
      return c.json({ teaching: await saveTeaching(userId(c), c.req.param("id")) });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/teachings/:id/revise", async (c) => {
    const { note } = await body(c);
    try {
      return c.json({ teaching: reviseTeaching(userId(c), c.req.param("id"), typeof note === "string" ? note : "") });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.put("/teachings/:id/draft", async (c) => {
    try {
      return c.json({ teaching: editDraft(userId(c), c.req.param("id"), await body(c)) });
    } catch (error) {
      return failed(c, error);
    }
  });

  // A recording's screenshots: Gond's own copy once it ended, the computer's while it records.
  app.get("/teachings/:id/frames/:n", async (c) => {
    const me = userId(c);
    const teaching = getTeaching(c.req.param("id"), me);
    const n = Number(c.req.param("n"));
    if (!teaching || !Number.isInteger(n) || n < 1) return c.json({ error: "Couldn't find that picture" }, 404);
    const kept = teachingFrame(teaching.id, n);
    if (kept) return new Response(Buffer.from(kept.data), { headers: { ...IMAGE_HEADERS, "Content-Length": String(kept.data.byteLength) } });
    const box = boxConfig(me);
    if (!box || (teaching.status !== "recording" && teaching.status !== "paused")) return c.json({ error: "Couldn't find that picture" }, 404);
    const live = await recordingFrame(box, teaching.botId, teaching.id, n).catch(() => null);
    if (!live) return c.json({ error: "Couldn't find that picture" }, 404);
    return new Response(Buffer.from(live), { headers: { ...IMAGE_HEADERS, "Cache-Control": "private, no-store", "Content-Length": String(live.byteLength) } });
  });

  return app;
}
