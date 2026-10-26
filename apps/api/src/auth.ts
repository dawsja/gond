import { randomBytes, timingSafeEqual } from "node:crypto";
import { OIDC_PROVIDER_ID } from "@gond/shared";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { username } from "better-auth/plugins/username";
import { appUrl, env } from "./config.ts";
import { oidcProvider } from "./data/oidc.ts";
import { adoptOrphans, ensureAdmin } from "./data/users.ts";
import { ensureDatabase } from "./db/init.ts";
import { dbPath } from "./db/sqlite.ts";
import { derivedAuthSecret } from "./secrets.ts";

type TokenState = { token: string; attempts: number[]; logged: boolean };
const tokenHolder = globalThis as typeof globalThis & { __gondSetupToken?: TokenState };
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_WRONG_ATTEMPTS = 10;

export function ensureSetupToken(): string {
  let state = tokenHolder.__gondSetupToken;
  if (!state) {
    state = { token: env("SETUP_TOKEN")?.trim() || randomBytes(18).toString("base64url"), attempts: [], logged: false };
    tokenHolder.__gondSetupToken = state;
  }
  if (!state.logged) {
    state.logged = true;
    if (env("SETUP_TOKEN")) {
      console.info(`[gond] No account yet. Open ${appUrl()}/register and enter the GOND_SETUP_TOKEN you set.`);
    } else {
      console.info(`[gond] Gond setup token: ${state.token}. Open ${appUrl()}/register and enter it to create the only account.`);
    }
  }
  return state.token;
}

export function checkSetupToken(input: string): "ok" | "wrong" | "locked" {
  const state = tokenHolder.__gondSetupToken;
  if (!state) return "wrong";
  const at = Date.now();
  state.attempts = state.attempts.filter((t) => at - t < ATTEMPT_WINDOW_MS);
  if (state.attempts.length >= MAX_WRONG_ATTEMPTS) return "locked";
  const given = Buffer.from(input.trim());
  const expected = Buffer.from(state.token);
  const ok = given.length === expected.length && timingSafeEqual(given, expected);
  if (!ok) state.attempts.push(at);
  return ok ? "ok" : "wrong";
}

export function clearSetupToken() {
  tokenHolder.__gondSetupToken = undefined;
}

/**
 * Origins allowed to send state-changing requests: the `APP_URL` origin,
 * plus the origin the browser actually used for this request. A cross-site
 * page can't make a victim's browser send a matching Host header.
 */
