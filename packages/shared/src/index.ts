import { z } from "zod";

export const BOT_EXPRESSIONS = ["happy", "wink", "surprised"] as const;
export type BotExpression = (typeof BOT_EXPRESSIONS)[number];
// The cog is the Gond bot and always the default; the rest are other bodies with the same eyes.
export const BOT_SHAPES = ["cog", "gumdrop", "cloud", "circle", "triangle"] as const;
export type BotShape = (typeof BOT_SHAPES)[number];
export const BOT_SHAPE_LABELS: Record<BotShape, string> = { cog: "Cog", gumdrop: "Gumdrop", cloud: "Cloud", circle: "Circle", triangle: "Triangle" };

export const BOT_COLORS = ["#E04E0A", "#2F6FD6", "#D03A3A", "#D98A08", "#7650D8", "#CF3D85", "#11998A", "#189C47", "#0B8EC8", "#D8620F"] as const;

export const APPROVAL_LEVELS = ["ask", "auto", "full"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const APPROVAL_LEVEL_LABELS: Record<ApprovalLevel, { title: string; detail: string }> = {
  ask: { title: "Always ask", detail: "Every shell command, file outside its own folder and connected-app action waits for you." },
  auto: { title: "Auto", detail: "It carries on with routine work and asks before anything it can't undo or that leaves the computer: sending, deleting, paying, forcing." },
  full: { title: "Always allow", detail: "Nothing asks. Only for a bot you trust with the computer and your apps." },
};

export const DEFAULT_MODEL = "opus";

export const BOT_LIMITS = {
  name: 40,
  title: 80,
  description: 4000,
} as const;

const botFields = z.object({
  name: z.string().trim().min(1).max(BOT_LIMITS.name),

  title: z.string().trim().max(BOT_LIMITS.title),

  description: z.string().trim().max(BOT_LIMITS.description),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  expression: z.enum(BOT_EXPRESSIONS),
  shape: z.enum(BOT_SHAPES),
  approval: z.enum(APPROVAL_LEVELS),

  notify: z.boolean(),
});

export const botInputSchema = botFields.extend({
  title: botFields.shape.title.default(""),
  description: botFields.shape.description.default(""),
  color: botFields.shape.color.default(BOT_COLORS[0]),
  expression: botFields.shape.expression.default("happy"),
  shape: botFields.shape.shape.default("cog"),
  approval: botFields.shape.approval.default("auto"),
  notify: botFields.shape.notify.default(true),
});

/**
 * A change to some of a bot's fields; the rest stay as they are. Not
 * `botInputSchema.partial()`: with zod 4 that fills every missing field
 * with its default, so pinning a bot would have made it forget its job.
 */
export const botPatchSchema = botFields.partial();
export type BotInput = z.infer<typeof botInputSchema>;

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type Bot = BotInput & {
  id: string;
  /** A picture the person uploaded, shown in a circle instead of the mascot. */
  avatar: string | null;

  userId: string;

  threadId: string;

  primary: boolean;
  hidden: boolean;
  pinned: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export const THREAD_KINDS = ["bot", "room"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export type Thread = {
  id: string;

  userId: string;
  kind: ThreadKind;

  botId: string | null;
  name: string;

  members: string[];
  /** A room pinned to the top of the list; a bot's conversation follows its bot's own `pinned`. */
  pinned: boolean;

  /** The latest line between the person and the bot or room; what bots said to each other here never counts. */
  lastMessage: { author: string; body: string; at: string } | null;
  /** Unread lines for the person. */
  unread: number;
  /** Bots wrote to each other here since the person last looked, and nothing new is for them. */
  unreadTeam: boolean;
  /** What a watch's latest run said, while the person hasn't read it yet. */
  noticed: { watch: string; body: string; at: string } | null;
  /** A room shared with people on other Gonds: who is there from where. Null for any other conversation. */
  space: ThreadSpace | null;
  createdAt: string;
  updatedAt: string;
};

export type MessageAuthor = "you" | "system" | "routine" | string;

/**
 * What one bot tells another with message_bot: an `action` wakes it to act on the note and answer with
 * what it did; `info` only lets it know ("my part is done") and wakes nobody.
 */
export const NOTE_KINDS = ["action", "info"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === "string" && (NOTE_KINDS as readonly string[]).includes(value);
}

export const MESSAGE_KINDS = ["message", "event", "activity", "approval", "secret", "prompt", "signin", "teach", "control"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** What a person or a bot can put on a message, one each: the chat's own tapbacks. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];

export function isReaction(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTIONS as readonly string[]).includes(value);
}

/** One reaction on a message: `author` is "you" or a bot's id, like a message's. */
export type Reaction = { author: MessageAuthor; emoji: ReactionEmoji };

export type ChatAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
};

export type Message = {
  id: string;
  threadId: string;
  author: MessageAuthor;
  kind: MessageKind;
  body: string;
  attachments: ChatAttachment[];

  depth: number;

  approvalId: string | null;

  fromThreadId: string | null;

  steered: boolean;
  /** Said out loud on a call: the person's words as heard, or what the bot's voice said. Kept for the bot, never shown. */
  spoken: boolean;
  /** A note between bots: an action the bot it reaches must act on, or information that needs nothing. */
  note: NoteKind | null;
  /** In a room, the bots Gond's router judged a person's unnamed line was for; null when the line named them or nothing was routed. */
  sentTo: string[] | null;

  reactions: Reaction[];
  /** The message this one answers, quoted: who wrote it and its first words, or its first file's name. */
  replyTo: Quote | null;
  /** For a bot's line, the message it answered, which in a space may be someone's on another Gond. */
  answering?: string | null;
  createdAt: string;
};

export type Quote = { id: string; author: MessageAuthor; text: string };

export const QUOTE_CHARS = 280;

/** How a bot reads a reply: `(replying to Patch: "…") ` ahead of the person's words. */
export function replyLine(quote: Quote | null, nameOf: (author: MessageAuthor) => string): string {
  return quote ? `(replying to ${nameOf(quote.author)}: "${quote.text.slice(0, 200)}${quote.text.length > 200 ? "…" : ""}") ` : "";
}

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const MAX_SENT_FILE_BYTES = 100 * 1024 * 1024;

export function mediaTypeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return FILE_TYPES[ext] ?? "application/octet-stream";
}

const FILE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", xml: "application/xml",
  zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg", mp4: "video/mp4", wav: "audio/wav",
};

export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json", "image/svg+xml"] as const;

export const APPROVAL_STATUSES = ["pending", "allowed", "denied", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type Approval = {
  id: string;
  botId: string;
  threadId: string;

  tool: string;

  summary: string;

  input: Record<string, unknown>;
  status: ApprovalStatus;

  rule: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** How an email card ended past yes or no: sent from a draft, saved as one, or sent back with changes asked. */
  outcome: ApprovalOutcome | null;
  /** The person changed the letter on the card before it went; `input` is what went. */
  edited: boolean;
  /** What the person said when they turned it down ("make it less formal"). */
  note: string | null;
  /** The draft this one redrafts after the person asked for changes, to mark what changed. */
  revises: { tool: string; input: Record<string, unknown> } | null;
};

export type ApprovalOutcome = "sent" | "saved" | "changes";

export const MAX_APPROVAL_NOTE = 2000;

const editedList = z.array(z.string().trim().min(3).max(320)).max(50);

export const emailEditSchema = z.object({
  to: editedList,
  cc: editedList,
  bcc: editedList,
  subject: z.string().max(998),
  body: z.string().max(100_000),
});

export type EmailEdit = z.infer<typeof emailEditSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "always"]),
  /** On a draft's card: send it rather than leave it saved. */
  send: z.boolean().optional(),
  /** On an email's card: the letter as the person changed it. */
  edit: emailEditSchema.optional(),
  /** With a deny: what to change, told to the bot. */
  note: z.string().trim().min(1).max(MAX_APPROVAL_NOTE).optional(),
});

export type ApprovalAnswer = z.infer<typeof approvalDecisionSchema>;

export type Routine = {
  id: string;
  botId: string;
  name: string;

  cron: string;
  timezone: string;

  prompt: string;
  enabled: boolean;
  /** A watch checks for a change and speaks up only when there is one worth telling; its runs show as "<bot> noticed". */
  watch: boolean;
  /** A reminder: it runs the next time its cron matches, then removes itself. */
  once: boolean;
  skillId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const routineFields = z.object({
  name: z.string().trim().min(1).max(80),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(64),
  prompt: z.string().trim().min(1).max(4000),
  enabled: z.boolean(),
  watch: z.boolean(),

  skillId: z.string().trim().max(40).nullable(),
});
export const routineInputSchema = routineFields.extend({
  timezone: routineFields.shape.timezone.default("UTC"),
  enabled: routineFields.shape.enabled.default(true),
  watch: routineFields.shape.watch.default(false),
  skillId: routineFields.shape.skillId.default(null),
});

export const routinePatchSchema = routineFields.partial();

/** What `bot.json` in a `.bot` file says: a bot's job and look and its routines, never its memory, secrets or chats. */
export const BOT_TEMPLATE_FORMAT = "gond.bot/1";

export const botTemplateSchema = z.object({
  format: z.literal(BOT_TEMPLATE_FORMAT),
  name: botFields.shape.name,
  title: botFields.shape.title.default(""),
  description: botFields.shape.description.default(""),
  color: botFields.shape.color.default(BOT_COLORS[0]),
  expression: botFields.shape.expression.default("happy"),
  shape: botFields.shape.shape.default("cog"),
  approval: botFields.shape.approval.default("auto"),
  routines: z
    .array(z.object({ name: routineFields.shape.name, cron: routineFields.shape.cron, prompt: routineFields.shape.prompt, watch: z.boolean().default(false), skill: z.string().trim().max(80).nullable().default(null) }))
    .max(20)
    .default([]),
});

export type BotTemplateFile = z.infer<typeof botTemplateSchema>;

/** A template as the person sees it before adding it: who the bot is and what comes with it. */
export type BotTemplateSummary = Pick<BotTemplateFile, "name" | "title" | "description" | "color" | "expression" | "shape"> & { picture: boolean; skills: string[]; routines: string[] };
export type RoutineInput = z.infer<typeof routineInputSchema>;

export type AppCatalogEntry = { toolkit: string; name: string; icon: string; category: string; logo?: string; description?: string };

export type CatalogPage = { apps: AppCatalogEntry[]; total: number; page: number; pages: number };

export const CATALOG_PAGE_SIZE = 12;

export function appLogoUrl(toolkit: string) {
  return `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`;
}

export const APP_CATALOG: AppCatalogEntry[] = [
  { toolkit: "gmail", name: "Gmail", icon: "gmail", category: "Email" },
  { toolkit: "outlook", name: "Outlook", icon: "outlook", category: "Email" },
  { toolkit: "googlecalendar", name: "Google Calendar", icon: "googlecalendar", category: "Calendar" },
  { toolkit: "googledrive", name: "Google Drive", icon: "googledrive", category: "Files" },
  { toolkit: "googledocs", name: "Google Docs", icon: "googledocs", category: "Docs" },
  { toolkit: "googlesheets", name: "Google Sheets", icon: "googlesheets", category: "Files" },
  { toolkit: "googleslides", name: "Google Slides", icon: "googleslides", category: "Docs" },
  { toolkit: "googletasks", name: "Google Tasks", icon: "googletasks", category: "Work" },
  { toolkit: "googlemeet", name: "Google Meet", icon: "googlemeet", category: "Meetings" },
  { toolkit: "github", name: "GitHub", icon: "github", category: "Code" },
  { toolkit: "notion", name: "Notion", icon: "notion", category: "Docs" },
  { toolkit: "slack", name: "Slack", icon: "slack", category: "Chat" },
  { toolkit: "gitlab", name: "GitLab", icon: "gitlab", category: "Code" },
  { toolkit: "supabase", name: "Supabase", icon: "supabase", category: "Code" },
  { toolkit: "alpaca", name: "Alpaca", icon: "alpaca", category: "Finance" },
];

export const CURATED_TOOLKITS: ReadonlySet<string> = new Set(APP_CATALOG.map((app) => app.toolkit));

export type Connection = {
  toolkit: string;
  name: string;

  accountId: string;
  status: "active" | "pending" | "failed";
  createdAt: string;
};

export type ComposioKeyStatus = { source: "own" | "server" | null };

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type SignInProvider = "local" | "oidc";

/** How a person signs in: a password, and whether the organisation's provider is linked to this account (null when none is set up). */
export type SignIns = { password: boolean; oidc: { name: string; linked: boolean } | null };

export type Me = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  provider: SignInProvider;

  avatar: string | null;
  accent: Accent;
  style: ReplyStyle;
  emoji: EmojiLevel;
};

