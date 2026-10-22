import { DEFAULT_MODEL, ENGINE_LABELS, PROVIDER_LABELS, isCliEngine, isPlanProvider, type AiSettings, type Engine, type ProviderKind } from "@gond/shared";
import type { BoxAccess } from "./box.ts";
import { getProvider, planSession, providerBaseUrl, providerProxyToken } from "./data/providers.ts";
import { apiInternalUrl } from "./mcp.ts";
import type { NativeAccess } from "./native.ts";
import { isAnthropicHost } from "./routes/llm.ts";

export type EngineRun = { engine: Engine; model: string; access: BoxAccess; native?: NativeAccess };

export function providerFor(engine: Engine, userId: string): ProviderKind {
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
      throw new EngineSetupError("Your bots are set to call an API directly, but no key is saved. Add one under Settings → AI → API keys and switch your bots onto it.");
    }
    if (isPlanProvider(kind) && !planSession(userId, kind)) throw new EngineSetupError(`Your ${PROVIDER_LABELS[kind].short} sign-in ended. Sign in again under Settings → AI → ${PROVIDER_LABELS[kind].name}.`);
    if (!model) throw new EngineSetupError(isPlanProvider(kind) ? `Pick a model for your ${PROVIDER_LABELS[kind].name} under Settings → AI.` : `Pick a model for the ${PROVIDER_LABELS[kind].short} API under Settings → AI. Calling an API directly needs one; there is no default.`);

    return { engine, model, access: { kind: "plan" }, native: { kind, baseUrl: `${apiInternalUrl()}/api/llm/${kind}`, token, upstream: providerBaseUrl(userId, kind) ?? undefined } };
  }

  return { engine, model, access: { kind: "plan" } };
}
