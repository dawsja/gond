import { CLI_ENGINES, type CliEngine } from "@gond/shared";
import { Hono, type Context } from "hono";
import type { Env } from "../app.ts";
import {
  BoxError,
  boxConfig,
  cancelEngineSignIn,
  closeTerminal,
  connectDesktop,
  createTerminal,
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
  terminalInput,
  terminalResize,
  writeBoxFile,
  type BoxConfig,
} from "../box.ts";
import { ownBot, userId } from "../access.ts";
import { desktopState, emitDesktop, tookControl } from "../desktop.ts";
import { containsSecret, hideSecrets } from "../data/secrets.ts";
import { pictureType } from "../images.ts";
import { botHome } from "../memory.ts";
import { watchEngineSignIn } from "../status.ts";
import { stopAll, tellHandedBack } from "../responder.ts";
import { isUpdating, startReset, startUpdate, updateReport } from "../updater.ts";

const STREAM_ID = /^[a-f0-9]{16}$/;

function requireBox(c: Context<Env>): BoxConfig | Response {
  try {
    const config = boxConfig(userId(c));
    if (config) return config;
  } catch (error) {
    return c.json({ error: (error as Error).message }, 503);
  }
  return c.json({ error: "No box is configured. Set GOND_BOX_URL." }, 404);
}

function boxErrorResponse(c: Context<Env>, error: unknown) {
  if (error instanceof BoxError) return c.json({ error: error.message }, (error.status || 503) as 503);
  return c.json({ error: error instanceof Error ? error.message : "Box request failed" }, 502);
}

async function proxyStream(c: Context<Env>, box: BoxConfig, route: string) {
  try {
    const upstream = await openBoxStream(box, route, c.req.raw.signal);
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    return boxErrorResponse(c, error);
  }
}

function botFilePath(botId: string, relative: string): string | null {
  const clean = relative.replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === "..")) return null;
  return `${botHome(botId)}/${clean}`;
}

