import { DEFAULT_MODEL, ENGINE_LABELS, PROVIDER_LABELS, isCliEngine, type AiSettings, type Engine, type ProviderKind } from "@gond/shared";
import type { BoxAccess } from "./box.ts";
import { chatGptSession, getProvider, providerBaseUrl, providerProxyToken } from "./data/providers.ts";
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
    const kind = config.provider ?? providerFor(engine, userId);
    const token = providerProxyToken(userId, kind);
    if (!getProvider(userId, kind) || !token) {
      throw new EngineSetupError("Your bots are set to call an API directly, but no key is saved. Add one under Settings → AI → API keys and switch your bots onto it.");
    }
    if (kind === "chatgpt" && !chatGptSession(userId)) throw new EngineSetupError("Your ChatGPT sign-in ended. Sign in again under Settings → AI → ChatGPT plan.");
    if (!model) throw new EngineSetupError(kind === "chatgpt" ? "Pick a model for your ChatGPT plan under Settings → AI." : `Pick a model for the ${PROVIDER_LABELS[kind].short} API under Settings → AI. Calling an API directly needs one; there is no default.`);

    return { engine, model, access: { kind: "plan" }, native: { kind, baseUrl: `${apiInternalUrl()}/api/llm/${kind}`, token, upstream: providerBaseUrl(userId, kind) ?? undefined } };
  }

  return { engine, model, access: { kind: "plan" } };
}
