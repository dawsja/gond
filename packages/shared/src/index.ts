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

  toolkits: z.array(z.string().trim().min(1).max(40)).max(40),

  notify: z.boolean(),
});

export const botInputSchema = botFields.extend({
  title: botFields.shape.title.default(""),
  description: botFields.shape.description.default(""),
  color: botFields.shape.color.default(BOT_COLORS[0]),
  expression: botFields.shape.expression.default("happy"),
  shape: botFields.shape.shape.default("cog"),
  approval: botFields.shape.approval.default("auto"),
  toolkits: botFields.shape.toolkits.default([]),
  notify: botFields.shape.notify.default(true),
});

/**
 * A change to some of a bot's fields; the rest stay as they are. Not
 * `botInputSchema.partial()`: with zod 4 that fills every missing field
 * with its default, so pinning a bot would have made it forget its job.
 */
export const botPatchSchema = botFields.partial();
export type BotPatch = z.infer<typeof botPatchSchema>;
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

  lastMessage: { author: string; body: string; at: string } | null;
  unread: number;
  createdAt: string;
  updatedAt: string;
};

export type MessageAuthor = "you" | "system" | "routine" | string;

export const MESSAGE_KINDS = ["message", "event", "activity", "approval", "secret", "prompt", "signin"] as const;
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

  reactions: Reaction[];
  createdAt: string;
};

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
};

export const approvalDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "always"]),
});

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

export type Me = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  provider: SignInProvider;

  avatar: string | null;
  accent: Accent;
};

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

export const LEGACY_MOBILE_SIGN_IN_CALLBACK = "krubot://sign-in";

export const SIGN_IN_APPS = ["android", "app", "desktop"] as const;
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

export const PROVIDER_KINDS = ["anthropic", "openai", "xai"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

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
};

export function isOpenAiShaped(kind: ProviderKind): boolean {
  return kind === "openai" || kind === "xai";
}

