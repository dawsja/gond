import { hasKeyHeader, type Bot, type McpServer, type Thread } from "@gond/shared";
import { askApproval, expiredText, setAsideText } from "./approvals.ts";
import { mcpServerOwner } from "./data/mcp.ts";
import { injectSecrets } from "./data/secrets.ts";
import type { DriverTool, ToolPart, ToolResult } from "./driver.ts";
import { mcpServersFor } from "./mcp.ts";
import { bearerFor, probeMcpServer } from "./mcp-oauth.ts";
import { proxiedUrl } from "./providers.ts";
import { sseStream } from "./sse.ts";

const PROTOCOL_VERSION = "2025-06-18";
const OPEN_TIMEOUT_MS = 6_000;
const LIST_CACHE_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_RESULT = 24_000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// A session opening with a server that doesn't answer waits on it before its first word (Claude Code gives
// each server 30 s at start), so an opening `initialize` gets a short wait, and a server that missed it is
// answered "not now" at once for a minute rather than waited on by every session and turn in that time.
const OPENING = /"method"\s*:\s*"initialize"/;
const OPENING_WAIT_MS = 8_000;
const UNANSWERED_FOR_MS = 60_000;
const unanswered = new Map<string, number>();

type Forward = { method: string; suffix: string; search: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal };

/**
 * One request to an HTTP MCP server with what Gond adds on the way: the
 * owner's secrets in its headers and the sign-in's token. Shared by the
 * proxy a CLI session calls and the `api` engine's own client. A sign-in it
 * needs is a 424, never a 401: Claude Code reads a 401 as an OAuth it should
 * run itself.
 */
