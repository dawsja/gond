import type { z } from "zod";
import { DEFAULT_MODEL, type Bot } from "./bots.ts";
import type { providerInputSchema } from "./schemas.ts";

export const PROVIDER_KINDS = ["anthropic", "openai", "chatgpt", "grok"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const KEY_PROVIDER_KINDS = ["anthropic", "openai"] as const satisfies readonly ProviderKind[];
export type KeyProviderKind = (typeof KEY_PROVIDER_KINDS)[number];

export const PLAN_PROVIDER_KINDS = ["chatgpt", "grok"] as const satisfies readonly ProviderKind[];
export type PlanProviderKind = (typeof PLAN_PROVIDER_KINDS)[number];

export function isPlanProvider(kind: ProviderKind): kind is PlanProviderKind {
  return (PLAN_PROVIDER_KINDS as readonly string[]).includes(kind);
}

export const CHATGPT_API_URL = "https://api.openai.com/v1";
// A plan's token answers on the Grok CLI's proxy, not the developer API, which bills a key.
export const GROK_API_URL = "https://cli-chat-proxy.grok.com/v1";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export const PROVIDER_LABELS: Record<ProviderKind, { name: string; short: string; detail: string; defaultUrl: string; keyHint: string }> = {
  anthropic: {
    name: "Anthropic-compatible API",
    short: "Anthropic",
    detail: "Anthropic, or anything that speaks its API, like MiniMax.",
    defaultUrl: "https://api.anthropic.com",
    keyHint: "sk-ant-…",
  },
  openai: {
    name: "OpenAI-compatible API",
    short: "OpenAI",
    detail: "OpenAI, xAI, OpenRouter, or any server that speaks their API.",
    defaultUrl: "https://api.openai.com/v1",
    keyHint: "sk-…",
  },
  chatgpt: {
    name: "ChatGPT plan",
    short: "ChatGPT",
    detail: "Your ChatGPT Plus or Pro plan, signed in with ChatGPT. No key needed.",
    defaultUrl: CHATGPT_API_URL,
    keyHint: "",
  },
  grok: {
    name: "Grok plan",
    short: "Grok",
    detail: "Your SuperGrok or X Premium+ plan, signed in with Grok. No key needed.",
    defaultUrl: GROK_API_URL,
    keyHint: "",
  },
};

/** Bearer auth and OpenAI's paths; a plan talks the Responses API on them, a key chat completions. */
export function isOpenAiShaped(kind: ProviderKind): boolean {
  return kind === "openai" || kind === "chatgpt" || kind === "grok";
}

export type ProviderMeta = {
  kind: ProviderKind;
  baseUrl: string;
  account: { email: string | null; name: string | null } | null;

  check: { ok: boolean; detail: string; at: string } | null;
  updatedAt: string;
};
export type ProviderInput = z.infer<typeof providerInputSchema>;

export function isXaiUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "api.x.ai";
  } catch {
    return false;
  }
}

/**
 * Where a bot's pictures are made, best first: a Grok plan is already paid for, then the OpenAI-compatible
 * key, on xAI's images (`xai`) when it points at xAI. A ChatGPT plan can't: OpenAI's Sign in with
 * ChatGPT leaves image generation out.
 */
export const IMAGE_SOURCES = ["grok", "xai", "openai"] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export const IMAGE_MODELS: Record<ImageSource, { model: string; editModel: string; label: string }> = {
  grok: { model: "grok-imagine-image-quality", editModel: "grok-imagine-image-quality", label: "your Grok plan" },
  xai: { model: "grok-imagine-image-2.0", editModel: "grok-imagine-image-2.0", label: "xAI" },
  openai: { model: "gpt-image-2.5-flare", editModel: "gpt-image-2.5-sunburst", label: "OpenAI" },
};
export const IMAGE_ASPECTS = ["square", "portrait", "landscape"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];
/** Each shape as xAI's `aspect_ratio` and OpenAI's `size`, and as columns and rows of the frame drawn while it is made. */
export const IMAGE_SHAPES: Record<ImageAspect, { ratio: string; size: string; columns: number; rows: number }> = {
  square: { ratio: "1:1", size: "1024x1024", columns: 6, rows: 6 },
  portrait: { ratio: "2:3", size: "1024x1536", columns: 6, rows: 9 },
  landscape: { ratio: "3:2", size: "1536x1024", columns: 9, rows: 6 },
};
export const MAX_IMAGE_REFERENCES = 5;

export function isImageAspect(value: unknown): value is ImageAspect {
  return typeof value === "string" && (IMAGE_ASPECTS as readonly string[]).includes(value);
}

export const CLI_ENGINES = ["claude"] as const;
export type CliEngine = (typeof CLI_ENGINES)[number];

export const ENGINES = [...CLI_ENGINES, "chatgpt", "grok", "api"] as const;
export type Engine = (typeof ENGINES)[number];

