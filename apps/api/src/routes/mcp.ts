import { mcpServerInputSchema } from "@gond/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { ownsThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { createMcpServer, deleteMcpServer, getMcpServer, listMcpServers, markMcpRefreshed, mcpProxyToken, mcpServerOwner, setMcpAuthStatus, updateMcpServer } from "../data/mcp.ts";
import { completeMcpLogin, completeMcpLoginFrom, mcpLoginHandBack, probeMcpServer, signOutMcp, startMcpLogin } from "../mcp-oauth.ts";
import { McpSession, forwardMcp } from "../mcp-client.ts";
import { resolveMcpIcon } from "../mcp-icon.ts";
import { timingSafeEqualString } from "../ids.ts";
import { completeChatGptLogin, completeChatGptLoginFrom, isChatGptState } from "../chatgpt.ts";

function validate(input: unknown) {
  const parsed = mcpServerInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Bad server" };
  const data = parsed.data;
  if (data.transport === "http" && !data.url) return { error: "An HTTP server needs a URL" };
  if (data.transport === "stdio" && !data.command) return { error: "A stdio server needs a command" };
  return { data };
}

function ownServer(c: Context<Env>, id: string) {
  return mcpServerOwner(id) === userId(c) ? getMcpServer(id) : null;
}

/** Ahead of the session check: a sign-in the desktop app started lands in a browser that may have none. */
export const mcpHandBack: MiddlewareHandler = async (c, next) => {
  const query = new URL(c.req.url).searchParams;
  const handBack = mcpLoginHandBack(query.get("state") ?? "", query);
  if (handBack) return c.redirect(handBack);
  await next();
};

