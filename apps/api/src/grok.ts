import { emit } from "./events.ts";
import { deleteProvider, endPlanSession, planSession, savePlanSession, type PlanSession } from "./data/providers.ts";

/*
 * Sign in with Grok: the device flow (RFC 8628) against auth.x.ai with the
 * public client the open-source Grok CLI uses, so the person's SuperGrok or
 * X Premium plan answers through api.x.ai with no CLI on the computer. The
 * person opens xAI's page, enters the code, and a poll here picks up the
 * tokens; they live encrypted in the person's `gond_providers` row and only
 * ever leave through the LLM proxy.
 */

const ISSUER = "https://auth.x.ai";
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPES = "openid profile email offline_access grok-cli:access api:access";

// The plan's proxy turns away clients below its version gate, so these name a current CLI.
const CLI_VERSION = "1.0.52";
const SIGN_IN_HEADERS = { "x-grok-client-version": CLI_VERSION, "x-grok-client-surface": "headless" };

/** What every call to a Grok plan carries besides the bearer token. */
export const GROK_PLAN_HEADERS: Record<string, string> = { "X-XAI-Token-Auth": "xai-grok-cli", "x-grok-client-version": CLI_VERSION, "x-grok-client-mode": "interactive" };

// The CLI's own picture calls go straight to api.x.ai with the plan's token and these (grok-build's media_tool_config.rs).
export const GROK_MEDIA_HEADERS: Record<string, string> = { ...GROK_PLAN_HEADERS, "user-agent": `xai-grok-build/${CLI_VERSION}`, "x-authenticateresponse": "authenticate-response" };

const RENEW_BEFORE_MS = 5 * 60_000;
const ENDED = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "unauthorized_client", "invalid_client"]);

type GrokSignIn = { state: "waiting" | "done" | "failed"; url: string | null; code: string | null; expiresAt: number; error: string | null };

type Pending = GrokSignIn & { deviceCode: string; interval: number; timer: ReturnType<typeof setTimeout> | null };
const holder = globalThis as typeof globalThis & { __gondGrokLogins?: Map<string, Pending>; __gondGrokRenewing?: Map<string, Promise<string | null>> };
const logins = () => (holder.__gondGrokLogins ??= new Map());
const renewing = () => (holder.__gondGrokRenewing ??= new Map());

type Discovery = { device_authorization_endpoint?: string; token_endpoint?: string; revocation_endpoint?: string };
let discovery: { at: number; value: Discovery } | null = null;

async function openIdConfig(): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 60 * 60_000) return discovery.value;
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Grok's sign-in settings didn't load (${res.status})`);
  discovery = { at: Date.now(), value: (await res.json()) as Discovery };
  return discovery.value;
}

async function form(url: string, params: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...SIGN_IN_HEADERS },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The ID token came straight from the token endpoint over TLS, so its claims are read, not its signature (OIDC Core 3.1.3.7). */
export function grokAccount(idToken: string | null | undefined): { email: string | null; name: string | null } {
  try {
    const claims = JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    if (claims.iss !== ISSUER && claims.iss !== `${ISSUER}/`) return { email: null, name: null };
    return { email: text(claims.email), name: text(claims.name) ?? text(claims.preferred_username) };
  } catch {
    return { email: null, name: null };
  }
}

export function grokSignIn(userId: string): GrokSignIn | null {
  const login = logins().get(userId);
  if (!login) return null;
  const { state, url, code, expiresAt, error } = login;
  return { state, url, code, expiresAt, error };
}

function finish(userId: string, login: Pending, outcome: { error: string } | null) {
  if (login.timer) clearTimeout(login.timer);
  login.timer = null;
  login.state = outcome ? "failed" : "done";
  login.error = outcome?.error ?? null;
  emit({ topic: "ai", userId });
}

/** Starts a device sign-in, replacing any the person had going, and polls for it in the background. */
export async function startGrokLogin(userId: string): Promise<GrokSignIn> {
  const old = logins().get(userId);
  if (old?.timer) clearTimeout(old.timer);
  const { device_authorization_endpoint } = await openIdConfig();
  if (!device_authorization_endpoint) throw new Error("Grok doesn't offer a sign-in with a code right now.");
  const { status, data } = await form(device_authorization_endpoint, { client_id: GROK_CLIENT_ID, scope: SCOPES, referrer: "grok-build" });
  const deviceCode = text(data.device_code);
  if (!deviceCode) throw new Error(text(data.error_description) ?? text(data.error) ?? `Grok didn't start the sign-in (${status})`);
  const login: Pending = {
    state: "waiting",
    url: text(data.verification_uri_complete) ?? text(data.verification_uri),
    code: text(data.user_code),
    expiresAt: Date.now() + (Number(data.expires_in) || 600) * 1000,
    error: null,
    deviceCode,
    interval: Math.max(Number(data.interval) || 5, 2) * 1000,
    timer: null,
  };
  logins().set(userId, login);
  schedule(userId, login);
  return grokSignIn(userId)!;
}

