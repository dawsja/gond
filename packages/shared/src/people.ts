import type { z } from "zod";
import type { oidcPatchSchema } from "./schemas.ts";

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type SignInProvider = "local" | "oidc";

/** How a person signs in: a password, and whether the organisation's provider is linked to this account (null when none is set up). */
/** How a person signs in, and, for an account the provider made while one with a password waits unlinked, what moving to that one would delete. */
/** How often the primary bot looks in on the person's bots, email and loose ends, in hours. */
export const CHECK_IN_HOURS = [2, 3, 4, 6] as const;
export type CheckInHours = (typeof CHECK_IN_HOURS)[number];

/**
 * The primary bot's check-ins: every `everyHours` outside the quiet hours (whole hours in the person's
 * time zone, from `quietFrom` until `quietTo`), it says something only when something needs the person.
 */
export type CheckIns = { enabled: boolean; everyHours: CheckInHours; quietFrom: number; quietTo: number; email: boolean };

export const DEFAULT_CHECK_INS: CheckIns = { enabled: true, everyHours: 3, quietFrom: 21, quietTo: 8, email: true };

export const isCheckInHours = (value: unknown): value is CheckInHours => (CHECK_IN_HOURS as readonly unknown[]).includes(value);

export type SignIns = { password: boolean; oidc: { name: string; linked: boolean } | null; move: { bots: number; chats: number } | null };

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
  /** The profile this is: on `/api/me`, the one open on this device. */
  profile: ProfileRef;
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

export type UserSummary = Omit<Me, "profile"> & { createdAt: string; bots: number; profiles: number };

/**
 * A person's profiles: each a world of its own (bots, chats, memories, keys, apps, its account on the
 * computer), opened one at a time on each device. The first is the person's own id: called "Default"
 * until renamed, and never deleted but with the person.
 */
export const MAX_PROFILES = 5;
export const DEFAULT_PROFILE_LABEL = "Default";
export const PROFILE_LABEL_MAX = 24;

/** `icon` is one emoji worn in the middle of the profile's mark, or null for its initial. */
export type ProfileRef = { id: string; label: string; isDefault: boolean; icon: string | null };

/** The emoji a profile's icon is picked from; nothing else is taken. */
export const PROFILE_ICONS = ["💼", "🏠", "🎮", "📚", "❤️"] as const;
export type ProfileIcon = (typeof PROFILE_ICONS)[number];

export type Profile = ProfileRef & {
  accent: Accent;
  avatar: string | null;
  /** Its bots finish and ask in silence: no notices. */
  muted: boolean;
  /** Conversations with something new, and cards waiting on the person. */
  unread: number;
  needsYou: number;
};

/** What a profile may be called: a name none of the person's other profiles has. */
export function profileLabelError(label: string, taken: string[]): string | null {
  const name = label.trim();
  if (!name) return "Give the profile a name";
  if (name.length > PROFILE_LABEL_MAX) return `Keep the name under ${PROFILE_LABEL_MAX + 1} characters`;
  const lower = name.toLowerCase();
  if (taken.some((other) => other.toLowerCase() === lower)) return "You already have a profile with that name";
  return null;
}

export function isProfileIcon(value: unknown): value is ProfileIcon {
  return typeof value === "string" && (PROFILE_ICONS as readonly string[]).includes(value);
}

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
export type OidcPatch = z.infer<typeof oidcPatchSchema>;

export type AuthConfig = {
  local: boolean;
  oidc: { enabled: boolean; name: string } | null;
};