export function isCliEngine(engine: Engine): engine is CliEngine {
  return (CLI_ENGINES as readonly string[]).includes(engine);
}
export const ENGINE_ACCESS = ["plan", "api"] as const;
export type EngineAccess = (typeof ENGINE_ACCESS)[number];

export type EngineInfo = {
  name: string;
  vendor: string;
  detail: string;

  plan: string;

  signIn: string;

  signInAt: string;

  provider: ProviderKind;

  providers: readonly ProviderKind[];

  defaultModel: string;

  modelHint: string;
};

export const ENGINE_LABELS: Record<Engine, EngineInfo> = {
  claude: {
    name: "Claude Code",
    vendor: "Anthropic",
    detail: "Anthropic's coding agent. Best at long, multi-step work.",
    plan: "Your Claude plan",
    signIn: "claude",
    signInAt: "claude.com",
    provider: "anthropic",
    providers: ["anthropic"],
    defaultModel: DEFAULT_MODEL,
    modelHint: "fable, opus, sonnet, haiku, or a full model id",
  },
  grok: {
    name: "Grok",
    vendor: "xAI",
    detail: "Your Grok plan, signed in with Grok. Gond runs the model itself; your bots still have the computer.",
    plan: "Your Grok plan",
    signIn: "",
    signInAt: "accounts.x.ai",
    provider: "grok",
    providers: ["grok"],
    defaultModel: "",
    modelHint: "Any model your plan lists",
  },
  chatgpt: {
    name: "ChatGPT",
    vendor: "OpenAI",
    detail: "Your ChatGPT plan, signed in with ChatGPT. Gond runs the model itself; your bots still have the computer.",
    plan: "Your ChatGPT plan",
    signIn: "",
    signInAt: "chatgpt.com",
    provider: "chatgpt",
    providers: ["chatgpt"],
    defaultModel: "",
    modelHint: "Any model your plan lists",
  },
  api: {
    name: "API",
    vendor: "your API",
    detail: "Gond calls your key itself. Nothing to sign in to; your bots still have the computer. MCP servers need a CLI.",
    plan: "Your API key",
    signIn: "",
    signInAt: "",
    provider: "anthropic",
    providers: ["anthropic", "openai"],
    defaultModel: "",
    modelHint: "claude-sonnet-5-5, or any model your key lists",
  },
};

export type ModelChoice = { id: string; name?: string; detail?: string; default?: boolean };

export type ModelGroup = {
  engine: Engine;
  models: ModelChoice[];
  source: "engine" | "provider" | "none";
  detail: string | null;
};

/** The engine the bots run on now, where its models come from (`modelSource`) and the model picked in Settings → AI. */
export type ModelCurrent = { engine: Engine; source: string; model: string };

export type ModelList = { groups: ModelGroup[]; current?: ModelCurrent };

/**
 * Where a model id means something: the engine and the plan or API behind it. A bot's own model is
 * kept with the source it was picked on, so moving the AI elsewhere never sends an id the new one
 * doesn't know.
 */
export function modelSource(engine: Engine, access: EngineAccess, provider: ProviderKind | null): string {
  if (isCliEngine(engine)) return `${engine}:${access}`;
  return engine === "api" ? `api:${provider ?? ""}` : engine;
}

export function botModelFor(bot: Pick<Bot, "model" | "modelFor"> | null | undefined, source: string): string {
  return bot?.model && bot.modelFor === source ? bot.model : "";
}

export type EngineSettings = { access: EngineAccess; model: string; provider?: ProviderKind | null };

/** A model id, or none; `[1m]` at the end is Claude Code's own mark for a model's 1M-token context. */
export const MODEL_ID_PATTERN = /^(?:[A-Za-z0-9._:/-]{1,120}(?:\[1m\])?)?$/;

export const DEFAULT_ENGINES: Record<Engine, EngineSettings> = {
  claude: { access: "plan", model: DEFAULT_MODEL },
  grok: { access: "api", model: "", provider: "grok" },
  chatgpt: { access: "api", model: "", provider: "chatgpt" },
  api: { access: "api", model: "", provider: null },
};

export type Onboarding = {
  done: boolean;

  templates: string[];
};

export type Settings = {
  onboarding: Onboarding;
  timezone: string;
};

export type AiSettings = {
  engine: Engine;

  enabled: Engine[];

  engines: Record<Engine, EngineSettings>;
};

export const DEFAULT_AI: AiSettings = { engine: "claude", enabled: ["claude"], engines: DEFAULT_ENGINES };

export const ENGINE_SIGN_IN_STATES = ["starting", "waiting", "finishing", "done", "failed"] as const;
export type EngineSignInState = (typeof ENGINE_SIGN_IN_STATES)[number];
export type EngineSignIn = {
  engine: Engine;
  state: EngineSignInState;

  url: string | null;

  needsCode: boolean;

  error: string | null;
  startedAt: string;
};
