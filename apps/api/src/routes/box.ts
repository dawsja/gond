import { CLI_ENGINES, type Bot, type CliEngine } from "@gond/shared";
import { Hono, type Context } from "hono";
import type { Env } from "../app.ts";
import {
  BoxError,
  boxConfig,
  cancelEngineSignIn,
  connectDesktop,
  deleteBoxFile,
  desktopControl,
  desktopInput,
  disconnectDesktop,
  engineSignIn,
  engineSignInCode,
  openBoxStream,
  readBoxFile,
  readBoxFileBytes,
  resetBoxHome,
  screenStreamPath,
  startDesktop,
  startEngineSignIn,
  stopDesktop,
  writeBoxFile,
  type BoxConfig,
} from "../box.ts";
import { ownBot, userId } from "../access.ts";
import { desktopState, emitDesktop, tookControl } from "../desktop.ts";
import { containsSecret, hideSecrets } from "../data/secrets.ts";
import { pictureType } from "../images.ts";
import { botHome } from "../memory.ts";
import { watchEngineSignIn } from "../status.ts";
import { forgetSouls, stopAll, tellHandedBack } from "../responder.ts";
import { isUpdating, startReset, startUpdate, updateReport } from "../updater.ts";
import { readBody } from "./body.ts";

const STREAM_ID = /^[a-f0-9]{16}$/;

function requireBox(c: Context<Env>): BoxConfig | Response {
  try {
    const config = boxConfig(userId(c));
    if (config) return config;
  } catch (error) {
    return c.json({ error: (error as Error).message }, 503);
  }
  return c.json({ error: "The computer isn't set up. Set GOND_BOX_URL on the API." }, 404);
}

function boxErrorResponse(c: Context<Env>, error: unknown) {
  if (error instanceof BoxError) return c.json({ error: error.message }, (error.status || 503) as 503);
  return c.json({ error: error instanceof Error ? error.message : "Box request failed" }, 502);
}

type Answer = Response | Promise<Response>;

/** A route that needs the person's computer: it answers for a missing one, and passes on what the box refused. */
function withBox(run: (c: Context<Env>, box: BoxConfig) => Answer) {
  return async (c: Context<Env>) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      return await run(c, box);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  };
}

/** A route about one of the person's own bots, named by `param`; anyone else's is a 404 before the computer is asked. */
function withBot(param: "bot" | "id", run: (c: Context<Env>, box: BoxConfig, bot: Bot) => Answer) {
  return async (c: Context<Env>) => {
    const bot = ownBot(c, c.req.param(param) ?? "");
    if (!bot) return c.json({ error: "Couldn't find that bot" }, 404);
    return withBox((c, box) => run(c, box, bot))(c);
  };
}

function engineParam(c: Context<Env>): CliEngine | null {
  const engine = c.req.param("engine") ?? "";
  return (CLI_ENGINES as readonly string[]).includes(engine) ? (engine as CliEngine) : null;
}

function withEngine(run: (c: Context<Env>, box: BoxConfig, engine: CliEngine) => Answer) {
  return async (c: Context<Env>) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "Couldn't find that engine" }, 404);
    return withBox((c, box) => run(c, box, engine))(c);
  };
}

/** A screen connection's id from the path, or the 400 to answer. */
function connectionOf(c: Context<Env>): string | Response {
  const id = c.req.param("id") ?? "";
  return STREAM_ID.test(id) ? id : c.json({ error: "That screen connection isn't valid" }, 400);
}

async function proxyStream(c: Context<Env>, box: BoxConfig, route: string) {
  const upstream = await openBoxStream(box, route, c.req.raw.signal);
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

function botFilePath(botId: string, relative: string): string | null {
  const clean = relative.replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === "..")) return null;
  return `${botHome(botId)}/${clean}`;
}

// Every bot has a screen of its own; each route names it, and answers 404 for anyone else's bot.
const screenSize = (body: { width?: unknown; height?: unknown }) => ({ width: Number(body.width) || 1280, height: Number(body.height) || 800 });

