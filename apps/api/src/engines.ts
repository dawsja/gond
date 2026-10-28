import { DEFAULT_MODEL, ENGINE_LABELS, PROVIDER_LABELS, isCliEngine, isPlanProvider, type AiSettings, type Engine, type EngineProviderKind } from "@gond/shared";
import type { BoxAccess } from "./box.ts";
import { getProvider, planSession, providerBaseUrl, providerProxyToken } from "./data/providers.ts";
import { apiInternalUrl } from "./mcp.ts";
import type { NativeAccess } from "./native.ts";

export type EngineRun = { engine: Engine; model: string; access: BoxAccess; native?: NativeAccess };

export function providerFor(engine: Engine, userId: string): EngineProviderKind {
  const info = ENGINE_LABELS[engine];
  return info.providers.find((kind) => getProvider(userId, kind)) ?? info.provider;
}

export class EngineSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineSetupError";
  }
}

export function engineRun(ai: AiSettings, userId: string): EngineRun {
  const engine = ai.engine;
  const config = ai.engines[engine];
  const info = ENGINE_LABELS[engine];

  const model = config.model || info.defaultModel || (engine === "claude" ? DEFAULT_MODEL : "");

  if (!isCliEngine(engine)) {
    const kind = config.provider && info.providers.includes(config.provider) ? config.provider : providerFor(engine, userId);
    const token = providerProxyToken(userId, kind);
    if (!getProvider(userId, kind) || !token) {
      if (kind === "chatgpt") throw new EngineSetupError("Your bots are set to run on your ChatGPT plan, but you haven't signed in. Use Continue with ChatGPT under Settings → AI.");
      if (kind === "grok") throw new EngineSetupError("Your bots are set to run on your Grok plan, but you haven't signed in. Use Sign in with Grok under Settings → AI.");
      throw new EngineSetupError("Your bots are set to run on an API key, but none is saved. Add one under Settings → AI: pick An API key, then add the key.");
    }
    if (isPlanProvider(kind) && !planSession(userId, kind)) throw new EngineSetupError(`Your ${PROVIDER_LABELS[kind].short} sign-in ended. Sign in again under Settings → AI → ${PROVIDER_LABELS[kind].name}.`);
    if (!model) throw new EngineSetupError(isPlanProvider(kind) ? `Pick a model for your ${PROVIDER_LABELS[kind].name} under Settings → AI.` : `Pick a model for the ${PROVIDER_LABELS[kind].short} API under Settings → AI. Calling an API directly needs one; there is no default.`);

    return { engine, model, access: { kind: "plan" }, native: { kind, baseUrl: `${apiInternalUrl()}/api/llm/${kind}`, token, upstream: providerBaseUrl(userId, kind) ?? undefined } };
  }

  if (engine === "claude" && config.access === "api") {
    const token = providerProxyToken(userId, "anthropic");
    if (!getProvider(userId, "anthropic") || !token) throw new EngineSetupError("Your bots are set to run Claude Code on a key, but none is saved. Add an Anthropic-compatible key under Settings → AI, or put Claude Code back on your Claude plan.");
    if (!config.model) throw new EngineSetupError("Pick a model for Claude Code on your key under Settings → AI. A key has no default.");
    // Claude Code's background calls go to the same model: a coding plan's key often serves only one.
    return { engine, model: config.model, access: { kind: "api", baseUrl: `${apiInternalUrl()}/api/llm/anthropic`, token, smallModel: config.model } };
  }

  return { engine, model, access: { kind: "plan" } };
}
