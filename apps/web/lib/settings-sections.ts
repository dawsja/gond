import type { UserRole } from "@gond/shared";
import { Bell, Gauge, Globe, Layers, Link2, Blocks, BrainCircuit, Info, KeyRound, LogIn, MessageCircleHeart, Mic, Monitor, Palette, Server, Sparkles, UserRound } from "lucide-react";

/** The headings Settings' list is grouped under; a section with no group sits on its own at the end. */
const SETTINGS_GROUPS = [
  { id: "you", label: "You" },
  { id: "bots", label: "Bots" },
  { id: "server", label: "Server" },
] as const;

type SettingsGroup = (typeof SETTINGS_GROUPS)[number]["id"];

export const SETTINGS_SECTIONS = [
  { id: "account", group: "you", label: "Account", blurb: "Change your picture and password, or export your chats.", icon: UserRound, admin: false },
  { id: "profiles", group: "you", label: "Profiles", blurb: "Keep work and home apart. Each profile has its own bots, chats, keys and computer.", icon: Layers, admin: false },
  { id: "notifications", group: "you", label: "Notifications", blurb: "Choose whether this browser or app tells you when a bot finishes or needs you.", icon: Bell, admin: false },
  { id: "appearance", group: "you", label: "Appearance", blurb: "Pick your theme, size and chat color.", icon: Palette, admin: false },
  { id: "personalization", group: "you", label: "Personalization", blurb: "Choose how your bots talk to you and how many emojis they use.", icon: MessageCircleHeart, admin: false },
  { id: "computer", group: "you", label: "Your computer", blurb: "Put the computer your bots work on back the way it was built.", icon: Monitor, admin: false },
  { id: "ai", group: "bots", label: "AI", blurb: "Choose what your bots run on: Claude Code on your plan or a key, your ChatGPT or Grok plan, or an API key.", icon: BrainCircuit, admin: false },
  { id: "usage", group: "bots", label: "Usage", blurb: "See how much of your plan is left and what each bot used.", icon: Gauge, admin: false },
  { id: "voice", group: "bots", label: "Voice", blurb: "Set the key, the models and the voice for the microphone and calls.", icon: Mic, admin: false },
  { id: "skills", group: "bots", label: "Skills", blurb: "A skill says how to do a job. All your bots can use it.", icon: Sparkles, admin: false },
  { id: "apps", group: "bots", label: "Apps", blurb: "Connect Gmail, Slack and other apps to your bots, or add your own MCP servers.", icon: Blocks, admin: false },
  { id: "secrets", group: "bots", label: "Secrets", blurb: "Change or forget the cards, sign-ins and keys you gave your bots. Gond never shows their values.", icon: KeyRound, admin: false },
  { id: "spaces", group: "bots", label: "Spaces", blurb: "Choose which bots may join rooms with people on other Gonds and what they may do there.", icon: Link2, admin: false },
  { id: "shared-computer", group: "server", label: "Shared computer", blurb: "Check on the computer everyone's bots run on, update it or reset it.", icon: Server, admin: true },
  { id: "auth", group: "server", label: "Authentication", blurb: "Set up your identity provider and see who has signed in.", icon: LogIn, admin: true },
  { id: "other-gonds", group: "server", label: "Other Gonds", blurb: "Turn on Spaces, name this Gond, pick its relay and see the Gonds it knows.", icon: Globe, admin: true },
  { id: "about", group: null, label: "About", blurb: "Check the version and updates, see your server and read where Gond comes from.", icon: Info, admin: false },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

function sectionsFor(role: UserRole) {
  return SETTINGS_SECTIONS.filter((s) => role === "admin" || !s.admin);
}

/** The person's sections under their headings, in order; the ungrouped ones last, under none. */
export function groupedSections(role: UserRole, skip?: SettingsSection) {
  const sections = sectionsFor(role).filter((s) => s.id !== skip);
  const groups = SETTINGS_GROUPS.map((g) => ({ id: g.id as SettingsGroup | null, label: g.label as string | null, sections: sections.filter((s) => s.group === g.id) }));
  groups.push({ id: null, label: null, sections: sections.filter((s) => s.group === null) });
  return groups.filter((g) => g.sections.length > 0);
}

export function canOpenSection(role: UserRole, section: SettingsSection) {
  return sectionsFor(role).some((s) => s.id === section);
}

export function settingsHref(section: SettingsSection) {
  return `/app/settings/${section}`;
}