/** How every bot of a person's talks to them (Settings → Personalization), read into each bot's prompt. */
export const REPLY_STYLES = ["default", "professional", "friendly", "candid", "efficient"] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number];
export const REPLY_STYLE_LABELS: Record<ReplyStyle, { title: string; blurb: string }> = {
  default: { title: "Default", blurb: "Each bot's own voice" },
  professional: { title: "Professional", blurb: "Polished and precise" },
  friendly: { title: "Friendly", blurb: "Warm and chatty" },
  candid: { title: "Candid", blurb: "Direct and encouraging" },
  efficient: { title: "Efficient", blurb: "Concise and plain" },
};

export function isReplyStyle(value: unknown): value is ReplyStyle {
  return typeof value === "string" && (REPLY_STYLES as readonly string[]).includes(value);
}

export const EMOJI_LEVELS = ["more", "default", "less"] as const;
export type EmojiLevel = (typeof EMOJI_LEVELS)[number];
export const EMOJI_LEVEL_LABELS: Record<EmojiLevel, string> = { more: "More", default: "Default", less: "Less" };

export function isEmojiLevel(value: unknown): value is EmojiLevel {
  return typeof value === "string" && (EMOJI_LEVELS as readonly string[]).includes(value);
}

/** The color a person picks for their chats (Settings → Appearance): their bubbles, cards and main buttons. */
export const ACCENTS = ["blue", "purple", "pink", "red", "orange", "amber", "green"] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "blue";

export const ACCENT_LABELS: Record<Accent, string> = { blue: "Blue", purple: "Purple", pink: "Pink", red: "Red", orange: "Orange", amber: "Amber", green: "Green" };

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

export type UserSummary = Me & { createdAt: string; bots: number };

export const OIDC_PROVIDER_ID = "oidc";

export const MOBILE_SIGN_IN_CALLBACK = "gond://sign-in";

export const SIGN_IN_APPS = ["android", "ios", "desktop"] as const;
export type SignInApp = (typeof SIGN_IN_APPS)[number];
export const OIDC_DEFAULT_SCOPES = "openid profile email";

export type OidcSettings = {
  enabled: boolean;

  name: string;

  issuer: string;
  clientId: string;

  scopes: string;
  hasClientSecret: boolean;
  updatedAt: string | null;
};

export const oidcPatchSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(40).optional(),
  issuer: z.string().trim().url().max(500).optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().max(2000).optional(),
  scopes: z.string().trim().max(200).optional(),
});
export type OidcPatch = z.infer<typeof oidcPatchSchema>;

export type AuthConfig = {
  local: boolean;
  oidc: { enabled: boolean; name: string } | null;
};

export const PROVIDER_KINDS = ["anthropic", "openai", "xai", "chatgpt", "grok"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** The APIs a person types a key for; a ChatGPT or Grok plan is signed in to instead. */
export const KEY_PROVIDER_KINDS = ["anthropic", "openai", "xai"] as const satisfies readonly ProviderKind[];
export type KeyProviderKind = (typeof KEY_PROVIDER_KINDS)[number];

/** A plan a person signs in to, whose tokens Gond keeps and renews; each is an engine of its own. */
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
    detail: "OpenAI, OpenRouter, or any server that speaks their API.",
    defaultUrl: "https://api.openai.com/v1",
    keyHint: "sk-…",
  },
  xai: {
    name: "xAI API",
    short: "xAI",
    detail: "xAI's own API.",
    defaultUrl: "https://api.x.ai/v1",
    keyHint: "xai-…",
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
  return kind === "openai" || kind === "xai" || kind === "chatgpt" || kind === "grok";
}

export type ProviderMeta = {
  kind: ProviderKind;
  baseUrl: string;
  /** The account a plan is signed in with; null for a key. */
  account: { email: string | null; name: string | null } | null;

  check: { ok: boolean; detail: string; at: string } | null;
  updatedAt: string;
};

export const providerInputSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => /^https?:\/\/[^\s/]+/i.test(value), "The URL starts with http:// or https://"),

  apiKey: z.string().trim().min(8, "That key looks too short").max(8_000).optional(),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

/** Cheapest first: "auto" takes the first one the person has a key for. */
export const VOICE_PROVIDERS = ["xai", "openai"] as const satisfies readonly ProviderKind[];
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
export const VOICE_MODELS: Record<VoiceProvider, { path: string; model: string; label: string }> = {
  xai: { path: "stt", model: "grok-voice-transcribe-2.0", label: "xAI Grok" },
  openai: { path: "audio/transcriptions", model: "gpt-transcribe", label: "OpenAI" },
};
export const VOICE_PREFERENCES = ["auto", ...VOICE_PROVIDERS] as const;
export type VoicePreference = (typeof VOICE_PREFERENCES)[number];
/** `openaiModel` is for an OpenAI-compatible server that names its own models, like a local Whisper. */
export type VoiceSettings = {
  preference: VoicePreference;
  using: VoiceProvider | null;
  available: VoiceProvider[];
  openaiModel: string;
  /** The voice a call speaks in, per provider, since each has its own; missing is the provider's default. */
  callVoice: Partial<Record<VoiceProvider, string>>;
};
export const CALL_VOICE_ID = /^[a-z0-9_-]{1,64}$/i;
export type CallVoice = { id: string; name: string; detail: string | null };
export const VOICE_MODEL_ID = /^[\w.:/@+-]{1,120}$/;
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;
export const TRANSCRIBE_MAX_SECONDS = 120;

export function isVoicePreference(value: unknown): value is VoicePreference {
  return typeof value === "string" && (VOICE_PREFERENCES as readonly string[]).includes(value);
}

/** A chosen provider whose key is gone falls back to the cheapest one left. */
export function pickVoiceProvider(preference: VoicePreference, has: (kind: VoiceProvider) => boolean): VoiceProvider | null {
  if (preference !== "auto" && has(preference)) return preference;
  return VOICE_PROVIDERS.find(has) ?? null;
}

/**
 * A live call with the primary bot runs on a speaking model with the person's own key: OpenAI's
 * GPT-Live or xAI's realtime voice. It only talks; anything past small talk it hands to the bot's own turn.
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

/** Both sides of a call are mono 16-bit PCM at this rate. */
export const CALL_SAMPLE_RATE = 24_000;
export const CALL_MAX_MINUTES = 60;
export type CallInfo = { id: string; threadId: string; botId: string; provider: VoiceProvider; startedAt: string };
/** What a call's stream tells the page: its audio and how it ends. The words are never shown; a call is heard. */
export type CallEvent = { type: "ready" } | { type: "audio"; data: string } | { type: "interrupt" } | { type: "ended"; reason: string | null };

/**
 * Where a bot's pictures are made, best first: a Grok plan is already paid for, then the cheaper key.
 * A ChatGPT plan can't: OpenAI's Sign in with ChatGPT leaves image generation out.
 */
export const IMAGE_SOURCES = ["grok", "xai", "openai"] as const satisfies readonly ProviderKind[];
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
    providers: ["anthropic", "openai", "xai"],
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

export type ModelList = { groups: ModelGroup[] };

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

export type ClaudeStatus = {
  status: "ok" | "missing" | "unauthenticated" | "error" | "no-box";
  detail: string;
  email?: string | null;
};

export type BoxStatus = {
  configured: boolean;
  reachable: boolean;

  updating: boolean;

  claude: ClaudeStatus;

  composio: { configured: boolean; connected: number };

  agents: { id: string; running: boolean; busy: boolean }[];

  versions: { node: string | null; bun: string | null; claude: string | null } | null;
};

export type BoxUpdatePhase = "idle" | "pausing" | "pulling" | "restarting" | "resetting" | "patching" | "resuming" | "done" | "failed";

export const BOX_UPDATE_PHASE_LABELS: Record<BoxUpdatePhase, string> = {
  idle: "Up to date as far as we know",
  pausing: "Pausing the computer",
  pulling: "Pulling the newest image",
  restarting: "Restarting on the new image",
  resetting: "Wiping the computer and rebuilding it",
  patching: "Patching Debian, Bun and Claude Code",
  resuming: "Bringing the computer back",
  done: "Updated",
  failed: "Update failed",
};

/** Updating Gond itself from Settings → About: the step it is on. */
export type ServerUpdatePhase = "idle" | "pulling" | "computer" | "web" | "server" | "done" | "failed";

export type ServerUpdate = {
  /** The version this server runs, "dev" when it wasn't built by a release. */
  current: string;
  latest: string | null;
  available: boolean;
  /** What changed since `current`, one line each, from the commits between the two releases. */
  notes: string[];
  /** Why this server can't update itself, when it can't (no Docker socket, say). */
  blocked: string | null;
  phase: ServerUpdatePhase;
  error: string | null;
};

/** Whether release `a` (1.2.3, with or without a v) is newer than `b`; anything that isn't one never is. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

export type BoxUpdate = {
  phase: BoxUpdatePhase;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  error: string | null;

  pulled: boolean;

  patched: boolean;

  kind: "update" | "reset";
};

export type WorkStep = {
  id: string;
  kind: "command" | "file" | "tool" | "note";

  title: string;

  detail: string | null;

  output: string | null;
  status: "running" | "done" | "failed";

  quiet?: boolean;
  at: string;
};

export const WORK_OUTPUT_MAX = 8_000;

export const WORK_STEPS_MAX = 200;

/** "Show me how": how long a person can show a bot one task. */
export const TEACH_MAX_MINUTES = 10;

/**
 * Where showing a bot how stands: offered on a card, being shown (or paused), waiting for the
 * person to hide what they typed outside the browser (review), the bot looking at it, its draft
 * on the card (ready), then saved as a skill, discarded or failed.
 */
export const TEACH_STATUSES = ["offered", "recording", "paused", "review", "looking", "ready", "saved", "discarded", "failed"] as const;
export type TeachStatus = (typeof TEACH_STATUSES)[number];

/** One thing the person did while showing a bot, as the computer recorded it. */
export type TeachStep = {
  n: number;
  /** Milliseconds from the start of the recording. */
  at: number;
  kind: string;
  layer: "browser" | "desktop";
  label: string;
  url?: string;
  app?: string;
  /** The screenshot taken just after it, by number, if one was. */
  frame: number | null;
  /** Typed outside the browser, where a password can't be told from a command. */
  outside?: boolean;
  /** What was typed or pasted, for a step that typed. */
  text?: string;
  sensitive?: string;
  skipped?: boolean;
  hidden?: boolean;
};

/** A note the person added while showing, after a step. */
export type TeachNote = { after: number; text: string; at: number };

/** What the bot made of it: the skill it would save, in the words the card shows. */
export type TeachDraft = {
  name: string;
  description: string;
  steps: { text: string; shows: number | null }[];
  /** What changes each time it runs, like the month. */
  changes: string[];
  /** What it needs from the person, like a saved sign-in. */
  needs: string[];
  /** The skill's instructions, in full. */
  instructions: string;
};

export type Teaching = {
  id: string;
  botId: string;
  threadId: string;
  status: TeachStatus;
  steps: TeachStep[];
  notes: TeachNote[];
  activeMs: number;
  maxMs: number;
  pausedFor: "person" | "away" | null;
  startedAt: string | null;
  endedAt: string | null;
  endedWhy: string | null;
  frames: number;
  full: boolean;
  draft: TeachDraft | null;
  previous: TeachDraft | null;
  error: string | null;
  skillSlug: string | null;
  createdAt: string;
};