function schedule(userId: string, login: Pending) {
  login.timer = setTimeout(() => void poll(userId, login), login.interval);
  if (typeof login.timer.unref === "function") login.timer.unref();
}

async function poll(userId: string, login: Pending) {
  if (logins().get(userId) !== login || login.state !== "waiting") return;
  if (Date.now() > login.expiresAt) return finish(userId, login, { error: "The code ran out. Start again." });
  let answer: { status: number; data: Record<string, unknown> };
  try {
    const { token_endpoint } = await openIdConfig();
    answer = await form(token_endpoint ?? `${ISSUER}/oauth2/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: login.deviceCode, client_id: GROK_CLIENT_ID });
  } catch {
    return schedule(userId, login);
  }
  const { data } = answer;
  const access = text(data.access_token);
  if (access) {
    const refresh = text(data.refresh_token);
    if (!refresh) return finish(userId, login, { error: "Grok didn't hand over a way to stay signed in. Start again." });
    const idToken = text(data.id_token);
    savePlanSession(userId, "grok", access, { clientId: GROK_CLIENT_ID, refreshToken: refresh, idToken, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000, scope: text(data.scope) ?? SCOPES, ...grokAccount(idToken) });
    return finish(userId, login, null);
  }
  const code = text(data.error);
  if (code === "authorization_pending") return schedule(userId, login);
  if (code === "slow_down") {
    login.interval += 5000;
    return schedule(userId, login);
  }
  if (code === "access_denied") return finish(userId, login, { error: "The sign-in was turned down on Grok's page." });
  if (code === "expired_token") return finish(userId, login, { error: "The code ran out. Start again." });
  return finish(userId, login, { error: text(data.error_description) ?? code ?? `Grok answered ${answer.status}.` });
}

/** Polls the person's sign-in now instead of at its next tick. */
export async function checkGrokLogin(userId: string): Promise<GrokSignIn | null> {
  const login = logins().get(userId);
  if (login?.state === "waiting") {
    if (login.timer) clearTimeout(login.timer);
    await poll(userId, login);
  }
  return grokSignIn(userId);
}

function cancelGrokLogin(userId: string) {
  const login = logins().get(userId);
  if (login?.timer) clearTimeout(login.timer);
  logins().delete(userId);
}

/** A live access token for the person's plan, renewed when it's close to running out; null when they must sign in again. */
export async function grokAccessToken(userId: string): Promise<string | null> {
  const session = planSession(userId, "grok");
  if (!session) return null;
  if (session.expiresAt - Date.now() > RENEW_BEFORE_MS) return session.accessToken;
  // A rotated refresh token spent twice ends the sign-in, so one renewal at a time per person.
  let pending = renewing().get(userId);
  if (!pending) {
    pending = renew(userId, session).finally(() => renewing().delete(userId));
    renewing().set(userId, pending);
  }
  return pending;
}

async function renew(userId: string, session: PlanSession & { accessToken: string }): Promise<string | null> {
  let answer: { status: number; data: Record<string, unknown> };
  try {
    const { token_endpoint } = await openIdConfig();
    answer = await form(token_endpoint ?? `${ISSUER}/oauth2/token`, { grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refreshToken });
  } catch {
    return session.expiresAt > Date.now() ? session.accessToken : null;
  }
  const access = text(answer.data.access_token);
  if (access) {
    const idToken = text(answer.data.id_token) ?? session.idToken;
    savePlanSession(userId, "grok", access, {
      ...session,
      refreshToken: text(answer.data.refresh_token) ?? session.refreshToken,
      idToken,
      expiresAt: Date.now() + (Number(answer.data.expires_in) || 3600) * 1000,
      scope: text(answer.data.scope) ?? session.scope,
    });
    return access;
  }
  if (ENDED.has(text(answer.data.error) ?? "")) {
    endPlanSession(userId, "grok", "Your Grok sign-in ended. Sign in again.");
    return null;
  }
  return session.expiresAt > Date.now() ? session.accessToken : null;
}

/** Revokes the refresh token where xAI offers it and forgets the sign-in. */
export async function signOutGrok(userId: string): Promise<boolean> {
  cancelGrokLogin(userId);
  const session = planSession(userId, "grok");
  if (session?.refreshToken) {
    try {
      const { revocation_endpoint } = await openIdConfig();
      if (revocation_endpoint) await form(revocation_endpoint, { token: session.refreshToken, token_type_hint: "refresh_token", client_id: session.clientId });
    } catch {
      /* forgetting it here still signs Gond out */
    }
  }
  return deleteProvider(userId, "grok");
}
