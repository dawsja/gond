import { MCP_LOOPBACK_CALLBACK, hasKeyHeader, type McpServer } from "@gond/shared";
import { createHash, randomBytes } from "node:crypto";
import { appUrl, env } from "./config.ts";
import { getMcpOAuth, getMcpServer, mcpServerOwner, setMcpAuthStatus, setMcpOAuth, type McpOAuthState } from "./data/mcp.ts";
import { injectSecrets } from "./data/secrets.ts";
import { postMessage } from "./data/threads.ts";
import { personOf } from "./data/profiles.ts";

/*
 * Sign-in for HTTP MCP servers, the way the MCP authorization spec lays it
 * out and the way Robinhood's, Linear's and friends work: the server answers
 * 401 and points at its protected-resource metadata; that names an
 * authorization server; Gond registers itself as a client there (RFC 7591)
 * when it can, sends the person through the authorization code flow with
 * PKCE, and keeps the tokens. The proxy adds the bearer token to every
 * request and refreshes it when it runs out. Tokens live encrypted in the
 * database and never reach the box or a bot.
 *
 * Some providers only let local tools sign in, with a redirect to
 * localhost. A server set to `localhost` sends the browser back to
 * MCP_LOOPBACK_CALLBACK instead: the desktop app listens there and hands
 * the code to this Gond's callback, and in a browser the person pastes
 * the address the page landed on (finishMcpLoginFrom).
 */

type ResourceMetadata = { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string };
type ServerMetadata = { authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string; scopes_supported?: string[]; code_challenge_methods_supported?: string[] };

export function callbackUrl(server?: Pick<McpServer, "oauthRedirect"> | null): string {
  return server?.oauthRedirect === "localhost" ? MCP_LOOPBACK_CALLBACK : `${appUrl()}/api/mcp-servers/oauth/callback`;
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function resourceMetadataFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /resource_metadata="?([^",\s]+)"?/i.exec(header);
  return match?.[1] ?? null;
}

