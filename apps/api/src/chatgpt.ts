import { MCP_LOOPBACK_PORT } from "@gond/shared";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./config.ts";
import { deleteProvider, endPlanSession, planSession, savePlanSession, type PlanSession } from "./data/providers.ts";
import { chatGptClient, setChatGptClient } from "./data/prefs.ts";
import { personOf } from "./data/profiles.ts";

/*
 * Sign in with ChatGPT, the open-source flow (developers.openai.com/siwc):
 * OAuth 2.0 with PKCE against auth.openai.com, the client registered on
 * first use (`dynamic_agent_client` comes back as an `oaiapp_` id that is
 * kept and reused for that person), and a loopback redirect on 127.0.0.1,
 * which is why it rides on the desktop app's MCP loopback port: the app
 * and the Android shell already hand that address back to this Gond, and a
 * browser pastes it. The tokens live encrypted in the person's
 * `gond_providers` row and only ever leave through the LLM proxy.
 */

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const FIRST_CLIENT = "dynamic_agent_client";
const CHATGPT_REDIRECT = `http://127.0.0.1:${MCP_LOOPBACK_PORT}/callback`;

const RENEW_BEFORE_MS = 5 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;

// The refresh errors after which only a new sign-in helps.
const ENDED = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

type PendingLogin = { userId: string; verifier: string; nonce: string; clientId: string; startedAt: number };
const holder = globalThis as typeof globalThis & { __gondChatGptLogins?: Map<string, PendingLogin>; __gondChatGptRenewing?: Map<string, Promise<string | null>> };
const logins = () => (holder.__gondChatGptLogins ??= new Map());
const renewing = () => (holder.__gondChatGptRenewing ??= new Map());

/** One id for this install, the same on every sign-in, as `ext_agent_host_id` asks. */
function hostId(): string {
  const file = path.join(ensureDataDir(), "chatgpt-host-id");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  }
  const id = `urn:uuid:${randomUUID()}`;
  writeFileSync(file, id, { mode: 0o600 });
  chmodSync(file, 0o600);
  return id;
}

export function isChatGptState(state: string | null | undefined): boolean {
  return Boolean(state && logins().has(state));
}

export function startChatGptLogin(userId: string): string {
  for (const [key, login] of logins()) if (Date.now() - login.startedAt > LOGIN_TTL_MS) logins().delete(key);
  const saved = chatGptClient(userId);
  const clientId = saved ?? FIRST_CLIENT;
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  logins().set(state, { userId, verifier, nonce, clientId, startedAt: Date.now() });
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CHATGPT_REDIRECT);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("resource", RESOURCE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("ext_agent_host_id", hostId());
  if (!saved) url.searchParams.set("agent_name_hint", "Gond");
  const email = planSession(userId, "chatgpt")?.email;
  if (email) url.searchParams.set("login_hint", email);
  return url.toString();
}

type TokenAnswer = { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<{ ok: true; tokens: TokenAnswer } | { ok: false; code: string; message: string }> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...params, resource: RESOURCE }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as TokenAnswer;
    if (res.ok && data.access_token) return { ok: true, tokens: data };
    return { ok: false, code: data.error ?? `http_${res.status}`, message: data.error_description ?? data.error ?? `The token request failed (${res.status})` };
  } catch (error) {
    return { ok: false, code: "network", message: error instanceof Error ? error.message : "ChatGPT didn't answer" };
  }
}

type Discovery = { jwks_uri?: string; revocation_endpoint?: string };
let discovery: { at: number; value: Discovery } | null = null;

