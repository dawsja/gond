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
 * The speech models a voice key runs come from its own model list, never from a list Gond keeps: every
 * version of a family Gond can talk to is offered, newest first, and the newest of the first family the
 * key lists is the default. A family's pattern pins the major version Gond knows, since a new one may
 * talk differently; xAI's realtime voice keeps one protocol, so any version of it is offered. When the key
 * lists none of them, or won't say, the provider's model in `VOICE_MODELS` or `CALL_MODELS` stands in.
 */
export type SpeechJob = "call" | "transcribe";
export type SpeechFamily = { name: string; pattern: RegExp };
export const SPEECH_FAMILIES: Record<VoiceProvider, Record<SpeechJob, SpeechFamily[]>> = {
  openai: {
    call: [
      { name: "GPT-Live", pattern: /^gpt-live-1(?:\.\d+)*$/ },
      { name: "GPT-Realtime", pattern: /^gpt-realtime-2(?:\.\d+)*(?:-mini)?$/ },
    ],
    transcribe: [
      { name: "GPT Transcribe", pattern: /^gpt-transcribe(?:-\d+(?:\.\d+)*)?$/ },
      { name: "GPT-4o and Whisper", pattern: /^(?:gpt-4o(?:-mini)?-transcribe|whisper-1)$/ },
    ],
  },
  xai: {
    call: [{ name: "Grok Voice", pattern: /^grok-voice-\d+(?:\.\d+)*$/ }],
    transcribe: [{ name: "Grok Voice Transcribe", pattern: /^grok-voice-transcribe-\d+(?:\.\d+)*$/ }],
  },
};

/** One job's models, grouped by family, and the one it runs on unless the person picks another. */
export type SpeechModels = { groups: { name: string; models: string[] }[]; default: string };
/**
 * What `/api/voice/models` offers: per job, the models the key lists, its default and the one in use; a
 * server of the person's own (`own`) adds its other ids (`others`) and takes any id for the microphone.
 */
export type VoiceModelList = { call: SpeechModels & { chosen: string }; transcribe: SpeechModels & { chosen: string }; others: string[]; own: boolean };

const versionOf = (id: string) => (id.match(/\d+/g) ?? []).map(Number);

/** Higher versions first (`gpt-live-1.1` before `gpt-live-1`), a plain id before its `-mini`. */
function newerFirst(a: string, b: string): number {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const step = (y[i] ?? -1) - (x[i] ?? -1);
    if (step) return step;
  }
  return a.length - b.length || a.localeCompare(b);
}

export function speechModels(provider: VoiceProvider, job: SpeechJob, listed: readonly string[] | null): SpeechModels {
  const families = SPEECH_FAMILIES[provider][job];
  const groups = families
    .map(({ name, pattern }) => ({ name, models: [...new Set((listed ?? []).filter((id) => pattern.test(id)))].sort(newerFirst) }))
    .filter((group) => group.models.length);
  if (groups.length) return { groups, default: groups[0]!.models[0]! };
  const fallback = job === "call" ? CALL_MODELS[provider].model : VOICE_MODELS[provider].model;
  return { groups: [{ name: families[0]!.name, models: [fallback] }], default: fallback };
}

/**
 * The model a job runs on: the person's pick while the key still offers it, else the default. A server
 * of the person's own keeps any id for the microphone and any family's for calls, since it may not list
 * them; a list that couldn't be read keeps a pick of the provider's own families.
 */
export function chosenModel(provider: VoiceProvider, job: SpeechJob, pick: string | null, listed: readonly string[] | null, own: boolean): string {
  const offered = speechModels(provider, job, listed);
  if (!pick) return offered.default;
  const ours = SPEECH_FAMILIES[provider][job].some(({ pattern }) => pattern.test(pick));
  if (own) return job === "transcribe" || ours ? pick : offered.default;
  return ours && (listed === null || listed.includes(pick)) ? pick : offered.default;
}

/**
 * How a call talks: GPT-Live's own session, full duplex, or the Realtime API, which takes turns and
 * hands work over by a function call, as xAI's does.
 */
export function callProtocol(provider: VoiceProvider, model: string): "live" | "realtime" {
  return provider === "openai" && !/^gpt-realtime/.test(model) ? "live" : "realtime";
}

/** A server of the person's own names its models; OpenAI's and xAI's are only those of `SPEECH_FAMILIES`. */
export type VoiceSettings = {
  /** Null without a voice key. */
  using: VoiceProvider | null;
  /** The microphone's model as picked; null is the default, the newest the key offers. */
  transcribeModel: string | null;
  /** A call's model as picked; null is the default, the newest the key offers. */
  callModel: string | null;
  /** The voice a call speaks in, per provider, since each has its own; missing is the provider's default. */
  callVoice: Partial<Record<VoiceProvider, string>>;
};
export const CALL_VOICE_ID = /^[a-z0-9_-]{1,64}$/i;
export type CallVoice = { id: string; name: string; detail: string | null };
export const VOICE_MODEL_ID = /^[\w.:/@+-]{1,120}$/;
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;
export const TRANSCRIBE_MAX_SECONDS = 120;

/**
 * A live call with the primary bot runs on a speaking model with the person's own key, OpenAI's or
 * xAI's, `model` standing in when the key lists none (`speechModels`). It only talks; anything past small
 * talk it hands to the bot's own turn.
 */
export const CALL_MODELS: Record<VoiceProvider, { model: string; voice: string; label: string }> = {
  xai: { model: "grok-voice-latest", voice: "eve", label: "xAI Grok" },
  openai: { model: "gpt-live-1.1", voice: "marin", label: "OpenAI" },
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
  return callProtocol("openai", model) === "realtime" ? OPENAI_CALL_VOICES.filter((voice) => REALTIME_VOICES.has(voice.id)) : OPENAI_CALL_VOICES;
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
