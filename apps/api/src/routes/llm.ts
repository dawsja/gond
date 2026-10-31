import { PROVIDER_LABELS, isPlanProvider, providerInputSchema, type ModelList, type ProviderKind } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { userId } from "../access.ts";
import { getAi, releaseEngines } from "../data/ai.ts";
import { deleteProvider, getProvider, isProviderKind, listProviders, providerBaseUrl, providerByToken, recordProviderCheck, saveProvider } from "../data/providers.ts";
import { signOutChatGpt, startChatGptLogin } from "../chatgpt.ts";
import { authHeaders, coderOnlyRefusal, proxiedUrl } from "../providers.ts";
import { currentModel } from "../engines.ts";
import { keyFor, modelsFor, modelsRequest } from "../models.ts";
import { grokSignIn, signOutGrok, startGrokLogin } from "../grok.ts";

const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "cookie", "authorization", "x-api-key", "x-gond-llm-token", "accept-encoding"]);

// A plan's token is for answering a person, so the proxy passes nothing else through.
const PLAN_PATHS = new Set(["responses", "models"]);

export function presentedToken(headers: Headers): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  return (headers.get("x-gond-llm-token") ?? headers.get("x-api-key") ?? bearer ?? "").trim();
}

async function checkProvider(owner: string, kind: ProviderKind): Promise<{ ok: boolean; detail: string }> {
  const baseUrl = providerBaseUrl(owner, kind);
  const key = await keyFor(owner, kind);
  if (isPlanProvider(kind) && !key) return { ok: false, detail: `Your ${PROVIDER_LABELS[kind].short} sign-in ended. Sign in again.` };
  if (!baseUrl || !key) return { ok: false, detail: "Not set" };
  const { url, headers } = modelsRequest(kind, baseUrl, key);
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const refusal = res.status === 403 ? await res.text().catch(() => "") : "";
    await res.body?.cancel().catch(() => undefined);
    if (coderOnlyRefusal(refusal)) return { ok: true, detail: "Saved. This key works only through a coding agent, so run Claude Code on it." };
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
    return c.json({ groups, current: currentModel(ai, who) } satisfies ModelList);
  });

  return app;
}

export function llmProxyRoutes() {
  const app = new Hono();

  app.all("/llm/:kind/*", async (c) => {
    const kind = c.req.param("kind");
    // The voice key is the API's own, for the microphone and calls; nothing on the computer reaches it.
    if (!isProviderKind(kind) || kind === "voice") return c.json({ error: "Couldn't find that provider" }, 404);
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
        // Whole, with its length: a gateway that waits on a chunked upload would leave the turn hanging.
        body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.raw.arrayBuffer(),
        redirect: "manual",
        signal: c.req.raw.signal,
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