export async function probeMcpServer(id: string): Promise<{ status: "none" | "needed" | "error"; detail?: string }> {
  const server = getMcpServer(id);
  if (!server || server.transport !== "http" || !server.url) return { status: "none" };
  const missing: string[] = [];
  const owner = mcpServerOwner(id) ?? "";
  const own = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, injectSecrets(value, owner, (name) => missing.push(name))]));
  if (missing.length) {
    const detail = `Its headers name a secret that isn't stored: ${missing.join(", ")}.`;
    setMcpAuthStatus(id, "error", detail);
    return { status: "error", detail };
  }
  let res: Response;
  try {
    res = await fetch(server.url, {
      method: "POST",
      headers: { ...own, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Gond", version: "1" } } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "no answer";
    setMcpAuthStatus(id, "error", `The server didn't answer: ${detail}`);
    return { status: "error", detail };
  }
  if (res.status !== 401) {
    if (server.authStatus !== "signed_in") setMcpAuthStatus(id, "none");
    return { status: "none" };
  }
  if (hasKeyHeader(server.headers)) {
    const detail = "The server turned down the key in its headers.";
    setMcpAuthStatus(id, "error", detail);
    return { status: "error", detail };
  }
  const metadata = await discover(server.url, res.headers.get("www-authenticate"));
  if (!metadata) {
    setMcpAuthStatus(id, "error", "The server wants a key but offers no sign-in. Ask a bot to connect it again with the key; it asks you for it on a card.");
    return { status: "error", detail: "no metadata" };
  }
  const current = getMcpOAuth(id);
  setMcpOAuth(id, { ...metadata, clientId: current?.clientId ?? "", clientSecret: current?.clientSecret, redirectUri: current?.redirectUri, accessToken: undefined, refreshToken: undefined, expiresAt: undefined, ...(current?.clientId && current.tokenEndpoint === metadata.tokenEndpoint ? { clientId: current.clientId } : {}) });
  setMcpAuthStatus(id, "needed", null);
  return { status: "needed" };
}

async function discover(serverUrl: string, wwwAuthenticate: string | null): Promise<Omit<McpOAuthState, "clientId"> | null> {
  const origin = new URL(serverUrl).origin;
  const path = new URL(serverUrl).pathname.replace(/\/$/, "");
  const candidates = [resourceMetadataFrom(wwwAuthenticate), `${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`].filter((u): u is string => Boolean(u));
  let resource: ResourceMetadata | null = null;
  for (const url of candidates) {
    resource = await getJson<ResourceMetadata>(url);
    if (resource?.authorization_servers?.length) break;
  }
  const issuers = resource?.authorization_servers?.length ? resource.authorization_servers : [origin];
  for (const issuer of issuers) {
    const base = new URL(issuer);
    const issuerPath = base.pathname.replace(/\/$/, "");
    const urls = [`${base.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${base.origin}${issuerPath}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration${issuerPath}`, `${base.origin}${issuerPath}/.well-known/openid-configuration`];
    for (const url of urls) {
      const meta = await getJson<ServerMetadata>(url);
      if (meta?.authorization_endpoint && meta.token_endpoint) {
        return {
          authorizationEndpoint: meta.authorization_endpoint,
          tokenEndpoint: meta.token_endpoint,
          registrationEndpoint: meta.registration_endpoint,
          resource: resource?.resource ?? serverUrl,
          scope: (resource?.scopes_supported ?? meta.scopes_supported)?.join(" ") || undefined,
        };
      }
    }
  }
  return null;
}

async function ensureClient(id: string, state: McpOAuthState, redirectUri: string): Promise<McpOAuthState> {
  if (state.clientId && ((state.redirectUri ?? callbackUrl()) === redirectUri || !state.registrationEndpoint)) return state;
  if (state.registrationEndpoint) {
    const registered = await getJson<{ client_id?: string; client_secret?: string }>(state.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_name: "Gond", client_uri: appUrl(), redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (registered?.client_id) {
      const next = { ...state, clientId: registered.client_id, clientSecret: registered.client_secret, redirectUri };
      setMcpOAuth(id, next);
      return next;
    }
  }
  const fromEnv = (env("MCP_CLIENT_ID") ?? "").trim();
  if (fromEnv) {
    const next = { ...state, clientId: fromEnv, clientSecret: (env("MCP_CLIENT_SECRET") ?? "").trim() || undefined };
    setMcpOAuth(id, next);
    return next;
  }
  throw new Error("This server doesn't register clients on its own. Get a client id from its provider (redirect URL: " + redirectUri + ") and set GOND_MCP_CLIENT_ID on the API.");
}

type PendingLogin = { serverId: string; verifier: string; redirectUri: string; startedAt: number; threadId?: string; app?: "desktop" };
const holder = globalThis as typeof globalThis & { __gondMcpLogins?: Map<string, PendingLogin> };
function logins(): Map<string, PendingLogin> {
  return (holder.__gondMcpLogins ??= new Map());
}

export async function startMcpLogin(id: string, { threadId, app }: { threadId?: string; app?: "desktop" } = {}): Promise<string> {
  let state = getMcpOAuth(id);
  if (!state) {
    const probe = await probeMcpServer(id);
    state = getMcpOAuth(id);
    if (probe.status !== "needed" || !state) throw new Error(probe.status === "none" ? "This server doesn't ask for a sign-in." : `Can't sign in: ${probe.detail ?? "no OAuth metadata"}`);
  }
  const redirectUri = callbackUrl(getMcpServer(id));
  state = await ensureClient(id, state, redirectUri);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomBytes(24).toString("base64url");
  for (const [key, login] of logins()) if (Date.now() - login.startedAt > 10 * 60_000) logins().delete(key);
  const viaApp = app === "desktop" && redirectUri !== MCP_LOOPBACK_CALLBACK;
  logins().set(nonce, { serverId: id, verifier, redirectUri, startedAt: Date.now(), ...(threadId ? { threadId } : {}), ...(viaApp ? { app } : {}) });
  const url = new URL(state.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", state.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", state.resource);
  if (state.scope) url.searchParams.set("scope", state.scope);
  return url.toString();
}

/**
 * The desktop app opens the provider in the system browser, which needn't
 * be signed in to Gond, so its sign-in comes back through the app's
 * loopback (MCP_LOOPBACK_CALLBACK) and is finished in its window, where
 * the session is. Null for a sign-in the callback can finish where it lands.
 */
export function mcpLoginHandBack(nonce: string, query: URLSearchParams): string | null {
  if (logins().get(nonce)?.app !== "desktop" || query.has("via")) return null;
  const forward = new URLSearchParams(query);
  forward.set("via", "app");
  return `${MCP_LOOPBACK_CALLBACK}?${forward}`;
}

export function mcpLoginThread(nonce: string): string | null {
  return logins().get(nonce)?.threadId ?? null;
}

export async function finishMcpLogin(nonce: string, code: string): Promise<string> {
  const login = logins().get(nonce);
  if (!login) throw new Error("This sign-in link is stale. Start again from Settings → Apps → MCP servers.");
  logins().delete(nonce);
  const state = getMcpOAuth(login.serverId);
  const server = getMcpServer(login.serverId);
  if (!state || !server) throw new Error("That MCP server is gone.");
  const tokens = await tokenRequest(state, { grant_type: "authorization_code", code, redirect_uri: login.redirectUri, code_verifier: login.verifier });
  setMcpOAuth(login.serverId, { ...state, ...tokens });
  setMcpAuthStatus(login.serverId, "signed_in", null);
  return server.name;
}

export async function completeMcpLogin(query: { code?: string | null; state?: string | null; error?: string | null; errorDescription?: string | null }, userId: string): Promise<{ ok: boolean; name?: string; reason?: string; threadId: string | null }> {
  const login = query.state ? logins().get(query.state) : undefined;
  const owner = login ? mcpServerOwner(login.serverId) : null;
  if (login && owner !== userId) return { ok: false, reason: owner && personOf(owner) === personOf(userId) ? "That sign-in was started in another profile. Switch back to it and start again." : "That sign-in was started by someone else.", threadId: null };
  const threadId = query.state ? mcpLoginThread(query.state) : null;
  const failed = (reason: string) => {
    if (threadId) postMessage({ threadId, author: "system", kind: "event", body: `The sign-in didn't complete: ${reason}`, answered: true });
    return { ok: false, reason, threadId };
  };
  if (query.error || !query.code || !query.state) return failed(query.errorDescription || query.error || "The sign-in didn't complete.");
  try {
    const name = await finishMcpLogin(query.state, query.code);
    if (threadId) {
      postMessage({ threadId, author: "system", kind: "event", body: `Signed in to ${name}.`, answered: true });
      postMessage({ threadId, author: "system", kind: "prompt", body: `The person just signed in to the MCP server ${name}; its tools are yours from this reply. Carry on with what they asked for that needed it, or tell them in a line that it's connected.` });
    }
    return { ok: true, name, threadId };
  } catch (error) {
    return failed(error instanceof Error ? error.message : "The sign-in didn't complete.");
  }
}

export function completeMcpLoginFrom(pasted: string, userId: string): Promise<{ ok: boolean; name?: string; reason?: string; threadId: string | null }> {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return Promise.resolve({ ok: false, reason: "That isn't an address. Copy the whole address from the page the sign-in ended on.", threadId: null });
  }
  const q = url.searchParams;
  if (!q.get("state")) return Promise.resolve({ ok: false, reason: "That address has no sign-in in it. Copy it from the page the sign-in ended on (it starts with http://localhost).", threadId: null });
  return completeMcpLogin({ code: q.get("code"), state: q.get("state"), error: q.get("error"), errorDescription: q.get("error_description") }, userId);
}

async function tokenRequest(state: McpOAuthState, params: Record<string, string>): Promise<Pick<McpOAuthState, "accessToken" | "refreshToken" | "expiresAt">> {
  const body = new URLSearchParams({ ...params, client_id: state.clientId, resource: state.resource });
  if (state.clientSecret) body.set("client_secret", state.clientSecret);
  const res = await fetch(state.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? `The token request failed (${res.status})`);
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? state.refreshToken, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined };
}

const renewing = new Map<string, Promise<string | null>>();

export async function bearerFor(id: string): Promise<string | null> {
  const state = getMcpOAuth(id);
  if (!state?.accessToken) return null;
  if (!(state.expiresAt && state.expiresAt - Date.now() < 60_000 && state.refreshToken)) return state.accessToken;
  // Refresh tokens are often single-use: a session's parallel requests renewing at once would spend it
  // twice, and the one refused would sign the person out with a fresh token already saved.
  let pending = renewing.get(id);
  if (!pending) {
    pending = renew(id, state).finally(() => renewing.delete(id));
    renewing.set(id, pending);
  }
  return pending;
}

async function renew(id: string, state: McpOAuthState): Promise<string | null> {
  try {
    const tokens = await tokenRequest(state, { grant_type: "refresh_token", refresh_token: state.refreshToken! });
    setMcpOAuth(id, { ...state, ...tokens });
    return tokens.accessToken ?? null;
  } catch (error) {
    const latest = getMcpOAuth(id);
    if (latest?.accessToken && latest.accessToken !== state.accessToken) return latest.accessToken;
    if (state.expiresAt && state.expiresAt > Date.now()) return state.accessToken!;
    setMcpAuthStatus(id, "needed", `The sign-in expired and couldn't be renewed: ${error instanceof Error ? error.message : "error"}. Sign in again.`);
    return null;
  }
}

export function signOutMcp(id: string): void {
  const state = getMcpOAuth(id);
  if (state) setMcpOAuth(id, { ...state, accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
  setMcpAuthStatus(id, "needed", null);
}
