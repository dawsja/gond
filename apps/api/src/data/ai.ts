import { DEFAULT_AI, DEFAULT_ENGINES, ENGINE_LABELS, ENGINES, isCliEngine, type AiSettings, type Engine, type EngineSettings, type ProviderKind } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { readEngines } from "./settings.ts";

type Row = { user_id: string; engine: string; enabled: string | null; engines: string };

function isEngine(value: unknown): value is Engine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

function readEnabled(json: string | null, engine: Engine): Engine[] {
  let stored: unknown = null;
  try {
    stored = json ? JSON.parse(json) : null;
  } catch {
    /* the defaults below */
  }
  const list = Array.isArray(stored) ? stored.filter(isEngine) : [];
  const out = ENGINES.filter((candidate) => list.includes(candidate));
  return out.includes(engine) ? out : [engine, ...out];
}

function toAi(row: Row | null): AiSettings {
  if (!row) return { ...DEFAULT_AI, engines: { ...DEFAULT_AI.engines } };
  const engines = readEngines(row.engines, null);
  let engine = isEngine(row.engine) ? row.engine : DEFAULT_AI.engine;
  let enabled = readEnabled(row.enabled, engine);
  // A ChatGPT plan was first run as the api engine on the chatgpt provider; it is an engine of its own now.
  if (engines.api.provider === "chatgpt") {
    engines.chatgpt = { ...engines.chatgpt, model: engines.chatgpt.model || engines.api.model };
    engines.api = { ...DEFAULT_ENGINES.api };
    if (engine === "api") engine = "chatgpt";
    enabled = readEnabled(JSON.stringify(enabled.map((name) => (name === "api" ? "chatgpt" : name))), engine);
  }
  // Grok was its CLI on the computer, or an xAI key; it is the plan signed in to here now, and a key is the api engine's.
  if (engines.grok.provider !== "grok" || engines.grok.access !== "api") {
    const key = engines.grok.access === "api" ? engines.grok.provider : null;
    if (key && !engines.api.provider) {
      engines.api = { access: "api", model: engines.api.model || engines.grok.model, provider: key };
      if (engine === "grok") engine = "api";
      enabled = readEnabled(JSON.stringify(enabled.map((name) => (name === "grok" ? "api" : name))), engine);
    }
    engines.grok = { ...DEFAULT_ENGINES.grok };
  }
  return { engine, enabled, engines };
}

export function getAi(userId: string): AiSettings {
  const row = ensureDatabase().query("SELECT user_id, engine, enabled, engines FROM gond_user_ai WHERE user_id = ?").get(userId) as Row | null;
  return toAi(row);
}

export function updateAi(userId: string, patch: { engine?: Engine; enabled?: Engine[]; engines?: Partial<Record<Engine, EngineSettings>> }): AiSettings {
  const current = getAi(userId);

  const enabled = ENGINES.filter((engine) => (patch.enabled ?? current.enabled).includes(engine));
  const engine = patch.engine ?? (enabled.includes(current.engine) ? current.engine : (enabled[0] ?? DEFAULT_AI.engine));
  const next: AiSettings = {
    engine,
    enabled: enabled.includes(engine) ? enabled : [engine, ...enabled],
    engines: { ...current.engines, ...(patch.engines ?? {}) } as Record<Engine, EngineSettings>,
  };
  ensureDatabase()
    .query("INSERT INTO gond_user_ai (user_id, engine, enabled, engines, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET engine = excluded.engine, enabled = excluded.enabled, engines = excluded.engines, updated_at = excluded.updated_at")
    .run(userId, next.engine, JSON.stringify(next.enabled), JSON.stringify(next.engines), now());
  emit({ topic: "ai", userId });
  return getAi(userId);
}

export function releaseEngines(userId: string, kind: ProviderKind, saved: (kind: ProviderKind) => boolean): AiSettings {
  const current = getAi(userId);
  const engines: Partial<Record<Engine, EngineSettings>> = {};
  for (const engine of ENGINES) {
    const config = current.engines[engine];
    const providers = ENGINE_LABELS[engine].providers;
    if (!isCliEngine(engine) || config.access !== "api" || !providers.includes(kind)) continue;
    if (providers.some((other) => other !== kind && saved(other))) continue;
    engines[engine] = { ...config, access: "plan" };
  }
  return Object.keys(engines).length ? updateAi(userId, { engines }) : current;
}

export function adoptLegacyAi(adminId: string): void {
  const db = ensureDatabase();
  if (db.query("SELECT 1 FROM gond_user_ai WHERE user_id = ?").get(adminId)) return;
  const legacy = db.query("SELECT model, engine, engines FROM gond_settings WHERE id = 1").get() as { model: string | null; engine: string | null; engines: string | null } | null;
  if (!legacy || (!legacy.engine && !legacy.engines && !legacy.model)) return;
  const engines = readEngines(legacy.engines, legacy.model);
  const engine = isEngine(legacy.engine) ? legacy.engine : "claude";
  db.query("INSERT INTO gond_user_ai (user_id, engine, enabled, engines, updated_at) VALUES (?, ?, ?, ?, ?)").run(adminId, engine, JSON.stringify([engine]), JSON.stringify(engines), now());
}
