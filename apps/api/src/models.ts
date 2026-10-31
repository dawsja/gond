import { ENGINE_LABELS, PROVIDER_LABELS, isCliEngine, isOpenAiShaped, isPlanProvider, type AiSettings, type Engine, type ModelChoice, type ModelCurrent, type ModelGroup, type ProviderKind } from "@gond/shared";
import { boxConfig, engineModels } from "./box.ts";
import { chatGptAccessToken } from "./chatgpt.ts";
import { getAi } from "./data/ai.ts";
import { getProvider, providerBaseUrl, providerKey } from "./data/providers.ts";
import { currentModel } from "./engines.ts";
import { grokAccessToken } from "./grok.ts";
import { ANTHROPIC_VERSION, authHeaders, upstreamUrl } from "./providers.ts";

/** A key as saved, or for a plan an access token renewed when it's near its end. */
export async function keyFor(userId: string, kind: ProviderKind): Promise<string | null> {
  if (kind === "chatgpt") return chatGptAccessToken(userId);
  if (kind === "grok") return grokAccessToken(userId);
  return providerKey(userId, kind);
}

export function modelsRequest(kind: ProviderKind, baseUrl: string, key: string): { url: URL; headers: Record<string, string> } {
  return {
    url: upstreamUrl(baseUrl, isOpenAiShaped(kind) ? "models" : "v1/models", ""),
    headers: { ...authHeaders(kind, baseUrl, key), ...(isOpenAiShaped(kind) ? {} : { "anthropic-version": ANTHROPIC_VERSION }) },
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

export async function modelsFor(userId: string, engine: Engine): Promise<ModelGroup> {
  const keyed = engine === "claude" && getAi(userId).engines.claude.access === "api";
  if (isCliEngine(engine) && !keyed) {
    const box = boxConfig(userId);
    if (!box) return { engine, models: [], source: "none", detail: "The computer isn't reachable." };
    const { models } = await engineModels(box, engine).catch(() => ({ models: [] as ModelChoice[] }));
    return models.length ? { engine, models, source: "engine", detail: null } : { engine, models: [], source: "none", detail: `${ENGINE_LABELS[engine].name} didn't list its models. Type the model id you want.` };
  }
  const info = ENGINE_LABELS[engine];
  const kind = keyed ? "anthropic" : (getAi(userId).engines[engine].provider ?? info.providers.find((p) => getProvider(userId, p)) ?? info.provider);
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

/** The models the engine the bots run on now offers, for picking one bot's own. */
export async function modelsInUse(userId: string, ai: AiSettings = getAi(userId)): Promise<{ current: ModelCurrent; choices: ModelChoice[] }> {
  const current = currentModel(ai, userId);
  return { current, choices: (await modelsFor(userId, current.engine)).models };
}

/**
 * The model a bot asked for by id or name, as loosely as people say it ("haiku", "Sonnet 5.5"): an exact
 * id or name first, then the one choice that contains the words. Null when nothing or several match.
 */
export function matchModel(asked: string, choices: ModelChoice[]): ModelChoice | null {
  const wanted = asked.trim().toLowerCase();
  if (!wanted) return null;
  const exact = choices.find((choice) => choice.id.toLowerCase() === wanted || choice.name?.toLowerCase() === wanted);
  if (exact) return exact;
  const loose = choices.filter((choice) => choice.id.toLowerCase().includes(wanted) || Boolean(choice.name?.toLowerCase().includes(wanted)));
  return loose.length === 1 ? loose[0]! : null;
}