export function boxRoutes() {
  const app = new Hono<Env>();

  app.get("/box/update", (c) => c.json(updateReport()));

  app.post("/box/update", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    if (isUpdating()) return c.json({ error: "An update is already running" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { pull?: boolean };
    return c.json({ ...updateReport(), update: startUpdate({ pull: body.pull !== false }) });
  });

  app.post("/box/reset", (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    if (isUpdating()) return c.json({ error: "An update is already running" }, 409);
    return c.json({ ...updateReport(), update: startReset() });
  });

  // Anyone's, for their own account only: the bots stop first so nothing is mid-turn in a home being emptied.
  app.post("/box/home/reset", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    if (isUpdating()) return c.json({ error: "The computer is updating. Try again when it's done." }, 409);
    const person = userId(c);
    await stopAll(person).catch(() => undefined);
    try {
      const result = await resetBoxHome(box);
      void emitDesktop(person);
      return c.json(result);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/terminals", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { bot?: string; cols?: number; rows?: number };
    if (body.bot && !ownBot(c, body.bot)) return c.json({ error: "No such bot" }, 404);
    try {
      return c.json({ terminal: await createTerminal(box, { bot: body.bot ?? null, cols: Number(body.cols) || 80, rows: Number(body.rows) || 24 }) });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.get("/box/terminals/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    return proxyStream(c, box, `/terminals/${id}/stream`);
  });

  app.post("/box/terminals/:id/input", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { data?: string };
    if (typeof body.data !== "string") return c.json({ error: "Missing data" }, 400);
    try {
      await terminalInput(box, id, body.data);
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/terminals/:id/resize", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { cols?: number; rows?: number };
    try {
      await terminalResize(box, id, { cols: Number(body.cols) || 80, rows: Number(body.rows) || 24 });
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/box/terminals/:id", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await closeTerminal(box, id);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  function engineParam(c: Context<Env>): CliEngine | null {
    const engine = c.req.param("engine") ?? "";
    return (CLI_ENGINES as readonly string[]).includes(engine) ? (engine as CliEngine) : null;
  }

  app.get("/box/engines/:engine/sign-in", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      return c.json(await engineSignIn(box, engine));
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/engines/:engine/sign-in", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      const started = await startEngineSignIn(box, engine);

      watchEngineSignIn(box, userId(c), engine);
      return c.json(started);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/engines/:engine/sign-in/code", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^[\x21-\x7e]{4,512}$/.test(code)) return c.json({ error: "That doesn't look like the code from the sign-in page" }, 400);
    try {
      return c.json(await engineSignInCode(box, engine, code));
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/box/engines/:engine/sign-in", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await cancelEngineSignIn(box, engine);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.get("/box/desktop", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      return c.json({ desktop: await desktopState(userId(c)) });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  // Every bot has a screen of its own; each route names it, and answers 404 for anyone else's bot.
  const screenSize = (body: { width?: unknown; height?: unknown }) => ({ width: Number(body.width) || 1280, height: Number(body.height) || 800 });

  app.post("/box/desktop/:bot", async (c) => {
    const bot = ownBot(c, c.req.param("bot"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { width?: number; height?: number };
    try {
      await startDesktop(box, bot.id, { ...screenSize(body), primary: bot.primary });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
    const desktop = await desktopState(userId(c)).catch(() => null);
    void emitDesktop(userId(c));
    return c.json({ desktop });
  });

  app.delete("/box/desktop/:bot", async (c) => {
    const bot = ownBot(c, c.req.param("bot"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await stopDesktop(box, bot.id);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
    void emitDesktop(userId(c));
    return c.body(null, 204);
  });

  app.post("/box/desktop/:bot/control", async (c) => {
    const bot = ownBot(c, c.req.param("bot"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { holder?: unknown };
    if (body.holder !== "person" && body.holder !== "free") return c.json({ error: "holder must be person or free" }, 400);
    try {
      await desktopControl(box, bot.id, { holder: body.holder });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
    if (body.holder === "person") tookControl(userId(c), bot.id);
    else void tellHandedBack(userId(c), bot.id);
    const desktop = await desktopState(userId(c)).catch(() => null);
    void emitDesktop(userId(c));
    return c.json({ desktop });
  });

  app.post("/box/desktop/:bot/connections", async (c) => {
    const bot = ownBot(c, c.req.param("bot"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { width?: number; height?: number };
    try {
      const connection = await connectDesktop(box, bot.id, { ...screenSize(body), primary: bot.primary });
      void emitDesktop(userId(c));
      return c.json({ connection });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.get("/box/desktop/:bot/connections/:id/stream", (c) => {
    const bot = ownBot(c, c.req.param("bot"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad connection id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    return proxyStream(c, box, screenStreamPath(bot.id, id));
  });

  app.post("/box/desktop/:bot/connections/:id/input", async (c) => {
    const bot = ownBot(c, c.req.param("bot"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad connection id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { data?: string };
    if (typeof body.data !== "string") return c.json({ error: "Missing data" }, 400);
    try {
      await desktopInput(box, bot.id, id, body.data);
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/box/desktop/:bot/connections/:id", async (c) => {
    const bot = ownBot(c, c.req.param("bot"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad connection id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await disconnectDesktop(box, bot.id, id);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.get("/bots/:id/files", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const target = botFilePath(bot.id, c.req.query("path") ?? ".");
    if (!target) return c.json({ error: "Bad path" }, 400);
    try {
      const file = await readBoxFile(box, target);
      return c.json({ file: file.content === undefined ? file : { ...file, content: hideSecrets(file.content) } });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.get("/bots/:id/files/raw", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const target = botFilePath(bot.id, c.req.query("path") ?? "");
    if (!target) return c.json({ error: "Bad path" }, 400);
    try {
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
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.put("/bots/:id/files", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; content?: string };
    const target = botFilePath(bot.id, String(body.path ?? ""));
    if (!target || typeof body.content !== "string") return c.json({ error: "Bad path or content" }, 400);
    try {
      await writeBoxFile(box, target, body.content);
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/bots/:id/files", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const target = botFilePath(bot.id, c.req.query("path") ?? "");
    if (!target || target === botHome(bot.id) + "/") return c.json({ error: "Bad path" }, 400);
    try {
      await deleteBoxFile(box, target);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  return app;
}
