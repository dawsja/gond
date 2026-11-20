import type { z } from "zod";
import { DEFAULT_MODEL, type Bot } from "./bots.ts";
import type { providerInputSchema } from "./schemas.ts";

export const PROVIDER_KINDS = ["anthropic", "openai", "chatgpt", "grok", "voice"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** The APIs a person types a key for their bots; a ChatGPT or Grok plan is signed in to instead. */
export const KEY_PROVIDER_KINDS = ["anthropic", "openai"] as const satisfies readonly ProviderKind[];
export type KeyProviderKind = (typeof KEY_PROVIDER_KINDS)[number];

/** A plan a person signs in to, whose tokens Gond keeps and renews; each is an engine of its own. */
export const PLAN_PROVIDER_KINDS = ["chatgpt", "grok"] as const satisfies readonly ProviderKind[];
export type PlanProviderKind = (typeof PLAN_PROVIDER_KINDS)[number];

/** What a bot can run on: every kind of key but the voice key, which only the microphone and calls use. */
export type EngineProviderKind = Exclude<ProviderKind, "voice">;

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
  voice: {
    name: "Voice key",
    short: "voice",
    detail: "OpenAI's API or xAI's, for the microphone and calls. Your bots never use it.",
    defaultUrl: "https://api.openai.com/v1",
    keyHint: "sk-… or xai-…",
  },
};

/** Bearer auth and OpenAI's paths; a plan talks the Responses API on them, a key chat completions. */
export function isOpenAiShaped(kind: ProviderKind): boolean {
  return kind === "openai" || kind === "chatgpt" || kind === "grok" || kind === "voice";
}

export type ProviderMeta = {
  kind: ProviderKind;
  baseUrl: string;
  /** The account a plan is signed in with; null for a key. */
  account: { email: string | null; name: string | null } | null;

  check: { ok: boolean; detail: string; at: string } | null;
  updatedAt: string;
};
export type ProviderInput = z.infer<typeof providerInputSchema>;

/**
 * Whose speech endpoints the person's voice key reaches: xAI's own (`stt`, `realtime`, `tts`) when it
 * points at xAI, OpenAI's anywhere else.
 */
export const VOICE_PROVIDERS = ["xai", "openai"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
export const VOICE_MODELS: Record<VoiceProvider, { path: string; model: string; label: string }> = {
  xai: { path: "stt", model: "grok-voice-transcribe-2.0", label: "xAI Grok" },
  openai: { path: "audio/transcriptions", model: "gpt-transcribe", label: "OpenAI" },
};

export function isXaiUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "api.x.ai";
  } catch {
    return false;
  }
}

/**
 * An OpenAI speech model a person can pick, with what it's for and its price as OpenAI's docs and pricing
 * page put them on `VOICE_PRICES_AS_OF`, since its API lists only ids. One past `retires` (an ISO date,
 * OpenAI's shutdown) gives way to the recommended one.
 */
export type VoiceModel = { id: string; name: string; about: string; price: string; recommended?: boolean; retires?: string };
export const VOICE_PRICES_AS_OF = "2026-10-29";