/**
 * Spaces: rooms shared with people and their bots on other Gond servers, carried end to end
 * encrypted by gond-relay (packages/relay). A space is a room on each Gond in it; the Gond that made
 * it hosts it and passes every line on to the others.
 */
export const GOND_RELAY_URL = "https://api.gond.io";

/** A line written on another Gond, by its person or one of its bots, carries this before the member's id. */
export const REMOTE_AUTHOR = "remote:";

export function isRemoteAuthor(author: string): boolean {
  return author.startsWith(REMOTE_AUTHOR);
}

/** What one of your bots may do for a line written on another Gond. */
export const SPACE_LEVELS = ["talk", "look", "act"] as const;
export type SpaceLevel = (typeof SPACE_LEVELS)[number];

export const SPACE_LEVEL_LABELS: Record<SpaceLevel, { label: string; blurb: string }> = {
  talk: { label: "Talk only", blurb: "Answers from what's said in the space. No web, no tools." },
  look: { label: "Look things up", blurb: "Can search the web and read pages. Never your accounts, files or the computer." },
  act: { label: "Do things, with my OK", blurb: "What they ask comes to you as a card first. On a yes, your bot does it with its tools." },
};

/** Your bot's rules in one space, which only you see and set. */
/**
 * `peopleWake`: the people on the other Gonds can wake the bot by naming it (on unless the person turns it
 * off); `botsWake`: their bots can. `relay`: the bot may say something in the space when its own person
 * asks it to in their chat with it.
 */
export type SpaceRule = { botId: string; level: SpaceLevel; memory: boolean; peopleWake: boolean; botsWake: boolean; relay: boolean };

export type SpaceMember = { id: string; kind: "person" | "bot"; name: string; color: string | null; gond: string };

export type SpaceGond = {
  key: string;
  name: string;
  /** Six words made from the Gond's key, which both people read out to check nobody swapped it. */
  words: string[];
  verified: boolean;
  host: boolean;
};

export const SPACE_STATUSES = ["joining", "active", "left", "closed"] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];

/** What a conversation needs to draw a space: the other Gonds and who is there from them. */
export type ThreadSpace = { id: string; host: boolean; status: SpaceStatus; gonds: SpaceGond[]; members: SpaceMember[] };

/** A space's details, with your bots' rules in it. */
export type Space = ThreadSpace & { threadId: string; rules: SpaceRule[] };

export type FederationState = "off" | "connecting" | "ready" | "closed" | "replaced";

/** This Gond and other Gonds: on the admin's Settings → Other Gonds, and what everyone needs to invite and join. */
export type Federation = {
  enabled: boolean;
  name: string;
  relay: "gond" | "own";
  relayUrl: string;
  invites: "everyone" | "admin";
  state: FederationState;
  /** This Gond's own six words; null until it has keys. */
  words: string[] | null;
  /** Whether the person asking may make invites and join spaces now. */
  canInvite: boolean;
};

export type FederationPeer = { key: string; name: string; words: string[]; verified: boolean; blocked: boolean; lastSeen: string | null; spaces: number };

/** Each person's defaults for their bots in spaces. `bots` lists who may join (none until picked); null means every bot, new ones too. */
export type SpaceDefaults = { level: SpaceLevel; bots: string[] | null };

export type SpaceInvitePreview = {
  name: string;
  host: { key: string; name: string; words: string[] };
  members: { name: string; kind: "person" | "bot"; color: string | null }[];
  expires: string;
};

export type LiveEvent =

  | { topic: "bots"; userId?: string }
  /** A message landed on a thread, or (cleared) every message was removed. */
  | { topic: "thread"; threadId: string; cleared?: true }
  /** A message's reactions changed: all of them as they now stand. */
  | { topic: "reactions"; threadId: string; messageId: string; reactions: Reaction[] }
  /** A bot's live activity while it works: the line, or null when the turn ended. */
  | { topic: "activity"; threadId: string; botId: string; line: string | null }
  /**
   * The reply a bot is writing for the person, as far as it has got (already redacted), or null when
   * it stopped: posted, or it was narration before a tool call.
   */
  | { topic: "writing"; threadId: string; botId: string; text: string | null }
  /** A step of a bot's work began or finished: the step as it now stands (see WorkStep). */
  | { topic: "work"; threadId: string; botId: string; step: WorkStep }
  /** Approvals changed. */
  | { topic: "approvals" }
  /** Routines or connections changed. */
  | { topic: "settings" }
  /** The computer's update moved a step. */
  | { topic: "box" }
  /** Your own profile (name, picture) changed. */
  | { topic: "me"; userId: string }
  /** Your AI settings or API keys changed. */
  | { topic: "ai"; userId: string }
  /** Your skills library changed. */
  | { topic: "skills"; userId: string }
  /** One of your chat exports moved on: as it now stands, or gone. */
  | { topic: "exports"; userId: string; export: ChatExport | null; id: string }
  /**
   * A bot finished a job for you or needs you: what the API just sent as a
   * push notification, for a client without Web Push (the Android app)
   * to show on its own. Quiet when that conversation is in front of you.
   */
  | { topic: "notify"; userId: string; title: string; body: string; url: string; tag: string; threadId: string }
  /** Your desktop on the computer: who is driving it, and whether it is up. */
  | { topic: "desktop"; userId: string; desktop: DesktopState }
  /** Something you're showing a bot, or showed it, as it now stands. */
  | { topic: "teaching"; userId: string; teaching: Teaching }
  /** Spaces changed: this Gond's connection, a space joined or left. Without a userId, everyone's. */
  | { topic: "spaces"; userId?: string }
  /** What your bots used, or how much of your plan is left, changed. */
  | { topic: "usage"; userId: string }
  /**
   * A picture a bot is making: its shape at once, a rough preview's URL when the API sends one,
   * then done, with the attachment it was posted as, or failed.
   */
  | { topic: "picture"; threadId: string; botId: string; id: string; aspect: ImageAspect; state: "making" | "preview" | "done" | "failed"; preview: string | null; file: string | null };

/** Where a turn's tokens came from: "claude" is Claude Code on the person's Claude plan, the rest a provider. */
export type UsageSource = "claude" | ProviderKind;

export const USAGE_RANGES = ["month", "week", "today"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export function isUsageRange(value: unknown): value is UsageRange {
  return typeof value === "string" && (USAGE_RANGES as readonly string[]).includes(value);
}

/** A plan's window: what share of it is left, 0 to 100, and when it starts again. */
export type PlanWindow = { name: "session" | "weekly" | "monthly"; left: number; resetsAt: string | null };

export type UsageReport = {
  /** What the bots run on now, and the host of its key when it is one. */
  source: UsageSource;
  host: string | null;
  /** How much is left, null when the provider doesn't share it; checkedAt is when it was last read. */
  windows: PlanWindow[] | null;
  checkedAt: string | null;
  /** This month on what the bots run on now; cost only where the provider says what it billed. */
  month: { tokens: number; cost: number | null };
  range: UsageRange;
  /** Each bot in the range, every source together; a bot since deleted keeps its id. */
  bots: { botId: string | null; tokens: number; cost: number | null }[];
};

export const SKILL_LIMITS = {
  name: 60,
  slug: 40,
  description: 1024,
  instructions: 60_000,

  files: 200,
  path: 200,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
} as const;

const skillFields = z.object({
  name: z.string().trim().min(1).max(SKILL_LIMITS.name),

  description: z.string().trim().max(SKILL_LIMITS.description),

  instructions: z.string().trim().min(1).max(SKILL_LIMITS.instructions),
});
export const skillInputSchema = skillFields.extend({ description: skillFields.shape.description.default("") });

export const skillPatchSchema = skillFields.partial();
export type SkillInput = z.infer<typeof skillInputSchema>;

export type SkillFile = {
  path: string;
  size: number;

  executable: boolean;

  text: boolean;
};

export type Skill = SkillInput & {
  id: string;

  slug: string;

  source: "written" | "bot" | "packaged" | "imported";

  files: SkillFile[];
  createdAt: string;
  updatedAt: string;
};

export function skillFilePath(given: string): string | null {
  const parts = given.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.startsWith(".") || /[\u0000-\u001f]/.test(part))) return null;
  const clean = parts.join("/");
  if (clean.length > SKILL_LIMITS.path || clean === "SKILL.md") return null;
  return clean;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.slug) || "skill";
}

export function skillMentions(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]{0,39})\b/g)) out.add(match[1]!);
  return [...out];
}

export const PACKAGED_SKILLS: { id: string; name: string; description: string; instructions: string }[] = [
  {
    id: "morning-briefing",
    name: "Morning briefing",
    description: "What changed overnight and what needs the person today, in one short note.",
    instructions: [
      "# Morning briefing",
      "",
      "Goal: one short note the person reads with their first coffee.",
      "",
      "Steps:",
      "1. Gather what changed since yesterday: the inbox and calendar if you have them, the team's open handoffs, anything a routine left for you.",
      "2. Sort by what needs the person today, what is waiting on someone else, and what is just news.",
      "3. Write at most eight lines. Lead with decisions and deadlines. Link to the source of each item.",
      "",
      "Rules:",
      "- Never send anything on the person's behalf; this is a read-only job.",
      "- If nothing changed, say so in one line.",
      "- Note anything you could not reach (an app that failed, an expired session).",
    ].join("\n"),
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sort new mail into needs-reply, waiting, FYI and noise, with draft replies for the first group.",
    instructions: [
      "# Inbox triage",
      "",
      "Goal: the person opens their inbox knowing what matters and finds drafts ready where a reply is due.",
      "",
      "Steps:",
      "1. Read unread mail from the last 24 hours (or since the last run).",
      "2. Label each thread: needs a reply, waiting on someone else, FYI, or noise. Newsletters and notifications are noise unless the person asked otherwise.",
      "3. For needs-a-reply, write a draft in the person's voice and save it as a draft; never send.",
      "4. Report: a table of needs-a-reply with the draft's first line, then counts for the rest.",
      "",
      "Rules:",
      "- Sending, archiving or deleting mail waits for approval.",
      "- Keep drafts short; a question deserves an answer, not an essay.",
    ].join("\n"),
  },
  {
    id: "bug-repro-pack",
    name: "Bug repro pack",
    description: "Turn a bug report into a reproduction: steps, environment, evidence, and a suggested cause.",
    instructions: [
      "# Bug repro pack",
      "",
      "Goal: an engineer can start fixing without asking a question.",
      "",
      "Steps:",
      "1. Read the report and pull out the expected and actual behaviour.",
      "2. Reproduce it on the computer: clone the repo if there is one, run the app, follow the steps. Save screenshots and console output in your home under repro/<ticket>/.",
      "3. Narrow it: the smallest input that still fails, the first version or commit where it fails if you can bisect quickly.",
      "4. Write the pack: title, steps, environment, evidence (paths to files), suspected cause with file and line, and what you tried.",
      "",
      "Rules:",
      "- Filing the ticket or commenting on it waits for approval.",
      "- Say clearly when you could not reproduce it, and what you tried.",
    ].join("\n"),
  },
  {
    id: "weekly-expense-summary",
    name: "Weekly expense summary",
    description: "Match receipts to charges, flag the unmatched, and nudge owners.",
    instructions: [
      "# Weekly expense summary",
      "",
      "Goal: by Monday morning, every charge of the week has a receipt or an owner who was asked for one.",
      "",
      "Steps:",
      "1. Pull the week's charges from the connected source (a sheet, an export, or mail from the card provider).",
      "2. Match each to a receipt by amount, merchant and date. Keep a list of the unmatched.",
      "3. For each unmatched charge, draft a one-line nudge to its owner. Sending waits for approval.",
      "4. Report: totals by category, the unmatched list, and who was nudged.",
      "",
      "Rules:",
      "- Never guess an owner; leave it unmatched and say so.",
      "- Round to whole units in the summary; keep exact amounts in the sheet.",
    ].join("\n"),
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description: "A one-page brief before a meeting: who, why, what happened last time, and what to ask.",
    instructions: [
      "# Meeting prep",
      "",
      "Goal: a page the person reads in two minutes on the way in.",
      "",
      "Steps:",
      "1. From the calendar entry, find the people, the company and the stated purpose.",
      "2. Search mail, notes and the CRM (whatever you have) for the last three interactions.",
      "3. Write: attendees with one line each, the purpose, what happened last time, open items, and three questions worth asking.",
      "",
      "Rules:",
      "- Read-only. Never message attendees.",
      "- Mark anything you inferred rather than read.",
    ].join("\n"),
  },
];