async function openIdConfig(): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 60 * 60_000) return discovery.value;
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ChatGPT's sign-in settings didn't load (${res.status})`);
  discovery = { at: Date.now(), value: (await res.json()) as Discovery };
  return discovery.value;
}

const fromBase64Url = (part: string) => Buffer.from(part, "base64url");

export function idTokenClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("The ID token is malformed");
  return JSON.parse(fromBase64Url(payload).toString("utf8")) as Record<string, unknown>;
}

/** Checks the ID token's claims against what this sign-in sent; the signature is checked apart. */
export function checkIdClaims(claims: Record<string, unknown>, expected: { clientId: string; nonce: string; now?: number }): string | null {
  const now = (expected.now ?? Date.now()) / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) return "The ID token is from someone else.";
  if (!audience.includes(expected.clientId)) return "The ID token is for another app.";
  if (claims.nonce !== expected.nonce) return "The ID token doesn't belong to this sign-in.";
  if (typeof claims.exp !== "number" || claims.exp < now - 60) return "The ID token has expired.";
  return null;
}

async function verifyIdToken(token: string, expected: { clientId: string; nonce: string }): Promise<Record<string, unknown>> {
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) throw new Error("The ID token is malformed");
  const header = JSON.parse(fromBase64Url(head).toString("utf8")) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error("The ID token is signed in a way Gond doesn't accept");
  const { jwks_uri } = await openIdConfig();
  if (!jwks_uri) throw new Error("ChatGPT didn't say where its signing keys are");
  const jwks = (await (await fetch(jwks_uri, { signal: AbortSignal.timeout(15_000) })).json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("The ID token's signing key isn't ChatGPT's");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(signature), new TextEncoder().encode(`${head}.${body}`));
  if (!valid) throw new Error("The ID token's signature doesn't check out");
  const claims = idTokenClaims(token);
  const problem = checkIdClaims(claims, expected);
  if (problem) throw new Error(problem);
  return claims;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export async function completeChatGptLogin(query: { code?: string | null; state?: string | null; error?: string | null; errorDescription?: string | null; clientId?: string | null }, userId: string): Promise<{ ok: boolean; reason?: string }> {
  const login = query.state ? logins().get(query.state) : undefined;
  if (!login) return { ok: false, reason: "This sign-in link is stale. Start again from Settings → AI." };
  if (login.userId !== userId) return { ok: false, reason: personOf(login.userId) === personOf(userId) ? "That sign-in was started in another profile. Switch back to it and start again." : "That sign-in was started by someone else." };
  logins().delete(query.state!);
  if (query.error || !query.code) return { ok: false, reason: query.errorDescription || query.error || "The sign-in didn't complete." };

  const first = login.clientId === FIRST_CLIENT;
  const clientId = first ? text(query.clientId) : login.clientId;
  if (!clientId) return { ok: false, reason: "ChatGPT didn't say which app it registered. Start again." };
  if (!first && query.clientId && query.clientId !== login.clientId) return { ok: false, reason: "The sign-in came back for another app. Start again." };

  const answer = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code: query.code, code_verifier: login.verifier, redirect_uri: CHATGPT_REDIRECT });
  if (!answer.ok) {
    if (answer.code === "invalid_client") setChatGptClient(userId, null);
    return { ok: false, reason: answer.message };
  }
  const { tokens } = answer;
  const scope = tokens.scope ?? "";
  if (!scope.split(/\s+/).includes(PLAN_SCOPE)) return { ok: false, reason: "ChatGPT didn't let Gond use your plan. Sign in again and allow it." };
  if (!tokens.refresh_token) return { ok: false, reason: "ChatGPT didn't hand over a way to stay signed in. Start again." };

  let email: string | null = null;
  let name: string | null = null;
  if (tokens.id_token) {
    try {
      const claims = await verifyIdToken(tokens.id_token, { clientId, nonce: login.nonce });
      email = text(claims.email);
      name = text(claims.name);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "The sign-in couldn't be checked." };
    }
  }
  setChatGptClient(userId, clientId);
  savePlanSession(userId, "chatgpt", tokens.access_token!, { clientId, refreshToken: tokens.refresh_token, idToken: tokens.id_token ?? null, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, scope, email, name });
  return { ok: true };
}

export function completeChatGptLoginFrom(pasted: string, userId: string): Promise<{ ok: boolean; reason?: string }> {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return Promise.resolve({ ok: false, reason: "That isn't an address. Copy the whole address from the page the sign-in ended on." });
  }
  const q = url.searchParams;
  return completeChatGptLogin({ code: q.get("code"), state: q.get("state"), error: q.get("error"), errorDescription: q.get("error_description"), clientId: q.get("client_id") }, userId);
}

/** A live access token for the person's plan, renewed when it's close to running out; null when they must sign in again. */
export async function chatGptAccessToken(userId: string): Promise<string | null> {
  const session = planSession(userId, "chatgpt");
  if (!session) return null;
  if (session.expiresAt - Date.now() > RENEW_BEFORE_MS) return session.accessToken;
  // Refresh tokens rotate: two renewals at once would spend one twice, and ChatGPT ends the sign-in for a reused one.
  let pending = renewing().get(userId);
  if (!pending) {
    pending = renew(userId, session).finally(() => renewing().delete(userId));
    renewing().set(userId, pending);
  }
  return pending;
}

async function renew(userId: string, session: PlanSession & { accessToken: string }): Promise<string | null> {
  const answer = await tokenRequest({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refreshToken });
  if (answer.ok) {
    const { tokens } = answer;
    savePlanSession(userId, "chatgpt", tokens.access_token!, {
      ...session,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      idToken: tokens.id_token ?? session.idToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope ?? session.scope,
    });
    return tokens.access_token!;
  }
  if (ENDED.has(answer.code) || answer.code === "invalid_client") {
    if (answer.code === "invalid_client") setChatGptClient(userId, null);
    endPlanSession(userId, "chatgpt", "Your ChatGPT sign-in ended. Sign in again.");
    return null;
  }
  return session.expiresAt > Date.now() ? session.accessToken : null;
}

/** Revokes the refresh token and forgets the sign-in; the registered client and this install's id stay. */
export async function signOutChatGpt(userId: string): Promise<boolean> {
  const session = planSession(userId, "chatgpt");
  if (session?.refreshToken) {
    try {
      const { revocation_endpoint } = await openIdConfig();
      if (revocation_endpoint) {
        await fetch(revocation_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: session.refreshToken, token_type_hint: "refresh_token", client_id: session.clientId }),
          signal: AbortSignal.timeout(15_000),
        });
      }
    } catch {
      /* forgetting it here still signs Gond out; ChatGPT lets an unused token lapse */
    }
  }
  return deleteProvider(userId, "chatgpt");
}