/** For the microphone, on `audio/transcriptions`. `hints` takes the chat's names as keywords. */
export const OPENAI_TRANSCRIBE_MODELS: (VoiceModel & { hints?: boolean })[] = [
  { id: "gpt-transcribe", name: "GPT Transcribe", about: "OpenAI's most accurate. It takes the names in the chat as hints, so it spells them right.", price: "$0.0045 a minute", recommended: true, hints: true },
  { id: "gpt-4o-mini-transcribe", name: "GPT-4o mini Transcribe", about: "Cheaper, and a little less accurate.", price: "About $0.003 a minute", retires: "2027-02-26" },
  { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe", about: "OpenAI's accurate one before GPT Transcribe.", price: "About $0.006 a minute", retires: "2027-02-26" },
  { id: "whisper-1", name: "Whisper", about: "The original. Plain transcripts with no hints.", price: "$0.006 a minute", retires: "2027-02-26" },
];

/**
 * For calls. `live` is GPT-Live's own session, full duplex; `realtime` is the Realtime API, which takes
 * turns and hands work over by a function call, as xAI's does.
 */
export const OPENAI_CALL_MODELS: (VoiceModel & { protocol: "live" | "realtime" })[] = [
  { id: "gpt-live-1", name: "GPT-Live", about: "OpenAI's most natural voice. It listens while it talks, so interrupting it feels like a real conversation.", price: "$0.05 a minute", recommended: true, protocol: "live" },
  {
    id: "gpt-realtime-2.1",
    name: "GPT-Realtime 2.1",
    about: "Takes turns rather than talking over you, and is steadier with spelled-out names, numbers and noisy rooms. Fewer voices.",
    price: "$32 per million audio tokens in, $64 out, plus $0.0045 a minute to write down what you say",
    protocol: "realtime",
  },
  {
    id: "gpt-realtime-2.1-mini",
    name: "GPT-Realtime 2.1 mini",
    about: "The cheapest. Quick, and a little less sharp than 2.1. Fewer voices.",
    price: "$10 per million audio tokens in, $20 out, plus $0.0045 a minute to write down what you say",
    protocol: "realtime",
  },
];

/** What `/api/voice/models` offers: the catalog's models the key lists, and a server of the person's own its own ids. */
export type VoiceModelList = { transcribe: VoiceModel[]; call: VoiceModel[]; others: string[] };

export function isRetired(model: { retires?: string }, at = Date.now()): boolean {
  return Boolean(model.retires && Date.parse(model.retires) <= at);
}

/** `openaiModel` is for an OpenAI-compatible server that names its own models, like a local Whisper. */
export type VoiceSettings = {
  /** Null without a voice key. */
  using: VoiceProvider | null;
  openaiModel: string;
  /** The model a call on OpenAI runs on, one of `OPENAI_CALL_MODELS`. */
  callModel: string;
  /** The voice a call speaks in, per provider, since each has its own; missing is the provider's default. */
  callVoice: Partial<Record<VoiceProvider, string>>;
};
export const CALL_VOICE_ID = /^[a-z0-9_-]{1,64}$/i;
export type CallVoice = { id: string; name: string; detail: string | null };
export const VOICE_MODEL_ID = /^[\w.:/@+-]{1,120}$/;
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;
export const TRANSCRIBE_MAX_SECONDS = 120;

/**
 * A live call with the primary bot runs on a speaking model with the person's own key: OpenAI's
 * (GPT-Live unless they picked another of `OPENAI_CALL_MODELS`) or xAI's realtime voice. It only talks;
 * anything past small talk it hands to the bot's own turn.
 */
export const CALL_MODELS: Record<VoiceProvider, { model: string; voice: string; label: string }> = {
  xai: { model: "grok-voice-latest", voice: "eve", label: "xAI Grok" },
  openai: { model: "gpt-live-1", voice: "marin", label: "OpenAI" },
};
/**
 * GPT-Live's voices, from OpenAI's docs, since its API has no list to ask (xAI's does: `GET /v1/tts/voices`).
 * Marin and Cedar first: OpenAI's best, and Marin its default.
 */
export const OPENAI_CALL_VOICES: CallVoice[] = [
  { id: "marin", name: "Marin", detail: null },
  { id: "cedar", name: "Cedar", detail: null },
  ...["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), detail: null })),
  ...(
    [
      ["quartz", "Australian, feminine"],
      ["ripple", "Australian, masculine"],
      ["vesper", "British, masculine"],
      ["willow", "Irish, feminine"],
      ["stone", "Irish, masculine"],
      ["gleam", "North American, feminine"],
      ["meridian", "North American, masculine"],
      ["delta", "Southern U.S., feminine"],
      ["cinder", "Southern U.S., masculine"],
      ["beacon", "Filipino, masculine"],
      ["bossa", "Portuguese, feminine"],
      ["tempo", "Portuguese, masculine"],
      ["nuri", "German, feminine"],
      ["juni", "German, feminine"],
      ["flitz", "German, masculine"],
      ["brise", "French, feminine"],
      ["sillage", "French, masculine"],
      ["nira", "Hindi, feminine"],
      ["harema", "Japanese, feminine"],
      ["shida", "Japanese, masculine"],
      ["noeul", "Korean, feminine"],
    ] as const
  ).map(([id, detail]) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), detail })),
];
/** The Realtime API's voices; GPT-Live has these and more. */
const REALTIME_VOICES = new Set(["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]);

/** The voices an OpenAI call model speaks in. */
export function openAiCallVoices(model: string): CallVoice[] {
  const realtime = OPENAI_CALL_MODELS.find((candidate) => candidate.id === model)?.protocol === "realtime";
  return realtime ? OPENAI_CALL_VOICES.filter((voice) => REALTIME_VOICES.has(voice.id)) : OPENAI_CALL_VOICES;
}

/** Both sides of a call are mono 16-bit PCM at this rate. */
export const CALL_SAMPLE_RATE = 24_000;
export const CALL_MAX_MINUTES = 60;
export type CallInfo = { id: string; threadId: string; botId: string; provider: VoiceProvider; startedAt: string };
/** What a call's stream tells the page: its audio and how it ends. The words are never shown; a call is heard. */
export type CallEvent = { type: "ready" } | { type: "audio"; data: string } | { type: "interrupt" } | { type: "ended"; reason: string | null };

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

  provider: EngineProviderKind;

  providers: readonly EngineProviderKind[];

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
export function modelSource(engine: Engine, access: EngineAccess, provider: EngineProviderKind | null): string {
  if (isCliEngine(engine)) return `${engine}:${access}`;
  return engine === "api" ? `api:${provider ?? ""}` : engine;
}

/** The model a bot runs on: its own while it was picked where the AI runs now, else the AI's. */
export function botModelFor(bot: Pick<Bot, "model" | "modelFor"> | null | undefined, source: string): string {
  return bot?.model && bot.modelFor === source ? bot.model : "";
}

export type EngineSettings = { access: EngineAccess; model: string; provider?: EngineProviderKind | null };

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