export const MCP_TRANSPORTS = ["http", "stdio"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const mcpServerInputSchema = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/i, "Letters, digits, dashes and underscores"),
  transport: z.enum(MCP_TRANSPORTS),

  url: z.string().trim().url().max(500).optional(),

  headers: z.record(z.string().max(100), z.string().max(4000)).default({}),

  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).default([]),
  env: z.record(z.string().max(100), z.string().max(4000)).default({}),
  enabled: z.boolean().default(true),

  oauthRedirect: z.enum(["app", "localhost"]).optional(),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

export function joinCommandLine(words: string[]): string {
  return words.map((w) => (w && !/[\s"'\\]/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(" ");
}

export const COMPOSIO_CARD = "composio:";

export function composioCard(toolkit: string): string {
  return `${COMPOSIO_CARD}${toolkit}`;
}

export function composioCardToolkit(id: string | null | undefined): string | null {
  return id?.startsWith(COMPOSIO_CARD) ? id.slice(COMPOSIO_CARD.length) : null;
}

export const MCP_OAUTH_REDIRECTS = ["app", "localhost"] as const;
export type McpOAuthRedirect = (typeof MCP_OAUTH_REDIRECTS)[number];

export const MCP_LOOPBACK_PORT = 47651;
export const MCP_LOOPBACK_CALLBACK = `http://localhost:${MCP_LOOPBACK_PORT}/callback`;

export const DESKTOP_SIGN_IN_CALLBACK = `http://localhost:${MCP_LOOPBACK_PORT}/sign-in`;

const LOOPBACK_HOSTS = ["agent.robinhood.com"];

export function defaultOAuthRedirect(url: string | undefined): McpOAuthRedirect {
  try {
    return url && LOOPBACK_HOSTS.includes(new URL(url).hostname) ? "localhost" : "app";
  } catch {
    return "app";
  }
}

export type McpAuthStatus = "none" | "needed" | "signed_in" | "error";

export type McpServer = McpServerInput & {
  id: string;
  oauthRedirect: McpOAuthRedirect;
  authStatus: McpAuthStatus;

  authError: string | null;
  createdAt: string;
  updatedAt: string;
  refreshedAt: string | null;
};

export const SECRET_REF = /\{\{\s*secret:([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;

const KEY_HEADER = /auth|token|key|secret|password|cookie/i;

/** A header that carries a key, like Authorization: then the server is reached with that key, never an OAuth sign-in, and a 401 means the key was turned down. */
export function isKeyHeader(name: string): boolean {
  return KEY_HEADER.test(name);
}

export function hasKeyHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(isKeyHeader);
}

export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SecretMeta = {
  name: string;

  requestedBy: string | null;

  site: string | null;
  /** A saved payment card: what it is called and the little of it that may be shown. Null for any other secret. */
  card: CardMeta | null;
  createdAt: string;
  updatedAt: string;
};

export type SecretRequest = {
  id: string;
  botId: string;
  threadId: string;
  name: string;
  reason: string;

  target: "secret" | "composio" | "login" | "card";
  /** The card replaces a secret the person already has: its value is overwritten, never shown. */
  replaces: boolean;

  site: string | null;
  fields: LoginField[];
  /** A card request's total, as the bot said it, and the card the person paid with once they did. */
  total: string | null;
  card: string | null;
  status: "pending" | "given" | "declined" | "expired";
  createdAt: string;
  resolvedAt: string | null;
};

/** A saved card as it may be shown: never more of the number than its last four digits. */
export type CardMeta = { nickname: string; brand: string; last4: string; expires: string };

export type CardDetails = { number: string; expiry: string; cvc: string; name: string; zip: string };

/** What a bot types from the card the person picked, by these names, as with a sign-in's details. */
export const CARD_FIELDS = {
  CARD_NUMBER: "the card number",
  CARD_EXPIRY: "the expiry as MM/YY",
  CARD_MONTH: "the expiry month, MM",
  CARD_YEAR: "the expiry year, YYYY",
  CARD_CVC: "the security code",
  CARD_NAME: "the name on the card",
  CARD_ZIP: "the billing ZIP or postal code",
} as const;
export type CardField = keyof typeof CARD_FIELDS;

export function isCardField(name: string): name is CardField {
  return Object.hasOwn(CARD_FIELDS, name);
}

export const CARD_NICKNAME_MAX = 40;

const digitsOf = (value: string) => value.replace(/[\s-]/g, "");

export function luhnValid(number: string): boolean {
  if (!/^\d{12,19}$/.test(number)) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i += 1) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function cardBrand(number: string): string {
  const n = digitsOf(number);
  if (/^4/.test(n)) return "Visa";
  if (/^3[47]/.test(n)) return "Amex";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return "Mastercard";
  if (/^(6011|65|64[4-9])/.test(n)) return "Discover";
  return "Card";
}

/** "08/28", "0828", "8/2028" and the like as month and two-digit year; null when it isn't one. */
export function parseExpiry(value: string): { month: string; year: string } | null {
  const match = /^\s*(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})\s*$/.exec(value);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  return { month: String(month).padStart(2, "0"), year: match[2]!.slice(-2) };
}

/** A card the person typed, checked and tidied, or what is wrong with it in words; `partial` lets an empty field stand. */
export function checkCard(input: Partial<Record<keyof CardDetails, unknown>>, partial = false): { card: Partial<CardDetails> } | { error: string } {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const card: Partial<CardDetails> = {};
  const number = digitsOf(text(input.number));
  if (number || !partial) {
    if (!luhnValid(number)) return { error: "That card number doesn't look right. Check it and try again." };
    card.number = number;
  }
  const expiry = text(input.expiry);
  if (expiry || !partial) {
    const parsed = parseExpiry(expiry);
    if (!parsed) return { error: "Type the expiry as MM/YY, like 08/28." };
    card.expiry = `${parsed.month}/${parsed.year}`;
  }
  const cvc = text(input.cvc);
  if (cvc || !partial) {
    if (!/^\d{3,4}$/.test(cvc)) return { error: "The security code is the 3 or 4 digits on the card." };
    card.cvc = cvc;
  }
  const name = text(input.name);
  if (name.length > 100) return { error: "That name is too long." };
  if (name || !partial) card.name = name;
  const zip = text(input.zip);
  if (zip.length > 12) return { error: "That ZIP or postal code is too long." };
  if (zip || !partial) card.zip = zip;
  return { card };
}

/** A card's value for one of the names a bot types it by. */
export function cardFieldValue(card: CardDetails, field: CardField): string {
  const [month = "", year = ""] = card.expiry.split("/");
  switch (field) {
    case "CARD_NUMBER":
      return card.number;
    case "CARD_EXPIRY":
      return card.expiry;
    case "CARD_MONTH":
      return month;
    case "CARD_YEAR":
      return year ? `20${year}` : "";
    case "CARD_CVC":
      return card.cvc;
    case "CARD_NAME":
      return card.name;
    case "CARD_ZIP":
      return card.zip;
  }
}

/** "Personal Visa", or the card's own name when the person gave none. */
export function cardLabel(meta: CardMeta): string {
  return meta.nickname || `${meta.brand} ending ${meta.last4}`;
}

const LOOSE_PARTS: Record<string, keyof CardDetails> = {
  NUMBER: "number",
  NUM: "number",
  EXPIRY: "expiry",
  EXP: "expiry",
  EXPIRATION: "expiry",
  EXPIRES: "expiry",
  CVV: "cvc",
  CVC: "cvc",
  CVV2: "cvc",
  CODE: "cvc",
  ZIP: "zip",
  POSTAL: "zip",
  ZIPCODE: "zip",
  NAME: "name",
};

/**
 * Keys that are one card split up, as a bot asked for them before there were cards: SONIC_CARD_NUMBER,
 * _EXPIRY, _CVV and _ZIP. A group needs at least the number, expiry and code.
 */
export function looseCards(names: string[]): { prefix: string; parts: Partial<Record<keyof CardDetails, string>> }[] {
  const groups = new Map<string, Partial<Record<keyof CardDetails, string>>>();
  for (const name of names) {
    const match = /^(.*CARD)_([A-Z0-9]+)$/.exec(name);
    const part = match ? LOOSE_PARTS[match[2]!] : undefined;
    if (!match || !part) continue;
    const parts = groups.get(match[1]!) ?? {};
    parts[part] ??= name;
    groups.set(match[1]!, parts);
  }
  return [...groups].filter(([, parts]) => parts.number && parts.expiry && parts.cvc).map(([prefix, parts]) => ({ prefix, parts }));
}

export const LOGIN_FIELD_KINDS = ["email", "username", "phone", "password", "code"] as const;
export type LoginFieldKind = (typeof LOGIN_FIELD_KINDS)[number];

export type LoginField = {
  name: string;
  label: string;
  kind: LoginFieldKind;
};

export const LOGIN_FIELD_LABELS: Record<LoginFieldKind, string> = {
  email: "Email",
  username: "Username",
  phone: "Phone number",
  password: "Password",
  code: "Code",
};

/** What a saved sign-in detail is, from the end of its name: "UBER_EATS_PASSWORD" is PASSWORD, a second code CODE_2. */
export function loginDetailOf(name: string): string | null {
  return /_((?:EMAIL|USERNAME|PHONE|PASSWORD|CODE)(?:_\d+)?)$/.exec(name)?.[1] ?? null;
}

/**
 * Which of one site's saved details fills each field, by its kind and count; an email and a
 * username stand in for each other, since a page's "Email or username" is either. A code is never
 * saved, so it is never covered. Fields left out are for the person to type.
 */
export function coverLogin(fields: LoginField[], saved: string[]): Map<string, string> {
  const details = new Map<string, string>();
  for (const name of saved) {
    const detail = loginDetailOf(name);
    if (detail && !details.has(detail)) details.set(detail, name);
  }
  const swap: Partial<Record<string, string>> = { EMAIL: "USERNAME", USERNAME: "EMAIL" };
  const counts = new Map<LoginFieldKind, number>();
  const used = new Set<string>();
  const found = new Map<string, string>();
  for (const field of fields) {
    const count = (counts.get(field.kind) ?? 0) + 1;
    counts.set(field.kind, count);
    if (field.kind === "code") continue;
    const kind = field.kind.toUpperCase();
    const suffix = count > 1 ? `_${count}` : "";
    const name = [kind, swap[kind]].map((k) => (k ? details.get(`${k}${suffix}`) : undefined)).find((n) => n && !used.has(n));
    if (!name) continue;
    used.add(name);
    found.set(field.name, name);
  }
  return found;
}

/**
 * The services a person can send their notices to besides their browsers and apps, one at a time.
 * Each field is what the service needs; a `secret` one is stored encrypted and never sent back, so
 * the form shows it empty and leaving it empty keeps what was saved.
 */
export const NOTIFY_SERVICE_KINDS = ["ntfy", "pushover", "discord", "telegram", "gotify", "webhook"] as const;
export type NotifyServiceKind = (typeof NOTIFY_SERVICE_KINDS)[number];

export type NotifyField = {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  secret?: boolean;
  optional?: boolean;
  options?: readonly { value: string; label: string }[];
  initial?: string;
};

export const NOTIFY_SERVICES: Record<NotifyServiceKind, { name: string; blurb: string; color: string; fields: readonly NotifyField[] }> = {
  ntfy: {
    name: "ntfy",
    blurb: "The ntfy app on your phone, on ntfy.sh or your own server.",
    color: "#338574",
    fields: [
      { key: "server", label: "Server", placeholder: "https://ntfy.sh", initial: "https://ntfy.sh" },
      { key: "topic", label: "Topic", placeholder: "gond-yourname-7k2", help: "Subscribe to it in the ntfy app. On ntfy.sh anyone who knows a topic can read it, so make it hard to guess." },
      { key: "token", label: "Access token", placeholder: "Only for a protected topic", secret: true, optional: true },
      {
        key: "priority",
        label: "Priority",
        initial: "3",
        options: [
          { value: "2", label: "Low" },
          { value: "3", label: "Normal" },
          { value: "4", label: "High" },
          { value: "5", label: "Urgent" },
        ],
      },
    ],
  },
  pushover: {
    name: "Pushover",
    blurb: "The Pushover app on your phone.",
    color: "#249DF1",
    fields: [
      { key: "user", label: "User key", placeholder: "From your Pushover dashboard", secret: true },
      { key: "token", label: "Application token", placeholder: "Create one at pushover.net/apps", secret: true },
      {
        key: "priority",
        label: "Priority",
        initial: "0",
        options: [
          { value: "-1", label: "Quiet" },
          { value: "0", label: "Normal" },
          { value: "1", label: "High" },
        ],
      },
    ],
  },
  discord: {
    name: "Discord",
    blurb: "A message in a Discord channel.",
    color: "#5865F2",
    fields: [{ key: "url", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", help: "In the channel's settings: Integrations, then Webhooks, then New Webhook.", secret: true }],
  },
  telegram: {
    name: "Telegram",
    blurb: "A message from your own Telegram bot.",
    color: "#27A7E7",
    fields: [
      { key: "token", label: "Bot token", placeholder: "From @BotFather", secret: true },
      { key: "chat", label: "Chat ID", placeholder: "123456789", help: "Message your bot once, then ask @userinfobot for your ID, or use a group's ID." },
    ],
  },
  gotify: {
    name: "Gotify",
    blurb: "Your own Gotify server and its app.",
    color: "#2D6BCB",
    fields: [
      { key: "server", label: "Server", placeholder: "https://gotify.example.com" },
      { key: "token", label: "App token", placeholder: "From Apps in Gotify", secret: true },
      {
        key: "priority",
        label: "Priority",
        initial: "5",
        options: [
          { value: "2", label: "Low" },
          { value: "5", label: "Normal" },
          { value: "8", label: "High" },
        ],
      },
    ],
  },
  webhook: {
    name: "Webhook",
    blurb: "Any address that takes a POST: Gond sends the title, the message and a link as JSON.",
    color: "#4B4B4B",
    fields: [{ key: "url", label: "URL", placeholder: "https://example.com/hooks/gond", secret: true }],
  },
};

export function isNotifyServiceKind(value: unknown): value is NotifyServiceKind {
  return typeof value === "string" && (NOTIFY_SERVICE_KINDS as readonly string[]).includes(value);
}

/** A person's notification service as the web sees it: what isn't secret, and which secrets are saved. */
export type NotifyService = {
  kind: NotifyServiceKind;
  enabled: boolean;
  details: Record<string, string>;
  saved: string[];
  lastSentAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type BotTemplate = {
  id: string;
  name: string;
  title: string;
  tagline: string;
  color: string;
  expression: BotExpression;
  description: string;
  routine?: { name: string; cron: string; prompt: string };
};

/** One entry of a folder in a bot's home, as the Files section lists it. */
export type BotFileEntry = { name: string; dir: boolean; size: number; modified: string | null };

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    id: "assistant",
    name: "Assistant",
    title: "Assistant",
    tagline: "Your always-on assistant. Reads what changed and what needs you, and briefs the others.",
    color: "#7650D8",
    expression: "wink",
    description:
      "Own the outcome of what the person asks. Scan the connected channels, inbox, calendar and notes for what is new and what maps to their priorities; for each item give the source, why it matters, the proposed next step, and whether they owe a decision. Coordinate the other bots when a job fits one of them, and return one consolidated answer. Never send messages or change meetings without approval.",
    routine: { name: "Morning briefing", cron: "0 8 * * 1-5", prompt: "Review activity since yesterday across my connected channels, inbox and calendar. Return only items that map to my priorities, each with the source, why it matters, the proposed next step, and whether I owe a decision." },
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    title: "Sales Outbound",
    tagline: "Researches accounts overnight, drafts outreach in your voice, and leaves a review list.",
    color: "#E04E0A",
    expression: "happy",
    description:
      "Own account research, contact prioritisation and review-ready outreach. Score accounts against the ideal customer profile and recent intent, find up to three relevant contacts per account, and draft email outreach in the person's voice. Skip anyone already in an active sequence. Always return a review list; never send or enrol anyone yourself.",
  },
  {
    id: "inbox-manager",
    name: "Inbox Manager",
    title: "Inbox Manager",
    tagline: "Triages email into clear categories, surfaces what's urgent, drafts replies.",
    color: "#2F6FD6",
    expression: "surprised",
    description:
      "Keep the inbox usable. Triage new mail into categories, surface urgent and blocked threads, and draft replies and clean-up. Every send stays behind approval. Report what changed in a few lines, newest first.",
    routine: { name: "Inbox triage", cron: "0 9,13,17 * * 1-5", prompt: "Triage everything new in the inbox since the last run. List urgent and blocked threads first, then drafts waiting for my approval." },
  },
  {
    id: "talent-scout",
    name: "Talent Scout",
    title: "Talent Scout",
    tagline: "Sources candidates, drafts outreach, preps scheduling.",
    color: "#11998A",
    expression: "wink",
    description:
      "Own sourcing, candidate research, outreach drafts and scheduling preparation. For a role, find candidates who meet the must-have criteria, explain the evidence for each match, and draft personalised outreach in the person's voice. Never contact anyone without approval. Respect candidate privacy and source terms.",
  },
  {
    id: "expense-manager",
    name: "Expense Manager",
    title: "Expense Manager",
    tagline: "Builds the weekly expense summary, matches receipts, nudges owners.",
    color: "#D98A08",
    expression: "happy",
    description:
      "Own weekly expense reconciliation and missing-information follow-up. Build the week's summary, match receipts from the inbox, flag missing categories or policy exceptions with a policy citation, and draft one follow-up per owner. Return the summary and drafts; never send messages or change reimbursements.",
    routine: { name: "Weekly expense summary", cron: "0 9 * * 1", prompt: "Build last week's expense summary: totals that reconcile, receipts matched, exceptions with policy citations, and one follow-up draft per owner." },
  },
  {
    id: "bug-reproduction",
    name: "Bug Reproduction",
    title: "Bug Reproduction",
    tagline: "Turns reports into repro packs: steps, screenshots, console notes.",
    color: "#D03A3A",
    expression: "surprised",
    description:
      "Turn bug reports into reliable reproduction packs. Read the report, reproduce it in a staging environment or a fresh clone in your home folder, and return exact steps, expected and actual behaviour, screenshots, environment details, relevant console or network notes, and a minimal test case when possible. Never use production customer data.",
  },
  {
    id: "product-performance",
    name: "Product Performance",
    title: "Product Performance",
    tagline: "Investigates performance questions with evidence and links.",
    color: "#0B8EC8",
    expression: "happy",
    description:
      "Investigate product-performance questions using the connected observability and source tools. Preserve links and screenshots, separate evidence from hypotheses, and return a short write-up with the highest-impact issue first. Never change alerts or production settings.",
  },
  {
    id: "account-health",
    name: "Account Health",
    title: "Account Health",
    tagline: "Turns portfolio noise into a ranked watch list before the QBR.",
    color: "#CF3D85",
    expression: "wink",
    description:
      "Review the accounts in the portfolio. Combine usage, support escalations, renewal timing and stakeholder activity into a ranked watch list; for each account include the evidence, why it matters, and a suggested next step. Never contact customers or edit the CRM without approval.",
  },
];

export const BOT_NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi", "Biscuit", "Pepper", "Clover", "Ember",
  "Willow", "Comet", "Orbit", "Echo", "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl", "Quill", "Rocket", "Sunny", "Tango",
  "Vega", "Waffle", "Ziggy", "Noodle", "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
] as const;

export function pickBotName(taken: Iterable<string>, random = Math.random): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  const base = BOT_NAMES[Math.floor(random() * BOT_NAMES.length)]!;
  for (let i = 2; ; i += 1) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}

export const MENTION = /(?<![\w@])@([a-z0-9][a-z0-9_-]{0,39})/gi;

export function mentionsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) seen.add(match[1]!.toLowerCase());
  return [...seen];
}

export function handleOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "");
}

