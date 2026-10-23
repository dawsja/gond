import { ENGINE_LABELS, PROVIDER_LABELS, isCliEngine, isOpenAiShaped, isPlanProvider, providerInputSchema, type Engine, type ModelChoice, type ModelGroup, type ModelList, type ProviderKind } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { userId } from "../access.ts";
import { getAi, releaseEngines } from "../data/ai.ts";
import { boxConfig, engineModels } from "../box.ts";
import { deleteProvider, getProvider, isProviderKind, listProviders, providerBaseUrl, providerByToken, providerKey, recordProviderCheck, saveProvider } from "../data/providers.ts";
import { chatGptAccessToken, signOutChatGpt, startChatGptLogin } from "../chatgpt.ts";
import { GROK_PLAN_HEADERS, grokAccessToken, grokSignIn, signOutGrok, startGrokLogin } from "../grok.ts";

const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "cookie", "authorization", "x-api-key", "x-gond-llm-token", "x-kru-llm-token", "accept-encoding"]);

export function isOpenAiHost(baseUrl: string): boolean {
  try {
    return /(^|\.)openai\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isAnthropicHost(baseUrl: string): boolean {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isMiniMaxHost(baseUrl: string): boolean {
  try {
    return /(^|\.)minimaxi?\.(io|com)$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function authHeaders(kind: ProviderKind, baseUrl: string, key: string): Record<string, string> {
  if (kind === "grok") return { authorization: `Bearer ${key}`, ...GROK_PLAN_HEADERS };
  if (isOpenAiShaped(kind)) return { authorization: `Bearer ${key}` };
  return isAnthropicHost(baseUrl) ? { "x-api-key": key } : { "x-api-key": key, authorization: `Bearer ${key}` };
}

/** A key as saved, or for a plan an access token renewed when it's near its end. */
async function keyFor(userId: string, kind: ProviderKind): Promise<string | null> {
  if (kind === "chatgpt") return chatGptAccessToken(userId);
  if (kind === "grok") return grokAccessToken(userId);
  return providerKey(userId, kind);
}

// A plan's token is for answering a person, so the proxy passes nothing else through.
const PLAN_PATHS = new Set(["responses", "models"]);

function modelsRequest(kind: ProviderKind, baseUrl: string, key: string): { url: URL; headers: Record<string, string> } {
  return {
    url: upstreamUrl(baseUrl, isOpenAiShaped(kind) ? "models" : "v1/models", ""),
    headers: { ...authHeaders(kind, baseUrl, key), ...(isOpenAiShaped(kind) ? {} : { "anthropic-version": "2023-06-01" }) },
  };
}

/** A plan's list comes best first, so it keeps its order; a key's is sorted. */
export function readModels(payload: unknown, ranked = false): ModelChoice[] {
  const rows = (payload as { data?: unknown; models?: unknown })?.data ?? (payload as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];
  const out: ModelChoice[] = [];
  // A ChatGPT plan lists `slug`s, best first, with the ones to offer marked `visibility: "list"`.
  for (const row of rows) {
    const entry = row as { id?: unknown; slug?: unknown; display_name?: unknown; visibility?: unknown };
    if (typeof entry?.slug === "string") {
      ranked = true;
      if (entry.visibility !== undefined && entry.visibility !== "list") continue;
    }
    const id = typeof row === "string" ? row : typeof entry?.id === "string" ? entry.id : typeof entry?.slug === "string" ? entry.slug : null;
    if (!id) continue;
    const name = typeof entry?.display_name === "string" ? entry.display_name : undefined;
    out.push(name ? { id, name } : { id });
  }
  return ranked ? out : out.sort((a, b) => a.id.localeCompare(b.id));
}

export function presentedToken(headers: Headers): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  return (headers.get("x-gond-llm-token") ?? headers.get("x-kru-llm-token") ?? headers.get("x-api-key") ?? bearer ?? "").trim();
}

export function upstreamUrl(baseUrl: string, suffix: string, search: string): URL {
  const target = new URL(suffix.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  target.search = search;
  return target;
}

export function proxiedUrl(baseUrl: string, suffix: string, search: string): URL | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    target = upstreamUrl(baseUrl, suffix, search);
  } catch {
    return null;
  }
  if (target.origin !== base.origin || target.username || target.password) return null;
  if (!target.pathname.startsWith(base.pathname)) return null;
  return target;
}

async function checkProvider(owner: string, kind: ProviderKind): Promise<{ ok: boolean; detail: string }> {
  const baseUrl = providerBaseUrl(owner, kind);
  const key = await keyFor(owner, kind);
  if (isPlanProvider(kind) && !key) return { ok: false, detail: `Your ${PROVIDER_LABELS[kind].short} sign-in ended. Sign in again.` };
  if (!baseUrl || !key) return { ok: false, detail: "Not set" };
  const { url, headers } = modelsRequest(kind, baseUrl, key);
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return { ok: true, detail: isPlanProvider(kind) ? "Signed in. Your plan works." : "The key works." };
    if (res.status === 403 && kind === "grok") return { ok: false, detail: "Signed in, but Grok says this account's plan can't be used here. It needs SuperGrok or X Premium+." };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: isPlanProvider(kind) ? `${PROVIDER_LABELS[kind].short} refused the sign-in. Sign in again.` : "The provider refused the key." };

    if (res.status === 404 || res.status === 405) return { ok: true, detail: "Saved. The server answered but doesn't list models, so the key wasn't checked." };
    return { ok: false, detail: `The provider answered ${res.status}.` };
  } catch (error) {
    return { ok: false, detail: `The provider didn't answer: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}

export function providerRoutes() {
  const app = new Hono<Env>();

  app.get("/providers", (c) => c.json({ providers: listProviders(userId(c)) }));

  app.post("/providers/chatgpt/sign-in", (c) => c.json({ url: startChatGptLogin(userId(c)) }));

  app.post("/providers/grok/sign-in", async (c) => {
    try {
      return c.json({ signIn: await startGrokLogin(userId(c)) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Grok didn't start the sign-in" }, 502);
    }
  });

  app.get("/providers/grok/sign-in", (c) => c.json({ signIn: grokSignIn(userId(c)) }));

  app.put("/providers/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "Couldn't find that provider" }, 404);
    if (isPlanProvider(kind)) return c.json({ error: `A ${PROVIDER_LABELS[kind].name} is signed in to, not given a key.` }, 400);
    const parsed = providerInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad provider" }, 400);
    try {
      saveProvider(userId(c), kind, parsed.data);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save" }, 400);
    }
    const provider = recordProviderCheck(userId(c), kind, await checkProvider(userId(c), kind));
    return c.json({ provider });
  });

  app.post("/providers/:kind/check", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind) || !getProvider(userId(c), kind)) return c.json({ error: "Couldn't find that provider" }, 404);
    return c.json({ provider: recordProviderCheck(userId(c), kind, await checkProvider(userId(c), kind)) });
  });

  app.delete("/providers/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "Couldn't find that provider" }, 404);
    const gone = kind === "chatgpt" ? await signOutChatGpt(userId(c)) : kind === "grok" ? await signOutGrok(userId(c)) : deleteProvider(userId(c), kind);
    if (!gone) return c.json({ error: "Couldn't find that provider" }, 404);

    releaseEngines(userId(c), kind, (other) => Boolean(getProvider(userId(c), other)));
    return c.body(null, 204);
  });

  app.get("/models", async (c) => {
    const who = userId(c);
    const ai = getAi(who);
    const groups = await Promise.all(ai.enabled.map((engine) => modelsFor(who, engine)));
    return c.json({ groups } satisfies ModelList);
  });

  return app;
}

async function modelsFor(userId: string, engine: Engine): Promise<ModelGroup> {
  if (isCliEngine(engine)) {
    const box = boxConfig(userId);
    if (!box) return { engine, models: [], source: "none", detail: "The computer isn't reachable." };
    const { models } = await engineModels(box, engine).catch(() => ({ models: [] as ModelChoice[] }));
    return models.length ? { engine, models, source: "engine", detail: null } : { engine, models: [], source: "none", detail: `${ENGINE_LABELS[engine].name} didn't list its models. Type the model id you want.` };
  }
  const info = ENGINE_LABELS[engine];
  const kind = getAi(userId).engines[engine].provider ?? info.providers.find((p) => getProvider(userId, p)) ?? info.provider;
  const baseUrl = providerBaseUrl(userId, kind);
  const key = await keyFor(userId, kind);
  if (!baseUrl || !key) return { engine, models: [], source: "none", detail: isPlanProvider(kind) ? `Sign in with ${PROVIDER_LABELS[kind].short} again to see your plan's models.` : "No API key saved yet." };
  const { url, headers } = modelsRequest(kind, baseUrl, key);
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const models = res.ok ? readModels(await res.json().catch(() => null), isPlanProvider(kind)) : [];
    if (models.length) return { engine, models, source: "provider", detail: null };
    return { engine, models: [], source: "none", detail: res.ok ? "The API listed no models. Type the model id you want." : "The API wouldn't list its models. Type the model id you want." };
  } catch {
    return { engine, models: [], source: "none", detail: "The API didn't answer. Type the model id you want." };
  }
}

export function llmProxyRoutes() {
  const app = new Hono();

  app.all("/llm/:kind/*", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "Couldn't find that provider" }, 404);
    const token = presentedToken(c.req.raw.headers);

    // Tokens are random and unique; the lookup is by equality in the database, never by prefix.
    const provider = token.length >= 16 && token.length <= 200 ? providerByToken(kind, token) : null;
    if (!provider) return c.json({ error: { type: "authentication_error", message: "Unauthorized" } }, 401);
    const { baseUrl } = provider;

    const suffix = c.req.path.replace(/^\/api\/llm\/[^/]+\/?/, "");
    if (isPlanProvider(kind) && !PLAN_PATHS.has(suffix.replace(/\/+$/, ""))) return c.json({ error: { type: "invalid_request_error", message: "A plan only answers responses here" } }, 404);
    const key = isPlanProvider(kind) ? await keyFor(provider.userId, kind) : provider.key;
    if (!key) return c.json({ error: { type: "authentication_error", message: `Your ${PROVIDER_LABELS[kind].short} sign-in ended. Sign in again in Settings → AI.` } }, 403);
    const target = proxiedUrl(baseUrl, suffix, new URL(c.req.url).search);
    if (!target) return c.json({ error: { type: "invalid_request_error", message: "That path isn't under the provider's address" } }, 400);
    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) if (!HOP.has(name.toLowerCase())) headers.set(name, value);
    for (const [name, value] of Object.entries(authHeaders(kind, baseUrl, key))) headers.set(name, value);

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
        redirect: "manual",
        signal: c.req.raw.signal,
        ...({ duplex: "half" } as object),
      });
    } catch (error) {
      return c.json({ error: { type: "api_error", message: `The provider didn't answer: ${error instanceof Error ? error.message : "unknown error"}` } }, 502);
    }
    const out = new Headers();
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase();

      if (HOP.has(lower) || lower === "set-cookie" || lower === "content-encoding") continue;
      out.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  return app;
}