export type ProviderMeta = {
  kind: ProviderKind;
  baseUrl: string;

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
export type VoiceSettings = { preference: VoicePreference; using: VoiceProvider | null; available: VoiceProvider[]; openaiModel: string };
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

export const CLI_ENGINES = ["claude", "codex", "grok"] as const;
export type CliEngine = (typeof CLI_ENGINES)[number];

export const ENGINES = [...CLI_ENGINES, "api"] as const;
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
  codex: {
    name: "Codex",
    vendor: "OpenAI",
    detail: "OpenAI's coding agent, on a ChatGPT plan.",
    plan: "Your ChatGPT plan",
    signIn: "codex login --device-auth",
    signInAt: "auth.openai.com",
    provider: "openai",
    providers: ["openai", "xai"],
    defaultModel: "",
    modelHint: "Leave empty for Codex's default",
  },
  grok: {
    name: "Grok",
    vendor: "xAI",
    detail: "xAI's coding agent, on a Grok plan.",
    plan: "Your Grok plan",
    signIn: "grok login --device-auth",
    signInAt: "accounts.x.ai",
    provider: "xai",
    providers: ["xai", "openai"],
    defaultModel: "",
    modelHint: "Leave empty for Grok's default (grok-build)",
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

export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{0,120}$/;

export const DEFAULT_ENGINES: Record<Engine, EngineSettings> = {
  claude: { access: "plan", model: DEFAULT_MODEL },
  codex: { access: "plan", model: "" },
  grok: { access: "plan", model: "" },

  api: { access: "api", model: "", provider: null },
};

export type Onboarding = {
  done: boolean;

  apps: string[];

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

export type EngineStatus = { installed: boolean; loggedIn: boolean; detail: string };

export const ENGINE_SIGN_IN_STATES = ["starting", "waiting", "finishing", "done", "failed"] as const;
export type EngineSignInState = (typeof ENGINE_SIGN_IN_STATES)[number];
export type EngineSignIn = {
  engine: Engine;
  state: EngineSignInState;

  url: string | null;

  code: string | null;

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

  engines: { codex: EngineStatus; grok: EngineStatus } | null;
  composio: { configured: boolean; connected: number };

  agents: { id: string; running: boolean; busy: boolean }[];

  versions: { node: string | null; bun: string | null; claude: string | null; codex?: string | null; grok?: string | null } | null;
};

export type BoxUpdatePhase = "idle" | "pausing" | "pulling" | "restarting" | "resetting" | "patching" | "resuming" | "done" | "failed";

export const BOX_UPDATE_PHASE_LABELS: Record<BoxUpdatePhase, string> = {
  idle: "Up to date as far as we know",
  pausing: "Pausing the computer",
  pulling: "Pulling the newest image",
  restarting: "Restarting on the new image",
  resetting: "Wiping the computer and rebuilding it",
  patching: "Patching Debian, Bun, Claude Code, Codex and Grok",
  resuming: "Bringing the computer back",
  done: "Updated",
  failed: "Update failed",
};

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

export type LiveEvent =

  | { topic: "bots" }
  /** A message landed on a thread, or (cleared) every message was removed. */
  | { topic: "thread"; threadId: string; cleared?: true }
  /** A message's reactions changed: all of them as they now stand. */
  | { topic: "reactions"; threadId: string; messageId: string; reactions: Reaction[] }
  /** A bot's live activity while it works: the line, or null when the turn ended. */
  | { topic: "activity"; threadId: string; botId: string; line: string | null }
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
  /**
   * A bot finished a job for you or needs you: what the API just sent as a
   * push notification, for a client without Web Push (the Android app)
   * to show on its own. Quiet when that conversation is in front of you.
   */
  | { topic: "notify"; userId: string; title: string; body: string; url: string; tag: string; threadId: string; device: string | null }
  /** Your desktop on the computer: who is driving it, and whether it is up. */
  | { topic: "desktop"; userId: string; desktop: DesktopState };

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
};

export const SECRET_REF = /\{\{\s*secret:([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;

export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SecretMeta = {
  name: string;

  requestedBy: string | null;

  site: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SecretRequest = {
  id: string;
  botId: string;
  threadId: string;
  name: string;
  reason: string;

  target: "secret" | "composio" | "login";

  site: string | null;
  fields: LoginField[];
  status: "pending" | "given" | "declined" | "expired";
  createdAt: string;
  resolvedAt: string | null;
};

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
  toolkits: string[];
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
    toolkits: ["gmail", "googlecalendar"],
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
    toolkits: ["gmail"],
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
    toolkits: ["gmail"],
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
    toolkits: ["gmail", "googlecalendar"],
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
    toolkits: ["gmail", "googlesheets", "googledrive"],
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
    toolkits: ["github"],
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
    toolkits: ["github"],
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
    toolkits: ["gmail", "googlesheets"],
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

const BRIDGE_PREFIX = /^mcp__(?:gond|kru)__/;
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
      return { verb: "Clicking", detail: typeof step.label === "string" ? quoted(step.label, 40) : null };
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
    case "request_login":
      return { verb: "Requesting a sign-in", detail: short(input.site) ? `to ${short(input.site)}` : null };
    case "ask_approval":
      return { verb: "Requesting approval", detail: null };
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
  "screenshot", "click", "move", "hover", "drag", "type", "type_login", "key", "scroll", "wait", "copy", "paste", "clipboard",
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

export type DesktopState = {
  running: boolean;
  ready: boolean;
  width: number | null;
  height: number | null;
  viewers: number;
  control: DesktopControl;
  drivers: DesktopDriver[];
};

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

export function emailDraftOf(tool: string, input: Record<string, unknown>): EmailDraft | null {
  const name = bareToolName(tool).toUpperCase();
  const app = EMAIL_APPS[name.split("_")[0] ?? ""];
  if (!app) return null;
  const mode = /(^|_)REPLY(_|$)/.test(name) ? "reply" : /(^|_)FORWARD(_|$)/.test(name) ? "forward" : /(^|_)SEND(_|$)/.test(name) ? "send" : /(^|_)DRAFT(_|$)/.test(name) ? "draft" : null;
  if (!mode) return null;
  const to = emailList(input, EMAIL_FIELDS.to);
  const rawBody = EMAIL_FIELDS.body.map((key) => input[key]).find((value): value is string => typeof value === "string" && value.trim() !== "");
  const subject = typeof input.subject === "string" && input.subject.trim() ? input.subject.trim() : null;
  // A send that only names a saved draft carries nothing to show; the plain card says what it is.
  if (!to.length && !rawBody && !subject) return null;
  return { mode, app, to, cc: emailList(input, EMAIL_FIELDS.cc), bcc: emailList(input, EMAIL_FIELDS.bcc), subject, body: rawBody ? emailText(rawBody) : null, files: emailFiles(input) };
}

/** "Dana Ruiz <dana@ruizdesign.co>" is Dana Ruiz to a person; a bare address stays an address. */
export function emailName(recipient: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(recipient);
  return match?.[1]?.trim() || recipient.trim();
}
