import type { ComposioKeyStatus } from "@gond/shared";
import { Hono } from "hono";
import { ownsThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { appUrl } from "../config.ts";
import { applyComposioKey, catalogEntry, composioKey, composioKeySource, disconnect, forgetComposioCache, refreshConnection, startConnection } from "../composio.ts";
import { clearComposioKey } from "../data/composio-keys.ts";
import { listConnections, removeConnections } from "../data/settings.ts";

function keyChanged(me: string, before: string | null) {
  if (composioKey(me) === before) return;
  removeConnections(me);
  forgetComposioCache(me);
}

export function connectionsRoutes() {
  const app = new Hono<Env>();

  app.get("/connections", (c) => c.json({ configured: composioKeySource(userId(c)) !== null, connections: listConnections(userId(c)) }));

  app.get("/composio", (c) => c.json({ source: composioKeySource(userId(c)) } satisfies ComposioKeyStatus));

  app.put("/composio", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: unknown };
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) return c.json({ error: "Paste your Composio API key" }, 400);
    const me = userId(c);
    try {
      applyComposioKey(me, body.apiKey);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save the key" }, 400);
    }
    return c.json({ source: composioKeySource(me) } satisfies ComposioKeyStatus);
  });

  app.delete("/composio", (c) => {
    const me = userId(c);
    const before = composioKey(me);
    if (!clearComposioKey(me)) return c.json({ error: "There's no Composio key saved" }, 404);
    keyChanged(me, before);
    return c.json({ source: composioKeySource(me) } satisfies ComposioKeyStatus);
  });

  app.post("/connections/:toolkit/connect", async (c) => {
    const toolkit = c.req.param("toolkit").toLowerCase();
    if (!(await catalogEntry(userId(c), toolkit))) return c.json({ error: "That app isn't in the catalog" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: unknown };
    const thread = typeof body.threadId === "string" && ownsThread(c, body.threadId) ? body.threadId : null;
    try {
      return c.json(await startConnection(userId(c), toolkit, thread));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not start the connection" }, 502);
    }
  });

  app.post("/connections/:toolkit/refresh", async (c) => {
    const connection = await refreshConnection(userId(c), c.req.param("toolkit").toLowerCase());
    return connection ? c.json({ connection }) : c.json({ error: "That app isn't connected" }, 404);
  });

  app.get("/connections/callback", async (c) => {
    const toolkit = (c.req.query("toolkit") ?? "").toLowerCase();
    if (toolkit) await refreshConnection(userId(c), toolkit);
    const thread = c.req.query("thread") ?? "";
    const where = thread && ownsThread(c, thread) ? `/app/t/${thread}` : "/app/settings/apps";
    return c.redirect(`${appUrl()}${where}?connected=${encodeURIComponent(toolkit)}`);
  });

  app.delete("/connections/:toolkit", async (c) => ((await disconnect(userId(c), c.req.param("toolkit").toLowerCase())) ? c.body(null, 204) : c.json({ error: "That app isn't connected" }, 404)));

  return app;
}