export function mcpRoutes() {
  const app = new Hono<Env>();

  app.get("/mcp-servers", (c) => c.json({ servers: listMcpServers(userId(c)) }));

  app.post("/mcp-servers", async (c) => {
    const result = validate(await c.req.json().catch(() => ({})));
    if ("error" in result) return c.json({ error: result.error }, 400);
    try {
      const server = createMcpServer(result.data!, userId(c));

      if (server.transport === "http") void probeMcpServer(server.id).catch(() => undefined);
      return c.json({ server }, 201);
    } catch (error) {
      return c.json({ error: /UNIQUE/.test(String(error)) ? "A server with that name exists" : "Could not save the server" }, 400);
    }
  });

  app.patch("/mcp-servers/:id", async (c) => {
    const current = ownServer(c, c.req.param("id"));
    if (!current) return c.json({ error: "Couldn't find that server" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = validate({ ...current, ...body });
    if ("error" in result) return c.json({ error: result.error }, 400);
    const server = updateMcpServer(current.id, result.data!);
    const moved = server && (server.url !== current.url || (server.authStatus !== "signed_in" && JSON.stringify(server.headers) !== JSON.stringify(current.headers)));
    if (server?.transport === "http" && moved) void probeMcpServer(server.id).catch(() => undefined);
    return c.json({ server });
  });

  app.get("/mcp-servers/:id/icon", async (c) => {
    const server = ownServer(c, c.req.param("id"));
    if (!server) return c.json({ error: "Couldn't find that server" }, 404);
    const icon = await resolveMcpIcon(server);
    if (!icon) return c.body(null, 404, { "Cache-Control": "private, max-age=3600" });
    if (icon.kind === "redirect") return c.redirect(icon.url, 302);
    return new Response(icon.bytes, { status: 200, headers: { "Content-Type": icon.type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" } });
  });

  app.post("/mcp-servers/:id/probe", async (c) => {
    const server = ownServer(c, c.req.param("id"));
    if (!server) return c.json({ error: "Couldn't find that server" }, 404);
    return c.json({ result: await probeMcpServer(server.id), server: getMcpServer(server.id) });
  });

  app.post("/mcp-servers/:id/refresh", async (c) => {
    const server = ownServer(c, c.req.param("id"));
    if (!server) return c.json({ error: "Couldn't find that server" }, 404);
    markMcpRefreshed(server.id);
    if (server.transport !== "http") return c.json({ server: getMcpServer(server.id), tools: null });
    // A probe goes without the sign-in's token, so a signed-in server would read as signed out.
    if (server.authStatus !== "signed_in") {
      const probe = await probeMcpServer(server.id);
      if (probe.status !== "none") return c.json({ server: getMcpServer(server.id), tools: null, ...(probe.status === "error" ? { error: getMcpServer(server.id)?.authError ?? "The server didn't answer." } : {}) });
    }
    const session = new McpSession(getMcpServer(server.id)!);
    try {
      const signal = AbortSignal.timeout(15_000);
      await session.open(signal);
      const tools = await session.listTools(signal);
      return c.json({ server: getMcpServer(server.id), tools: tools.length });
    } catch (error) {
      return c.json({ server: getMcpServer(server.id), tools: null, error: error instanceof Error ? error.message : "The server didn't answer." });
    }
  });

  app.post("/mcp-servers/:id/login", async (c) => {
    const server = ownServer(c, c.req.param("id"));
    if (!server) return c.json({ error: "Couldn't find that server" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { threadId?: unknown; app?: unknown };
    const threadId = typeof body.threadId === "string" && ownsThread(c, body.threadId) ? body.threadId : undefined;
    try {
      return c.json({ url: await startMcpLogin(server.id, { threadId, app: body.app === "desktop" ? "desktop" : undefined }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the sign-in";
      setMcpAuthStatus(server.id, "error", message);
      return c.json({ error: message }, 502);
    }
  });

  // A ChatGPT sign-in returns to the same loopback as an MCP one, so the shells hand it back here too.
  app.get("/mcp-servers/oauth/callback", async (c) => {
    if (isChatGptState(c.req.query("state"))) {
      const done = await completeChatGptLogin({ code: c.req.query("code"), state: c.req.query("state"), error: c.req.query("error"), errorDescription: c.req.query("error_description"), clientId: c.req.query("client_id") }, userId(c));
      return c.redirect(`/app/settings/ai?${done.ok ? "chatgpt=1" : `chatgpt_error=${encodeURIComponent(done.reason ?? "")}`}`);
    }
    const result = await completeMcpLogin({ code: c.req.query("code"), state: c.req.query("state"), error: c.req.query("error"), errorDescription: c.req.query("error_description") }, userId(c));
    if (result.threadId) return c.redirect(`/app/t/${result.threadId}`);
    return c.redirect(`/app/settings/apps?${result.ok ? `mcp=${encodeURIComponent(result.name ?? "")}` : `mcp_error=${encodeURIComponent(result.reason ?? "")}`}`);
  });

  app.post("/mcp-servers/oauth/complete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 8000) return c.json({ error: "Paste the address the sign-in ended on." }, 400);
    const state = URL.canParse(body.url.trim()) ? new URL(body.url.trim()).searchParams.get("state") : null;
    if (isChatGptState(state)) {
      const done = await completeChatGptLoginFrom(body.url, userId(c));
      return done.ok ? c.json({ name: "ChatGPT", threadId: null }) : c.json({ error: done.reason }, 400);
    }
    const result = await completeMcpLoginFrom(body.url, userId(c));
    return result.ok ? c.json({ name: result.name, threadId: result.threadId }) : c.json({ error: result.reason }, 400);
  });

  app.delete("/mcp-servers/:id/login", (c) => {
    const server = ownServer(c, c.req.param("id"));
    if (!server) return c.json({ error: "Couldn't find that server" }, 404);
    signOutMcp(server.id);
    return c.json({ server: getMcpServer(server.id) });
  });

  app.delete("/mcp-servers/:id", (c) => {
    const ok = Boolean(ownServer(c, c.req.param("id"))) && deleteMcpServer(c.req.param("id"));
    return ok ? c.body(null, 204) : c.json({ error: "Couldn't find that server" }, 404);
  });

  return app;
}

export function mcpProxyRoutes() {
  const app = new Hono();
  const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "x-gond-mcp-token", "x-gond-mcp-auth", "cookie"]);

  app.all("/mcp/:id/*", async (c) => {
    const server = getMcpServer(c.req.param("id"));
    if (!server || server.transport !== "http" || !server.url) return c.json({ error: "Couldn't find that MCP server" }, 404);
    const token = c.req.header("x-gond-mcp-token") ?? "";
    const expected = mcpProxyToken(server.id) ?? "";
    // Never a 401 to the session: Claude Code reads one as an OAuth sign-in it should run itself.
    if (!expected || token.length !== expected.length || !timingSafeEqualString(token, expected)) return c.json({ error: "That token isn't valid for this server" }, 403);
    if (!server.enabled) return c.json({ error: "This MCP server is turned off" }, 503);

    const suffix = c.req.path.replace(/^\/api\/mcp\/[^/]+(\/mcp)?\/?/, "");
    const headers = new Headers();
    for (const [key, value] of c.req.raw.headers) if (!HOP.has(key.toLowerCase())) headers.set(key, value);
    const upstream = await forwardMcp(server, { method: c.req.method, suffix, search: new URL(c.req.url).search, headers, body: c.req.raw.body, signal: c.req.raw.signal });
    const out = new Headers();
    for (const [key, value] of upstream.headers) if (!HOP.has(key.toLowerCase()) && key.toLowerCase() !== "set-cookie") out.set(key, value);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  return app;
}