export async function forwardMcp(server: McpServer, request: Forward): Promise<Response> {
  const target = request.suffix ? proxiedUrl(server.url ?? "", request.suffix, request.search) : new URL(server.url ?? "");
  if (!target) return Response.json({ error: "That path isn't under the MCP server's address" }, { status: 400 });
  if (!request.suffix) target.search = request.search;
  const headers = request.headers;
  const missing: string[] = [];
  const owner = mcpServerOwner(server.id) ?? "";
  for (const [key, value] of Object.entries(server.headers)) headers.set(key, injectSecrets(value, owner, (name) => missing.push(name)));
  if (missing.length) return Response.json({ error: `Secret${missing.length > 1 ? "s" : ""} not set: ${missing.join(", ")}. Add ${missing.length > 1 ? "them" : "it"} under Settings → Secrets.` }, { status: 424 });

  if (server.authStatus === "signed_in") {
    const bearer = await bearerFor(server.id);
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  } else if (server.authStatus === "needed") {
    return Response.json({ error: `${server.name} needs the person to sign in first: Settings → Apps → MCP servers → ${server.name} → Sign in.` }, { status: 424 });
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body != null;
  // JSON-RPC bodies are small; read whole so an opening `initialize` can be told apart.
  const body = hasBody ? await new Response(request.body).text() : undefined;
  const opening = body !== undefined && OPENING.test(body);
  if (opening && (unanswered.get(server.id) ?? 0) > Date.now()) {
    return Response.json({ error: `${server.name} isn't answering right now; Gond tries it again in a minute.` }, { status: 503 });
  }
  const gaveUp = new AbortController();
  const timer = opening ? setTimeout(() => gaveUp.abort(), OPENING_WAIT_MS) : null;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: request.method, headers, body, redirect: "manual", signal: request.signal ? AbortSignal.any([request.signal, gaveUp.signal]) : gaveUp.signal });
  } catch (error) {
    if (opening) unanswered.set(server.id, Date.now() + UNANSWERED_FOR_MS);
    if (gaveUp.signal.aborted) return Response.json({ error: `${server.name} didn't answer within ${OPENING_WAIT_MS / 1000} seconds.` }, { status: 504 });
    return Response.json({ error: `The MCP server didn't answer: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 502 });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (opening) unanswered.delete(server.id);
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    void probeMcpServer(server.id).catch(() => undefined);
    if (hasKeyHeader(server.headers)) return Response.json({ error: `${server.name} turned down the key in its headers. Tell the person; once they forget the old one under Settings → Secrets, ask for it again with request_secret.` }, { status: 424 });
    return Response.json({ error: `${server.name} needs the person to sign in: Settings → Apps → MCP servers → ${server.name} → Sign in.` }, { status: 424 });
  }
  return upstream;
}

type RpcReply = { id?: unknown; result?: unknown; error?: { message?: string } };

async function errorOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof (body.error as { message?: unknown }).message === "string") return (body.error as { message: string }).message;
  } catch {
    // not JSON; the text itself is the reason
  }
  return text.trim().slice(0, 300) || `HTTP ${res.status}`;
}

function matching(value: unknown, id: number): RpcReply | null {
  for (const message of Array.isArray(value) ? value : [value]) {
    if (message && typeof message === "object" && (message as RpcReply).id === id) return message as RpcReply;
  }
  return null;
}

/** The reply to request `id`, from a JSON body or an event stream (Streamable HTTP lets the server pick). */
async function replyTo(res: Response, id: number): Promise<RpcReply> {
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const reply = matching(await res.json(), id);
    if (!reply) throw new Error("The server answered without a reply to the call");
    return reply;
  }
  for await (const event of sseStream(res.body!)) {
    const reply = matching(event, id);
    if (reply) return reply;
  }
  throw new Error("The server closed the stream without a reply");
}

export class McpSession {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(readonly server: McpServer) {}

  private async post(message: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION });
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    const res = await forwardMcp(this.server, { method: "POST", suffix: "", search: "", headers, body: JSON.stringify({ jsonrpc: "2.0", ...message }), signal });
    this.sessionId = res.headers.get("mcp-session-id") ?? this.sessionId;
    return res;
  }

  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ id, method, params }, signal);
    if (!res.ok) throw new Error(await errorOf(res));
    const reply = await replyTo(res, id);
    if (reply.error) throw new Error(reply.error.message ?? "The server refused the call");
    return reply.result;
  }

  async open(signal?: AbortSignal): Promise<void> {
    await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "gond", version: "1" } }, signal);
    const res = await this.post({ method: "notifications/initialized" }, signal);
    await res.body?.cancel().catch(() => undefined);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, signal)) as { tools?: McpToolInfo[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }
}

type McpToolInfo = { name: string; title?: string; description?: string; inputSchema?: unknown };

type McpContent = { type?: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } };

function toolResultOf(result: unknown): ToolResult {
  const { content = [], structuredContent, isError } = (result ?? {}) as { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };
  const parts: ToolPart[] = [];
  for (const item of content) {
    if (item.type === "text" && item.text) parts.push({ type: "text", text: item.text });
    else if (item.type === "image" && item.data && (item.mimeType === "image/png" || item.mimeType === "image/jpeg")) parts.push({ type: "image", data: item.data, mimeType: item.mimeType });
    else if (item.type === "resource" && item.resource) parts.push({ type: "text", text: item.resource.text ?? item.resource.uri ?? "" });
  }
  if (!parts.some((part) => part.type === "text") && structuredContent !== undefined) parts.unshift({ type: "text", text: JSON.stringify(structuredContent) });
  const clipped = parts.map((part) => (part.type === "text" && part.text.length > MAX_RESULT ? { ...part, text: `${part.text.slice(0, MAX_RESULT)}\n[… ${part.text.length - MAX_RESULT} more characters]` } : part));
  if (isError) clipped.unshift({ type: "text", text: "The tool reported an error:" });
  if (!clipped.length) return "(no output)";
  return clipped.every((part) => part.type === "text") ? clipped.map((part) => (part as { text: string }).text).join("\n") : clipped;
}

export type McpServerNote = { name: string; note?: string };

// Each server's tool list, so a turn doesn't open every server just to learn its tools; a refresh,
// a sign-in or new headers make a new key.
const listings = new Map<string, { at: number; tools: McpToolInfo[] }>();
const refreshing = new Set<string>();
// After a failed refresh, the next is tried this much later rather than on every turn.
const RETRY_LISTING_MS = 60_000;
// Signed in or not is what changes a server's tools; a probe flipping it between fine and failing isn't.
const listingKey = (server: McpServer) => JSON.stringify([server.id, server.url, server.refreshedAt, server.authStatus === "signed_in", server.headers]);

/**
 * The `api` engine's MCP servers: it runs in the API, not in a CLI on the
 * box, so it talks to each HTTP server itself. Tools carry the CLI's names
 * (`mcp__<server>__<tool>`) so approvals and saved rules hold unchanged.
 */
export async function nativeMcpTools(context: { bot: Bot; thread: Thread; signal?: AbortSignal }): Promise<{ tools: Record<string, DriverTool>; servers: McpServerNote[] }> {
  const tools: Record<string, DriverTool> = {};
  const servers = await Promise.all(
    mcpServersFor(context.bot).map(async (server): Promise<McpServerNote> => {
      if (server.transport !== "http") return { name: server.name, note: "runs as a command on the computer, so only Claude Code can use it, not a plan or an API key Gond calls itself" };
      if (server.authStatus === "needed") return { name: server.name, note: `not attached yet: it waits for the person to sign in, from its card or Settings → Apps → MCP servers → ${server.name} → Sign in` };
      const session = new McpSession(server);
      let opened: Promise<void> | null = null;
      const ready = (signal?: AbortSignal) =>
        (opened ??= session.open(signal).catch((error: unknown) => {
          opened = null;
          throw error;
        }));
      const key = listingKey(server);
      const cached = listings.get(key);
      let listed: McpToolInfo[];
      if (cached) {
        // A listing past its time still serves this turn while a fresh one is fetched beside it, so a slow
        // or failing server never holds up the turn; a failed fetch keeps the last good list.
        listed = cached.tools;
        if (Date.now() - cached.at >= LIST_CACHE_MS && !refreshing.has(key)) {
          refreshing.add(key);
          const fresh = new McpSession(server);
          const signal = AbortSignal.timeout(OPEN_TIMEOUT_MS);
          void fresh
            .open(signal)
            .then(() => fresh.listTools(signal))
            .then((tools) => listings.set(key, { at: Date.now(), tools }))
            .catch(() => listings.set(key, { at: Date.now() - LIST_CACHE_MS + RETRY_LISTING_MS, tools: cached.tools }))
            .finally(() => refreshing.delete(key));
        }
      } else {
        try {
          const signal = AbortSignal.any([AbortSignal.timeout(OPEN_TIMEOUT_MS), ...(context.signal ? [context.signal] : [])]);
          await ready(signal);
          listed = await session.listTools(signal);
          listings.set(key, { at: Date.now(), tools: listed });
        } catch (error) {
          listings.delete(key);
          return { name: server.name, note: `didn't answer this time (${error instanceof Error ? error.message : "unknown error"}); tell the person if you need it` };
        }
      }
      for (const tool of listed) {
        const name = `mcp__${server.name}__${tool.name}`;
        if (!TOOL_NAME.test(name)) continue;
        tools[name] = {
          description: `${server.name}: ${tool.description ?? tool.title ?? tool.name}`.slice(0, 1000),
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          execute: async (input) => {
            const { decision, aside } = await askApproval({ bot: context.bot, threadId: context.thread.id, signal: context.signal, tool: name, input });
            if (aside) return setAsideText(`for ${name}`);
            if (decision === "deny") return "NOT done: the person denied this action.";
            if (decision === "expired") return expiredText(`for ${name}`);
            const signal = AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), ...(context.signal ? [context.signal] : [])]);
            await ready(signal);
            return toolResultOf(await session.request("tools/call", { name: tool.name, arguments: input }, signal));
          },
        };
      }
      return { name: server.name };
    }),
  );
  return { tools, servers };
}