export function trustedOriginsFor(request?: Request | Headers): string[] {
  const origins = new Set<string>([new URL(appUrl()).origin]);
  const headers = request instanceof Headers ? request : request?.headers;
  const host = headers?.get("x-forwarded-host") ?? headers?.get("host");
  if (host) {
    const fromUrl = request && !(request instanceof Headers) ? new URL(request.url).protocol : null;
    const proto = headers?.get("x-forwarded-proto") ?? (fromUrl ?? new URL(appUrl()).protocol).replace(":", "");
    origins.add(`${proto}://${host}`);
  }
  return [...origins];
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isSameOrigin(request: Request) {
  if (!UNSAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.get("origin");
  if (origin) return trustedOriginsFor(request).includes(origin);
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function countUsersNow(): number {
  const row = ensureDatabase().query('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
  return Number(row.n);
}

export function oidcCallbackUrl(): string {
  return `${new URL(appUrl()).origin}/api/auth/callback/${OIDC_PROVIDER_ID}`;
}

export function oidcLogoutUrl(): string {
  return `${new URL(appUrl()).origin}/login`;
}

function oidcConfig(): GenericOAuthConfig[] {
  const provider = oidcProvider();
  if (!provider) return [];
  return [
    {
      providerId: OIDC_PROVIDER_ID,
      name: provider.name,
      discoveryUrl: `${provider.issuer}/.well-known/openid-configuration`,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      scopes: provider.scopes,
      pkce: true,
      redirectURI: oidcCallbackUrl(),

      postLogoutRedirectURI: oidcLogoutUrl(),

      mapProfileToUser: (profile) => ({
        name: (typeof profile.name === "string" && profile.name.trim()) || (typeof profile.preferred_username === "string" && profile.preferred_username.trim()) || profile.email?.split("@")[0] || "Someone",
      }),
    },
  ];
}

function buildOptions() {
  return {
    appName: "Gond",
    database: ensureDatabase(),
    baseURL: appUrl(),
    basePath: "/api/auth",
    secret: process.env.BETTER_AUTH_SECRET || derivedAuthSecret(),
    trustedOrigins: (request?: Request) => trustedOriginsFor(request),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 256, autoSignIn: true },
    disabledPaths: ["/sign-up/email"],
    // The local account can link the OIDC sign-in from Settings → Account, so moving to the provider
    // keeps everything. Its email is made up (<name>@users.gond.invalid), so the two never match; a link
    // is only ever made by someone signed in asking for it, never by an email at sign-in.
    account: { accountLinking: { enabled: true, allowDifferentEmails: true } },
    plugins: [username(), admin({ defaultRole: "user", adminRoles: ["admin"] }), genericOAuth({ config: oidcConfig() })],
    advanced: { useSecureCookies: appUrl().startsWith("https://") },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/username": { window: 60, max: 5 }, "/change-password": { window: 60, max: 5 } },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const fromProvider = typeof context?.path === "string" && context.path.startsWith("/callback/");
            if (!fromProvider && countUsersNow() > 0) throw new APIError("FORBIDDEN", { message: "Registration is closed" });
            return { data: { ...user, role: fromProvider ? "user" : "admin" } };
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

function createAuth(options: ReturnType<typeof buildOptions>) {
  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

type AuthCache = { key: string; ready: Promise<Auth> };
const holder = globalThis as typeof globalThis & { __gondAuth?: AuthCache; __gondAuthVersion?: number };

export function getAuth(): Promise<Auth> {
  const key = `${dbPath()}#${holder.__gondAuthVersion ?? 0}`;
  if (holder.__gondAuth?.key === key) return holder.__gondAuth.ready;
  const ready = (async () => {
    const options = buildOptions();
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
    const auth = createAuth(options);
    const adminId = ensureAdmin();
    if (adminId) adoptOrphans(adminId);
    else ensureSetupToken();
    return auth;
  })();
  holder.__gondAuth = { key, ready };
  ready.catch(() => {
    if (holder.__gondAuth?.ready === ready) holder.__gondAuth = undefined;
  });
  return ready;
}

export function invalidateAuth() {
  holder.__gondAuthVersion = (holder.__gondAuthVersion ?? 0) + 1;
}

export async function countAccounts(): Promise<number> {
  await getAuth();
  return countUsersNow();
}

export async function getSession(headers: Headers): Promise<Session | null> {
  const auth = await getAuth();
  return auth.api.getSession({ headers });
}

const USERNAME = /^[a-z0-9_.]{3,30}$/;

export async function registerAccount(input: { token: string; username: string; password: string }, headers: Headers): Promise<{ error?: string }> {
  const name = input.username.trim().toLowerCase();
  if ((await countAccounts()) > 0) return { error: "An account already exists. Sign in instead." };
  const check = checkSetupToken(input.token);
  if (check === "locked") return { error: "Too many wrong setup tokens. Wait 10 minutes and try again." };
  if (check === "wrong") return { error: "That setup token doesn't match. Copy it from the server logs." };
  if (!USERNAME.test(name)) return { error: "Use 3 to 30 letters, numbers, dots or underscores for the username." };
  if (input.password.length < 12) return { error: "Use a password of at least 12 characters." };
  try {
    const auth = await getAuth();
    const body = { email: `${name}@users.gond.invalid`, name, username: name, password: input.password };
    await auth.api.signUpEmail({ body: body as { email: string; name: string; password: string }, headers });
  } catch (error) {
    if (error instanceof Error && /registration (is )?closed/i.test(error.message)) return { error: "An account already exists. Sign in instead." };
    if (error instanceof APIError) return { error: error.message || "Could not create the account." };
    throw error;
  }
  clearSetupToken();
  const adminId = ensureAdmin();
  if (adminId) adoptOrphans(adminId);
  return {};
}