export function boxRoutes() {
  const app = new Hono<Env>();

  app.get("/box/update", (c) => c.json(updateReport()));

  app.post(
    "/box/update",
    withBox(async (c) => {
      if (isUpdating()) return c.json({ error: "An update is already running" }, 409);
      const body = await readBody(c);
      return c.json({ ...updateReport(), update: startUpdate({ pull: body.pull !== false }) });
    }),
  );

  app.post(
    "/box/reset",
    withBox((c) => {
      if (isUpdating()) return c.json({ error: "An update is already running" }, 409);
      return c.json({ ...updateReport(), update: startReset() });
    }),
  );

  // Anyone's, for their own account only: the bots stop first so nothing is mid-turn in a home being emptied.
  app.post(
    "/box/home/reset",
    withBox(async (c, box) => {
      if (isUpdating()) return c.json({ error: "The computer is updating. Try again when it's done." }, 409);
      const person = userId(c);
      await stopAll(person).catch(() => undefined);
      const result = await resetBoxHome(box);
      forgetSouls();
      void emitDesktop(person);
      return c.json(result);
    }),
  );

  app.get(
    "/box/engines/:engine/sign-in",
    withEngine(async (c, box, engine) => c.json(await engineSignIn(box, engine))),
  );

  app.post(
    "/box/engines/:engine/sign-in",
    withEngine(async (c, box, engine) => {
      const started = await startEngineSignIn(box, engine);
      watchEngineSignIn(box, userId(c), engine);
      return c.json(started);
    }),
  );

  app.post(
    "/box/engines/:engine/sign-in/code",
    withEngine(async (c, box, engine) => {
      const body = await readBody(c);
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!/^[\x21-\x7e]{4,512}$/.test(code)) return c.json({ error: "That doesn't look like the code from the sign-in page" }, 400);
      return c.json(await engineSignInCode(box, engine, code));
    }),
  );

  app.delete(
    "/box/engines/:engine/sign-in",
    withEngine(async (c, box, engine) => {
      await cancelEngineSignIn(box, engine);
      return c.body(null, 204);
    }),
  );

  app.get(
    "/box/desktop",
    withBox(async (c) => c.json({ desktop: await desktopState(userId(c)) })),
  );

  app.post(
    "/box/desktop/:bot",
    withBot("bot", async (c, box, bot) => {
      const body = await readBody(c);
      await startDesktop(box, bot.id, { ...screenSize(body), primary: bot.primary, name: bot.name, color: bot.color });
      const desktop = await desktopState(userId(c)).catch(() => null);
      void emitDesktop(userId(c));
      return c.json({ desktop });
    }),
  );

  app.delete(
    "/box/desktop/:bot",
    withBot("bot", async (c, box, bot) => {
      await stopDesktop(box, bot.id);
      void emitDesktop(userId(c));
      return c.body(null, 204);
    }),
  );

  app.post(
    "/box/desktop/:bot/control",
    withBot("bot", async (c, box, bot) => {
      const body = await readBody(c);
      if (body.holder !== "person" && body.holder !== "free") return c.json({ error: "Take control or give it back" }, 400);
      await desktopControl(box, bot.id, { holder: body.holder });
      if (body.holder === "person") tookControl(userId(c), bot.id);
      else void tellHandedBack(userId(c), bot.id);
      const desktop = await desktopState(userId(c)).catch(() => null);
      void emitDesktop(userId(c));
      return c.json({ desktop });
    }),
  );

  app.post(
    "/box/desktop/:bot/connections",
    withBot("bot", async (c, box, bot) => {
      const body = await readBody(c);
      const connection = await connectDesktop(box, bot.id, { ...screenSize(body), primary: bot.primary, name: bot.name, color: bot.color });
      void emitDesktop(userId(c));
      return c.json({ connection });
    }),
  );

  app.get(
    "/box/desktop/:bot/connections/:id/stream",
    withBot("bot", (c, box, bot) => {
      const id = connectionOf(c);
      return id instanceof Response ? id : proxyStream(c, box, screenStreamPath(bot.id, id));
    }),
  );

  app.post(
    "/box/desktop/:bot/connections/:id/input",
    withBot("bot", async (c, box, bot) => {
      const id = connectionOf(c);
      if (id instanceof Response) return id;
      const body = await readBody(c);
      if (typeof body.data !== "string") return c.json({ error: "Nothing was sent" }, 400);
      await desktopInput(box, bot.id, id, body.data);
      return c.json({ ok: true });
    }),
  );

  app.delete(
    "/box/desktop/:bot/connections/:id",
    withBot("bot", async (c, box, bot) => {
      const id = connectionOf(c);
      if (id instanceof Response) return id;
      await disconnectDesktop(box, bot.id, id);
      return c.body(null, 204);
    }),
  );

  app.get(
    "/bots/:id/files",
    withBot("id", async (c, box, bot) => {
      const target = botFilePath(bot.id, c.req.query("path") ?? ".");
      if (!target) return c.json({ error: "Give a path inside the bot's folder" }, 400);
      const file = await readBoxFile(box, target);
      return c.json({ file: file.content === undefined ? file : { ...file, content: hideSecrets(file.content) } });
    }),
  );

  app.get(
    "/bots/:id/files/raw",
    withBot("id", async (c, box, bot) => {
      const target = botFilePath(bot.id, c.req.query("path") ?? "");
      if (!target) return c.json({ error: "Give a path inside the bot's folder" }, 400);
      const data = await readBoxFileBytes(box, target);
      if (containsSecret(data)) return c.json({ error: "That file holds a stored secret, so it can't be downloaded" }, 403);
      const name = target.split("/").pop() || "file";
      // Only bytes that really are a picture show in the page; anything else, SVG included, is a download under a sandbox.
      const picture = c.req.query("view") === "1" ? pictureType(data) : null;
      return new Response(Buffer.from(data), {
        headers: {
          "Content-Type": picture ?? "application/octet-stream",
          "Content-Disposition": `${picture ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Content-Security-Policy": "sandbox",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }),
  );

  app.put(
    "/bots/:id/files",
    withBot("id", async (c, box, bot) => {
      const body = await readBody(c);
      const target = botFilePath(bot.id, String(body.path ?? ""));
      if (!target || typeof body.content !== "string") return c.json({ error: "Give a path inside the bot's folder and text to write" }, 400);
      await writeBoxFile(box, target, body.content);
      return c.json({ ok: true });
    }),
  );

  app.delete(
    "/bots/:id/files",
    withBot("id", async (c, box, bot) => {
      const target = botFilePath(bot.id, c.req.query("path") ?? "");
      if (!target || target === botHome(bot.id) + "/") return c.json({ error: "Give a path inside the bot's folder" }, 400);
      await deleteBoxFile(box, target);
      return c.body(null, 204);
    }),
  );

  return app;
}