type RoomMember = { id: string; name: string; primary: boolean };
type RoomLine = { author: string; kind: string; body: string; sentTo?: string[] | null };

/** Who answers a room when nothing says otherwise: the primary bot if it's there, else the first bot. */
export function roomAnswerer<B extends RoomMember>(members: B[]): B | null {
  return members.find((b) => b.primary) ?? members[0] ?? null;
}

/**
 * How many bots a room holds: two at least, since one is a 1:1, and six at most, past which it is slow
 * (only `TURNS_PER_PERSON` of a person's bots answer at once) and too noisy to follow.
 */
export const ROOM_MIN_BOTS = 2;
export const ROOM_MAX_BOTS = 6;

/** A room's name when the person gives it none: its bots, the one that answers first in front ("Pip, Net and Patch", "Pip, Net, Patch and 4 more"). */
export function roomNameFor(members: RoomMember[]): string {
  const first = roomAnswerer(members);
  const names = (first ? [first, ...members.filter((b) => b !== first)] : members).map((b) => b.name);
  if (names.length <= 1) return names[0] ?? "Room";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

// Words that speak to the whole room wherever they stand.
const PLURAL_YOU = /\b(?:all of you|each of you|every one of you|y'?all|you all|you guys)\b/i;
// "everyone" speaks to the room unless it is what a verb or a preposition acts on: "tell everyone", "for everyone".
const EVERYONE = /(?<!\b(?:tell|inform|notify|message|ping|remind|update|let|show|ask|thank|give|send|cc|for|to|with|from|about|on|of)\s+)\b(?:everyone|everybody)\b/i;
// "all", "guys", "team" and the like only as a greeting or a sign-off: "Hey all!", "howdy guys", "thanks guys", "status, team?".
const GREETING = "hey|hi|hiya|heya|hello|howdy|yo|sup|ok|okay|so|alright|cool|great|awesome|nice|thanks|thank you|thx|ty|morning|good morning|afternoon|good afternoon|evening|good evening|night|good night";
const GROUP = "all|guys|team|folks|gang|crew|fellas|bots";
const VOCATIVE = new RegExp(`^\\s*(?:(?:${GREETING})[\\s,!.]+)*(?:${GROUP})\\b|,\\s*(?:${GROUP})\\s*[?.!]*\\s*$`, "i");
// A group word that ends the line speaks to it too, comma or not ("ily guys", "thanks team!"), unless
// it is what the line acts on ("ask the team", "restart the bots"). Never "all": "that's all" names nobody.
const SIGN_OFF = /(?<!\b(?:the|my|our|your|a|this|that|to|for|with|tell|ask|ping|message|restart|stop|check)\s+)\b(?:guys|team|folks|gang|crew|fellas|bots|everyone|everybody)\s*[?.!]*\s*$/i;
const BOTH = /\b(?:both|you two)\b/i;

/** The members a line names, by @handle or by name as a word in any case ("Patch, are you…", or "patch" as voice types it). */
function namedIn<B extends RoomMember>(text: string, members: B[]): B[] {
  const handles = mentionsIn(text);
  return members.filter((b) => handles.includes(handleOf(b.name)) || new RegExp(`(?<![\\w@])${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i").test(text));
}

/**
 * The members a person's message in a room speaks to: those it names, or the room as a whole
 * ("everyone, …", "you guys", "each of you", "hey all", or "both" in a room of two). "Tell
 * everyone" is about the room, not to it.
 */
export function addressedIn<B extends RoomMember>(text: string, members: B[]): B[] {
  const handles = mentionsIn(text);
  if (handles.includes("everyone") || handles.includes("all") || PLURAL_YOU.test(text) || EVERYONE.test(text) || VOCATIVE.test(text) || SIGN_OFF.test(text) || (members.length === 2 && BOTH.test(text))) return members;
  return namedIn(text, members);
}

/**
 * Who a person's message in a room is for: whoever it names; else whom the person's own last line
 * named, since that is who they are talking to even when others joined in since; else, while bots
 * are still answering, them and those that answered since the person last wrote (`working`, bot
 * ids), so the line reaches the exchange in flight; else the one bot that spoke last; else whom an
 * earlier line of theirs addressed; else `roomAnswerer`, the primary bot when it is there. With
 * nobody named, one bot answers, never the room. `before` is the room's messages before this one,
 * oldest first.
 */
export function roomTargets<B extends RoomMember>(body: string, members: B[], before: RoomLine[], working: readonly string[] = []): B[] {
  const named = addressedIn(body, members);
  if (named.length) return named;
  const previous = before.findLast((line) => line.kind === "message" && line.author === "you");
  // Only bots named by name, or picked by the router, carry over: a line to the whole room hands on to whoever answered it.
  const routed = previous?.sentTo ? members.filter((b) => previous.sentTo!.includes(b.id)) : [];
  if (routed.length) return routed;
  const talkingTo = previous ? namedIn(previous.body, members) : [];
  if (talkingTo.length && addressedIn(previous!.body, members).length === talkingTo.length) return talkingTo;
  const busy = members.filter((b) => working.includes(b.id));
  const answered: B[] = [];
  const next = () => (busy.length ? [...answered, ...busy.filter((b) => !answered.includes(b))] : answered.slice(-1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const line = before[i]!;
    if (line.kind !== "message") continue;
    const member = members.find((b) => b.id === line.author);
    if (member) {
      if (!answered.includes(member)) answered.unshift(member);
      continue;
    }
    if (line.author !== "you") continue;
    if (next().length) return next();
    const earlier = addressedIn(line.body, members);
    if (earlier.length) return earlier;
  }
  if (next().length) return next();
  const answerer = roomAnswerer(members);
  return answerer ? [answerer] : [];
}

// "stop", "cancel that", "ok quit", "never mind": a short message that is
// only a stop. Anything with more to it ("cancel the order") is an
// instruction for the bot instead.
const STOP_REQUEST = /^(?:(?:please|pls|ok|okay|hey|no|wait|just)[\s,.!]+)*(?:stop|cancel|quit|halt|abort|never ?mind|nvm)(?:[\s,]+(?:it|that|this|now|everything|all|working|please|for now|right now|what you'?re doing))*[\s.!]*$/i;

export function isStopRequest(body: string): boolean {
  const text = body.trim();
  return text.length > 0 && text.length <= 60 && STOP_REQUEST.test(text);
}

// "thank you!", "I will", "perfect, thanks", "that will be all", "👍": a short
// message that closes the exchange rather than asking for anything.
const CLOSING_PHRASE = String.raw`(?:thanks?(?: you)?(?: (?:so|very) much| a lot| again| a ton)?|ty(?:sm)?|thx|tysm|cheers|much appreciated|appreciate (?:it|you|that)|perfect|great|awesome|amazing|nice|cool|sweet|lovely|love (?:it|that)|sounds good|looks good|all good|ok(?:ay)?|k|kk|got it|understood|will do|i will|i'?ll do (?:it|that)|i'?m good|we'?re good|that'?s (?:all|it|perfect|great)|that will be all|that'?ll be all|nothing else|no(?:pe)?,? that'?s (?:all|it)|bye|goodbye|good ?night|night|see (?:you|ya)|have a good (?:one|day|night)|you too|you'?re the best)`;
const CLOSING = new RegExp(String.raw`^(?:${CLOSING_PHRASE}(?:[\s,.!]+(?:[a-z]+))?[\s,.!]*)+$`, "i");

export function isClosing(body: string): boolean {
  const text = body
    .trim()
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[^\p{L}\p{N}'\s,.!]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return body.trim().length > 0 && body.trim().length <= 12;
  return text.length <= 60 && text.split(" ").length <= 9 && CLOSING.test(text);
}

/** A bot answers a routine run with this when there is nothing worth telling the person; the run then leaves no trace in the chat. */
export const QUIET_REPLY = "NOTHING_NEW";

/** The routine's name from the message a run posts (`[Routine: Inbox] …`, or `[Watch: Flight UA 418] …` for a watch). */
export function routineName(body: string): string | null {
  return /^\[(?:Routine|Watch): ([^\]\n]+)\]/.exec(body)?.[1]?.trim() || null;
}

export function isWatchRun(body: string): boolean {
  return body.startsWith("[Watch: ");
}

export function isQuietReply(text: string): boolean {
  return /^[\s`*_]*nothing_new[\s`*_.]*$/i.test(text);
}

/**
 * A reply with the marker taken out wherever it stands alone, on a line of its own or ending the text: a
 * model that answers and then adds it (for a line steered in mid-turn that had nothing for it) still posts
 * its answer, never the marker. Empty when the reply was only the marker.
 */
export function withoutQuietReply(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isQuietReply(line))
    .join("\n")
    .replace(/[ \t`*_]*\bnothing_new[\s`*_.]*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function plainMarkdown(text: string): string {
  return text
    .replace(/:badge\[([^\]]*)\](?:\{[^}\n]*\})?/g, "$1")
    .replace(/^[ \t]*::meter\{([^}\n]*)\}[ \t]*$/gm, (_, attrs: string) => {
      const label = /\blabel="([^"]*)"/.exec(attrs)?.[1]?.trim() ?? "";
      const value = Number(/\bvalue=("?)([^\s"}]*)\1/.exec(attrs)?.[2]);
      const max = Number(/\bmax=("?)([^\s"}]*)\1/.exec(attrs)?.[2] ?? "100");
      const fallback = Number.isFinite(value) && max > 0 ? `${Math.round(Math.min(100, Math.max(0, (value / max) * 100)))}%` : "";
      const words = /\btext="([^"]*)"/.exec(attrs)?.[1]?.trim() || fallback;
      return label && words ? `${label}: ${words}` : label || words;
    })
    .replace(/^[ \t]*::choices\[([^\]\n]*)\][ \t]*$/gm, (_, options: string) => options.split("|").map((option) => option.trim()).filter(Boolean).join(" or ") + "?")
    .replace(/^[ \t]*:::[^\n]*$/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type ToolLabel = { verb: string; detail: string | null };
export type ToolLabelContext = { home?: string | null; servers?: { name: string }[] };

const BRIDGE_PREFIX = /^mcp__gond__/;
const COMPOSIO_ACTION = /^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/;
const MCP_TOOL = /^mcp__([^_].*?)__(.+)$/;
const LABEL_MAX = 60;

export function bareToolName(name: string): string {
  return name.replace(BRIDGE_PREFIX, "");
}

function short(value: unknown, max = LABEL_MAX): string | null {
  if (typeof value !== "string") return null;
  const line = value.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function quoted(value: unknown, max = LABEL_MAX): string | null {
  const text = short(value, max);
  return text ? `“${text}”` : null;
}

function shownPath(value: unknown, home?: string | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const path = value.trim();
  const relative = home && path.startsWith(`${home}/`) ? path.slice(home.length + 1) : path;
  return short(relative, 120);
}

function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

const GERUNDS: Record<string, string> = {
  get: "getting", run: "running", set: "setting", put: "putting", reply: "replying", create: "creating",
  add: "adding", cancel: "cancelling", begin: "beginning", stop: "stopping", forward: "forwarding", open: "opening",
  log: "logging", plan: "planning", tag: "tagging", drop: "dropping", pin: "pinning", star: "starring", sum: "summing",
};

export function gerund(word: string): string {
  const w = word.toLowerCase();
  if (GERUNDS[w]) return GERUNDS[w]!;
  if (w.endsWith("ie")) return `${w.slice(0, -2)}ying`;
  if (w.endsWith("e") && !w.endsWith("ee") && !w.endsWith("ye") && !w.endsWith("oe")) return `${w.slice(0, -1)}ing`;
  return `${w}ing`;
}

function humanise(slug: string, form: "gerund" | "infinitive"): string {
  const words = slug.toLowerCase().split(/[_\s-]+/).filter(Boolean);
  if (!words.length) return slug;
  if (form === "gerund") words[0] = gerund(words[0]!);
  return words.join(" ");
}

function toolkitName(segment: string): string {
  const slug = segment.toLowerCase();
  const known = APP_CATALOG.find((app) => app.toolkit === slug);
  return known ? known.name : slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Many servers name their tools after themselves (Notion's `notion-search`); the server is already said. */
function mcpAction(server: string, action: string): string {
  const own = new RegExp(`^${server.replace(/[^a-z0-9]/gi, "")}[-_]+(?=.)`, "i");
  return action.replace(own, "");
}

function serverName(segment: string, servers?: { name: string }[]): string {
  const lower = segment.toLowerCase();
  return servers?.find((server) => server.name.toLowerCase() === lower)?.name ?? segment;
}

function fileOf(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname || short(url);
  } catch {
    return short(url);
  }
}

function stepLabel(step: Record<string, unknown>): ToolLabel | null {
  switch (step.type) {
    case "screenshot":
      return { verb: "Taking a screenshot", detail: null };
    case "click":
      return { verb: typeof step.hold === "number" && step.hold > 0 ? "Holding the mouse down" : "Clicking", detail: typeof step.label === "string" ? quoted(step.label, 40) : null };
    case "hold":
      return { verb: "Holding the mouse down", detail: null };
    case "type":
      return { verb: "Typing", detail: typeof step.text === "string" ? `"${short(step.text, 40) ?? ""}"` : null };
    case "type_login":
      return { verb: "Typing a sign-in", detail: null };
    case "key":
      return { verb: "Pressing", detail: short(step.key) };
    case "scroll":
      return { verb: "Scrolling", detail: short(step.direction) };
    case "move":
    case "hover":
      return { verb: "Moving the mouse", detail: null };
    case "fill":
      return { verb: "Filling in a field", detail: null };
    case "select":
      return { verb: "Choosing", detail: typeof step.option === "string" ? quoted(step.option, 40) : null };
    case "check":
      return { verb: step.checked === false ? "Unticking a box" : "Ticking a box", detail: null };
    case "read":
      return { verb: "Reading the page", detail: null };
    case "copy":
      return { verb: "Copying", detail: null };
    case "paste":
      return { verb: "Pasting", detail: null };
    case "clipboard":
      return { verb: "Reading the clipboard", detail: null };
    case "wait_for":
      return { verb: "Waiting for", detail: typeof step.text === "string" ? quoted(step.text, 40) : short(step.url) };
    case "upload":
      return { verb: "Uploading", detail: typeof step.path === "string" ? short(baseName(step.path)) : null };
    case "dialog":
      return { verb: "Answering a dialog", detail: null };
    case "new_tab":
      return { verb: "Opening a tab", detail: typeof step.url === "string" ? short(step.url.replace(/^https?:\/\//, "").replace(/\/$/, "")) : null };
    case "close_tab":
      return { verb: "Closing a tab", detail: null };
    case "drag":
      return { verb: "Dragging", detail: null };
    case "mouse_down":
      return { verb: "Pressing the mouse button", detail: null };
    case "mouse_up":
      return { verb: "Releasing the mouse button", detail: null };
    case "wait":
      return { verb: "Waiting", detail: null };
    case "navigate":
      return { verb: "Opening", detail: typeof step.url === "string" ? short(step.url.replace(/^https?:\/\//, "").replace(/\/$/, "")) : null };
    case "back":
      return { verb: "Going back", detail: null };
    case "forward":
      return { verb: "Going forward", detail: null };
    case "reload":
      return { verb: "Reloading", detail: null };
    case "tab":
      return { verb: "Switching tabs", detail: null };
    default:
      return null;
  }
}

const NATIVE_STEP: Record<string, ScreenStepType> = {
  left_click: "click",
  right_click: "click",
  middle_click: "click",
  double_click: "click",
  triple_click: "click",
  mouse_move: "move",
  left_click_drag: "drag",
};

/** Anthropic's own computer tool sends one `{ action, coordinate, text, … }`; this is its step. */
export function fromNativeAction(input: Record<string, unknown>): Record<string, unknown> {
  const action = String(input.action ?? "");
  const [x, y] = Array.isArray(input.coordinate) ? input.coordinate : [];
  const [fromX, fromY] = Array.isArray(input.start_coordinate) ? input.start_coordinate : [];
  const at = x === undefined ? {} : { x, y };
  switch (action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      return { type: "click", ...at, button: action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left", count: action === "double_click" ? 2 : action === "triple_click" ? 3 : 1 };
    case "left_click_drag":
      return { type: "drag", x: fromX, y: fromY, to_x: x, to_y: y };
    case "left_mouse_down":
      return { type: "mouse_down", ...at, button: "left" };
    case "left_mouse_up":
      return { type: "mouse_up", ...at, button: "left" };
    case "key":
      return { type: "key", key: input.text };
    case "scroll":
      return { type: "scroll", ...at, direction: input.scroll_direction, amount: input.scroll_amount };
    case "wait":
      return { type: "wait", ms: Math.round(Number(input.duration ?? 1) * 1000) };
    default:
      return { type: NATIVE_STEP[action] ?? action, ...at, ...(typeof input.text === "string" ? { text: input.text } : {}) };
  }
}

// The first step that does something names the batch; a batch that only looks is a look.
function screenLabel(name: string, input: Record<string, unknown>): ToolLabel | null {
  const fallback = name === "browser" ? "Using the browser" : "Using the computer";
  if (typeof input.action === "string") return input.action === "cursor_position" ? null : (stepLabel(fromNativeAction(input)) ?? { verb: fallback, detail: null });
  const steps = Array.isArray(input.actions) ? input.actions.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object") : [];
  if (!steps.length) return { verb: fallback, detail: null };
  const acting = steps.find((s) => s.type !== "screenshot" && s.type !== "wait") ?? steps[0]!;
  return stepLabel(acting) ?? { verb: fallback, detail: null };
}

export function toolLabel(name: string, input: Record<string, unknown> = {}, context: ToolLabelContext = {}): ToolLabel | null {
  if (isQuietTool(name, input)) return null;
  return describeTool(name, input, context);
}

export function describeTool(name: string, input: Record<string, unknown> = {}, context: ToolLabelContext = {}): ToolLabel | null {
  const tool = bareToolName(name);
  const home = context.home ?? null;
  switch (tool) {
    case "Bash": {
      const command = short(input.command);
      return { verb: "Running", detail: command ? `\`${command}\`` : null };
    }
    case "Read":
    case "NotebookRead":
      return { verb: "Reading", detail: shownPath(fileOf(input), home) };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "Editing", detail: shownPath(fileOf(input), home) };
    case "Glob":
    case "Grep": {
      const pattern = short(input.pattern);
      return { verb: "Searching files", detail: pattern ? `for ${pattern}` : null };
    }
    case "LS":
      return { verb: "Listing", detail: shownPath(input.path, home) };
    case "WebFetch":
      return { verb: "Opening", detail: hostOf(input.url) };
    case "WebSearch": {
      const query = quoted(input.query);
      return { verb: "Searching the web", detail: query ? `for ${query}` : null };
    }
    case "Task":
      return { verb: "Running a subtask", detail: short(input.description) };
    case "TodoWrite":
    case "TodoRead":
      return { verb: "Planning", detail: null };
    case "permission":
    case "cursor_position":
      return null;
    case "memory_update":
      return { verb: "Updating its memory", detail: null };
    case "team_memory_update":
      return { verb: "Updating the team memory", detail: null };
    case "set_profile":
      return { verb: "Updating its profile", detail: null };
    case "post_message":
      return { verb: "Posting a message", detail: null };
    case "run_with_secrets":
      return { verb: "Running", detail: typeof input.command === "string" ? short(input.command) : null };
    case "react":
      return { verb: "Reacting", detail: typeof input.emoji === "string" ? input.emoji : null };
    case "create_image":
      return { verb: "Making a picture", detail: short(input.prompt) };
    case "send_file": {
      const file = fileOf(input);
      return { verb: "Sending", detail: file ? short(baseName(file)) : null };
    }
    case "list_bots":
      return { verb: "Listing bots", detail: null };
    case "message_bot":
      return { verb: "Messaging", detail: short(input.bot) };
    case "delegate_bot":
      return { verb: "Delegating to", detail: short(input.bot) };
    case "ask_bot":
      return { verb: "Asking", detail: short(input.bot) };
    case "create_bot":
      return { verb: "Creating a bot", detail: short(input.name) };
    case "update_bot":
      return { verb: "Updating a bot", detail: short(input.bot) };
    case "create_room":
      return { verb: "Creating a room", detail: short(input.name) };
    case "list_handoffs":
      return { verb: "Listing handoffs", detail: null };
    case "cancel_handoff":
      return { verb: "Cancelling a handoff", detail: null };
    case "amend_handoff":
      return { verb: "Updating a handoff", detail: null };
    case "use_skill": {
      const slug = short(input.slug ?? input.name);
      return { verb: slug ? `Using the ${slug} skill` : "Using a skill", detail: null };
    }
    case "save_skill":
      return { verb: "Saving a skill", detail: short(input.name) };
    case "update_skill":
      return { verb: "Updating a skill", detail: short(input.name ?? input.slug) };
    case "connect_app":
      return { verb: "Connecting", detail: short(input.app) };
    case "add_mcp_server":
      return { verb: "Adding an MCP server", detail: short(input.name) };
    case "list_routines":
      return { verb: "Listing routines", detail: null };
    case "create_routine":
    case "update_routine":
    case "delete_routine":
    case "run_routine":
      return { verb: `${gerund(tool.split("_")[0]!).replace(/^./, (c) => c.toUpperCase())} a routine`, detail: short(input.name ?? input.routine) };
    case "follow_up":
      return { verb: "Setting a follow-up", detail: null };
    case "read_conversation":
      return { verb: "Reading a conversation", detail: null };
    case "search_messages": {
      const query = quoted(input.query);
      return { verb: "Searching messages", detail: query ? `for ${query}` : null };
    }
    case "request_secret":
    case "set_composio_key":
      return { verb: "Requesting a secret", detail: short(input.name) };
    case "list_secrets":
      return { verb: "Listing secrets", detail: null };
    case "forget_secret":
      return { verb: "Deleting a secret", detail: short(input.name) };
    case "request_login":
      return { verb: "Requesting a sign-in", detail: short(input.site) ? `to ${short(input.site)}` : null };
    case "ask_approval":
      return { verb: "Requesting approval", detail: null };
    case "send_screenshot":
      return { verb: "Showing the screen", detail: null };
    case "hand_over":
      return { verb: "Handing over the screen", detail: null };
    case "computer":
    case "browser":
      return screenLabel(name, input);
    default:
      break;
  }
  if (COMPOSIO_ACTION.test(tool)) {
    const at = tool.indexOf("_");
    return { verb: `${toolkitName(tool.slice(0, at))}:`, detail: humanise(tool.slice(at + 1), "gerund") };
  }
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) return { verb: `${serverName(mcp[1]!, context.servers)}:`, detail: humanise(mcpAction(mcp[1]!, mcp[2]!), "gerund") };
  return { verb: "Working", detail: null };
}

export function toolLine(label: ToolLabel | null): string | null {
  if (!label) return null;
  return label.detail ? `${label.verb} ${label.detail}` : label.verb;
}

export function approvalLine(name: string, input: Record<string, unknown> = {}, context: ToolLabelContext = {}): string {
  const tool = bareToolName(name);
  const home = context.home ?? null;
  switch (tool) {
    case "Bash": {
      const command = short(input.command, 300);
      return command ? `run \`${command}\`` : "run a command";
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = shownPath(fileOf(input), home);
      return path ? `change ${path}` : "change a file";
    }
    case "Write": {
      const path = shownPath(fileOf(input), home);
      return path ? `write ${path}` : "write a file";
    }
    case "Read":
    case "NotebookRead": {
      const path = shownPath(fileOf(input), home);
      return path ? `read ${path}` : "read a file";
    }
    case "WebFetch": {
      const host = hostOf(input.url);
      return host ? `open ${host}` : "open a page";
    }
    case "WebSearch": {
      const query = quoted(input.query);
      return query ? `search the web for ${query}` : "search the web";
    }
    case "computer":
      return "use the computer";
    case "request_login": {
      const site = short(input.site);
      return site ? `sign in to ${site} with your saved details` : "sign in with your saved details";
    }
    case "forget_secret": {
      const name = short(input.name);
      return name ? `delete the secret ${name}` : "delete a secret";
    }
    case "ask_approval": {
      const summary = short(input.summary ?? input.action ?? input.text, 300);
      return summary ?? "go on";
    }
    default:
      break;
  }
  if (COMPOSIO_ACTION.test(tool)) {
    const at = tool.indexOf("_");
    return `${toolkitName(tool.slice(0, at))}: ${humanise(tool.slice(at + 1), "infinitive")}`;
  }
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) return `${serverName(mcp[1]!, context.servers)}: ${humanise(mcpAction(mcp[1]!, mcp[2]!), "infinitive")}`;
  return `use ${tool}`;
}

export function ruleLabel(rule: string, context: ToolLabelContext = {}): string {
  const prefix = /^Bash\((.+):\*\)$/.exec(rule);
  if (prefix) return `${prefix[1]} commands`;
  const folder = /^(\w+)\((.+)\/\*\*\)$/.exec(rule);
  if (folder) {
    const where = folder[2] === "." ? "its own folder" : `${shownPath(folder[2], context.home) ?? folder[2]}/`;
    return folder[2] === "." ? `changes in ${where}` : `changes under ${where}`;
  }
  if (rule === "Bash") return "any command";
  if (rule === "computer") return "the computer";
  if (rule === "request_login") return "your saved sign-ins";
  if (rule === "WebFetch") return "opening pages";
  if (rule === "Edit" || rule === "Write" || rule === "MultiEdit" || rule === "NotebookEdit") return "changing files";
  if (COMPOSIO_ACTION.test(rule)) {
    const at = rule.indexOf("_");
    return `${toolkitName(rule.slice(0, at))}: ${humanise(rule.slice(at + 1), "infinitive")}`;
  }
  const mcp = MCP_TOOL.exec(rule);
  if (mcp) return `${serverName(mcp[1]!, context.servers)}: ${humanise(mcpAction(mcp[1]!, mcp[2]!), "infinitive")}`;
  return rule;
}

export function isQuietTool(name: string, input: Record<string, unknown> = {}): boolean {
  const tool = bareToolName(name);
  if (tool === "memory_update" || tool === "team_memory_update") return true;
  if (tool !== "Read" && tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit" && tool !== "NotebookEdit") return false;
  const file = fileOf(input);
  if (!file) return false;
  return baseName(file) === "MEMORY.md" || /\/\.bots\/[^/]+\/memory\//.test(`/${file}`);
}

/**
 * What a bot does on its screen: one batch of these per `computer` (the
 * desktop) or `browser` call, run in order by the box's persistent driver,
 * with one fresh screenshot after the batch. The model only ever writes
 * these; nothing it sends is run as code.
 */
export const SCREEN_STEP_TYPES = [
  "screenshot", "click", "hold", "mouse_down", "mouse_up", "move", "hover", "drag", "type", "type_login", "key", "scroll", "wait", "copy", "paste", "clipboard",
  "navigate", "back", "forward", "reload", "tab", "new_tab", "close_tab", "fill", "select", "check", "read", "wait_for", "upload", "dialog",
] as const;
export type ScreenStepType = (typeof SCREEN_STEP_TYPES)[number];
export type ScreenTarget = "desktop" | "browser";
export const BROWSER_ONLY_STEPS: readonly ScreenStepType[] = ["navigate", "back", "forward", "reload", "tab", "new_tab", "close_tab", "fill", "select", "check", "read", "wait_for", "upload", "dialog"];
/** Steps that only look: no approval, and the person holding the mouse doesn't stop them. */
export const LOOK_STEPS: readonly ScreenStepType[] = ["screenshot", "wait", "read", "wait_for", "clipboard"];
export const MAX_SCREEN_STEPS = 20;

export type DesktopControl = "free" | "bots" | "person";

export const DESKTOP_CONTROL_LABELS: Record<DesktopControl, string> = {
  free: "Nobody is driving",
  bots: "A bot is driving",
  person: "You have control",
};

export type DesktopDriver = { botId: string; threadId: string };

/** One bot's screen on the computer: every bot has its own, started when it or the person first needs it. */
export type ScreenState = {
  botId: string;
  running: boolean;
  ready: boolean;
  width: number | null;
  height: number | null;
  viewers: number;
  control: DesktopControl;
};

/** The person's bots' screens that are running, and which conversations have a bot at one. */
export type DesktopState = {
  screens: ScreenState[];
  drivers: DesktopDriver[];
};

/** A bot's screen as the state has it, asleep when it isn't running. */
export function screenOf(desktop: DesktopState | null | undefined, botId: string): ScreenState {
  return desktop?.screens.find((screen) => screen.botId === botId) ?? { botId, running: false, ready: false, width: null, height: null, viewers: 0, control: "free" };
}

/** An email a connected app is about to send, read from the action's own input. */
export type EmailDraft = {
  mode: "send" | "reply" | "forward" | "draft";
  app: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  body: string | null;
  files: string[];
};

const EMAIL_APPS: Record<string, string> = { GMAIL: "Gmail", OUTLOOK: "Outlook" };
// Composio's mail actions name the same thing several ways across apps and versions.
const EMAIL_FIELDS = {
  to: ["recipient_email", "to_email", "to", "recipient", "recipients", "to_recipients", "extra_recipients", "to_emails"],
  cc: ["cc", "cc_emails", "cc_recipients"],
  bcc: ["bcc", "bcc_emails", "bcc_recipients"],
  subject: ["subject"],
  body: ["body", "message_body", "comment", "content", "html_body", "text", "additional_text", "message"],
  files: ["attachment", "attachments"],
} as const;

function emailList(input: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") for (const part of value.split(/[,;]/)) part.trim() && out.push(part.trim());
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") {
      const entry = value as { email?: unknown; address?: unknown; name?: unknown; emailAddress?: unknown };
      if (entry.emailAddress) return add(entry.emailAddress);
      const address = typeof entry.email === "string" ? entry.email : typeof entry.address === "string" ? entry.address : null;
      if (address) out.push(typeof entry.name === "string" && entry.name.trim() ? `${entry.name.trim()} <${address}>` : address);
    }
  };
  for (const key of keys) add(input[key]);
  return [...new Set(out)];
}

function emailFiles(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim().split(/[\\/]/).pop() ?? value.trim());
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") {
      const file = value as { name?: unknown; filename?: unknown; path?: unknown };
      add(typeof file.name === "string" ? file.name : typeof file.filename === "string" ? file.filename : file.path);
    }
  };
  for (const key of EMAIL_FIELDS.files) add(input[key]);
  return out;
}

/** HTML a bot wrote as an email body, as the words and line breaks a person reads; never markup. */
export function emailText(body: string): string {
  if (!/<[a-z][\s\S]*>/i.test(body)) return body.trim();
  return body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6])>/gi, "\n\n")
    .replace(/<\/(div|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function emailMode(tool: string): { app: string; mode: EmailDraft["mode"] } | null {
  const name = bareToolName(tool).toUpperCase();
  const app = EMAIL_APPS[name.split("_")[0] ?? ""];
  if (!app) return null;
  const word = (w: string) => new RegExp(`(^|_)${w}(_|$)`).test(name);
  // A draft reply (Outlook's CREATE_DRAFT_REPLY) only saves; sending a saved draft names nothing to show.
  const mode = word("DRAFT") && !word("SEND") ? "draft" : word("REPLY") ? "reply" : word("FORWARD") ? "forward" : word("SEND") ? "send" : null;
  return mode ? { app, mode } : null;
}

export function emailDraftOf(tool: string, input: Record<string, unknown>): EmailDraft | null {
  const { app, mode } = emailMode(tool) ?? {};
  if (!app || !mode) return null;
  const to = emailList(input, EMAIL_FIELDS.to);
  const rawBody = EMAIL_FIELDS.body.map((key) => input[key]).find((value): value is string => typeof value === "string" && value.trim() !== "");
  const subject = typeof input.subject === "string" && input.subject.trim() ? input.subject.trim() : null;
  // A send that only names a saved draft carries nothing to show; the plain card says what it is.
  if (!to.length && !rawBody && !subject) return null;
  return { mode, app, to, cc: emailList(input, EMAIL_FIELDS.cc), bcc: emailList(input, EMAIL_FIELDS.bcc), subject, body: rawBody ? emailText(rawBody) : null, files: emailFiles(input) };
}

/** Only a connected app's own action (a Composio slug) can be edited or sent from its card; Gond runs it. */
export function emailEditable(tool: string): boolean {
  return !tool.startsWith("mcp__") && emailMode(tool) !== null;
}

/** The app's action that sends a saved draft, and the input naming it, for a draft card's Send. */
export function sendDraftAction(tool: string): { slug: string; idKey: string } | null {
  if (!emailEditable(tool) || emailMode(tool)?.mode !== "draft") return null;
  const name = tool.toUpperCase();
  if (name.startsWith("GMAIL_")) return { slug: "GMAIL_SEND_DRAFT", idKey: "draft_id" };
  if (name.startsWith("OUTLOOK_")) return { slug: "OUTLOOK_SEND_DRAFT", idKey: "message_id" };
  return null;
}

/**
 * The id of the draft an app just saved, from what its action answered: Gmail answers the draft
 * (`id`, its message under it), Outlook the draft message (`id`), either sometimes wrapped.
 */
export function draftIdOf(result: unknown): string | null {
  const seen: unknown[] = [result];
  for (let depth = 0; depth < 3 && seen.length; depth += 1) {
    const level = seen.splice(0);
    for (const value of level) {
      if (typeof value === "string") {
        try {
          seen.push(JSON.parse(value));
        } catch {
          /* not JSON */
        }
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      for (const key of ["draft_id", "draftId", "id"]) if (typeof entry[key] === "string" && (entry[key] as string).trim()) return (entry[key] as string).trim();
      for (const key of ["data", "response_data", "draft", "result"]) if (entry[key] !== undefined) seen.push(entry[key]);
    }
  }
  return null;
}

/** The address in "Dana Ruiz <dana@ruizdesign.co>", or the text as it is. */
export function emailAddress(recipient: string): string {
  return /<([^<>\s]+@[^<>\s]+)>/.exec(recipient)?.[1] ?? recipient.trim();
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The action's input with the person's edits written back where the letter came from: a field
 * keeps its key and its shape (a string, a list, Gmail's first address apart from the rest,
 * Graph's `{ emailAddress }`), and a field they didn't change is left exactly as it was.
 */
export function editedEmailInput(tool: string, input: Record<string, unknown>, edit: EmailEdit): Record<string, unknown> {
  const draft = emailDraftOf(tool, input);
  const out: Record<string, unknown> = { ...input };
  const name = bareToolName(tool).toUpperCase();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => emailAddress(value) === emailAddress(b[i]!));
  const writeList = (keys: readonly string[], shown: string[], next: string[], fallback: string) => {
    if (same(shown, next)) return;
    const present = keys.filter((key) => input[key] !== undefined && input[key] !== null && input[key] !== "");
    for (const key of present) delete out[key];
    const addresses = next.map(emailAddress);
    if (present.includes("recipient_email") || (!present.length && fallback === "recipient_email")) {
      if (addresses[0]) out.recipient_email = addresses[0];
      if (addresses.length > 1) out.extra_recipients = addresses.slice(1);
      return;
    }
    const key = present[0] ?? fallback;
    const was = input[key];
    const sample = Array.isArray(was) ? was[0] : was;
    if (typeof was === "string") out[key] = addresses.join(", ");
    else if (sample && typeof sample === "object" && "emailAddress" in sample) out[key] = addresses.map((address) => ({ emailAddress: { address } }));
    else if (sample && typeof sample === "object") out[key] = addresses.map((email) => ({ email }));
    else out[key] = addresses;
  };
  const gmail = name.startsWith("GMAIL_");
  writeList(EMAIL_FIELDS.to, draft?.to ?? [], edit.to, gmail ? "recipient_email" : /SEND_EMAIL/.test(name) ? "to" : "to_recipients");
  writeList(EMAIL_FIELDS.cc, draft?.cc ?? [], edit.cc, gmail ? "cc" : /DRAFT$/.test(name) ? "cc_recipients" : "cc_emails");
  writeList(EMAIL_FIELDS.bcc, draft?.bcc ?? [], edit.bcc, gmail ? "bcc" : /DRAFT$/.test(name) ? "bcc_recipients" : "bcc_emails");
  if (edit.subject.trim() !== (draft?.subject ?? "")) out.subject = edit.subject.trim();
  if (edit.body.trim() !== (draft?.body ?? "").trim()) {
    const key = EMAIL_FIELDS.body.find((k) => typeof input[k] === "string" && (input[k] as string).trim() !== "") ?? (/REPLY_TO_THREAD/.test(name) ? "message_body" : /DRAFT_REPLY|REPLY_EMAIL/.test(name) ? "comment" : "body");
    // The person edited words, not markup: HTML in, HTML out, their line breaks kept.
    out[key] = input.is_html === true ? escapeHtml(edit.body.trim()).replace(/\r?\n/g, "<br>") : edit.body.trim();
  }
  return out;
}

export type DiffPart = { text: string; change: "same" | "added" | "removed" };

/** A word-by-word diff of two drafts, for a redraft's marks: spaces go with the word before them, line breaks stand alone. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const split = (text: string) => text.match(/\S+[^\S\n]*|\s+/g) ?? [];
  const a = split(before);
  const b = split(after);
  // Past this a redraft is a new letter; marking every word says nothing.
  if (a.length * b.length > 250_000) return [{ text: after, change: "same" }];
  const key = (word: string) => word.trim();
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) lcs[i]![j] = key(a[i]!) === key(b[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const parts: DiffPart[] = [];
  const push = (text: string, change: DiffPart["change"]) => {
    const last = parts.at(-1);
    if (last?.change === change) last.text += text;
    else parts.push({ text, change });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]!) === key(b[j]!)) {
      push(b[j]!, "same");
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) push(a[i++]!, "removed");
    else push(b[j++]!, "added");
  }
  return parts;
}

/** "Dana Ruiz <dana@ruizdesign.co>" is Dana Ruiz to a person; a bare address stays an address. */
export function emailName(recipient: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(recipient);
  return match?.[1]?.trim() || recipient.trim();
}

/** An export of a person's conversations, made on the server and kept for a while to download. */
export const EXPORT_STATUSES = ["preparing", "ready", "failed", "expired"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** How long a finished export is kept, and how many of a person's are listed before the oldest go. */
export const EXPORT_KEEP_DAYS = 7;
export const EXPORTS_LISTED = 5;

/** How far back an export reaches. */
export const EXPORT_RANGES = [
  { id: "all", label: "All time", days: null },
  { id: "year", label: "The last year", days: 365 },
  { id: "month", label: "The last 30 days", days: 30 },
  { id: "week", label: "The last 7 days", days: 7 },
] as const;
export type ExportRange = (typeof EXPORT_RANGES)[number]["id"];

export function isExportRange(value: unknown): value is ExportRange {
  return EXPORT_RANGES.some((range) => range.id === value);
}

export type ChatExport = {
  id: string;
  /** What it holds, in words: "All chats, all time", "Trip to Lisbon, the last 30 days". */
  label: string;
  status: ExportStatus;
  /** Conversations gathered so far, of `total`. */
  done: number;
  total: number;
  /** The zip's size in bytes once it is ready. */
  size: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
};
