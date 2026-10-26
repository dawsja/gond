import type { UserRole } from "@gond/shared";
import { Bell, Gauge, Globe, Layers, Link2, Blocks, BrainCircuit, Info, KeyRound, LogIn, MessageCircleHeart, Mic, Monitor, Palette, Server, Sparkles, UserRound } from "lucide-react";

/** The headings Settings' list is grouped under; a section with no group sits on its own at the end. */
export const SETTINGS_GROUPS = [
  { id: "you", label: "You" },
  { id: "bots", label: "Bots" },
  { id: "server", label: "Server" },
] as const;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]["id"];

export const SETTINGS_SECTIONS = [
  { id: "account", group: "you", label: "Account", blurb: "Your picture, your password, and exporting your chats.", icon: UserRound, admin: false },
  { id: "profiles", group: "you", label: "Profiles", blurb: "Separate worlds, like Work and home: each with its own bots, chats, keys and computer.", icon: Layers, admin: false },
  { id: "notifications", group: "you", label: "Notifications", blurb: "Where Gond tells you a bot finished or needs you: this browser or app, and a service like ntfy or Pushover.", icon: Bell, admin: false },
  { id: "appearance", group: "you", label: "Appearance", blurb: "Light or dark, and the color of your chats.", icon: Palette, admin: false },
  { id: "personalization", group: "you", label: "Personalization", blurb: "How your bots talk to you: their style, and how many emoji.", icon: MessageCircleHeart, admin: false },
  { id: "computer", group: "you", label: "Your computer", blurb: "Where your bots work, and starting it fresh.", icon: Monitor, admin: false },
  { id: "ai", group: "bots", label: "AI", blurb: "What your bots run on: Claude Code on your plan or a key, your ChatGPT or Grok plan, or an API key.", icon: BrainCircuit, admin: false },
  { id: "usage", group: "bots", label: "Usage", blurb: "How much of your plan is left, and what each of your bots used.", icon: Gauge, admin: false },
  { id: "voice", group: "bots", label: "Voice", blurb: "Talk to your bots: the model that turns speech into text, and the voice your primary bot speaks in on a call.", icon: Mic, admin: false },
  { id: "skills", group: "bots", label: "Skills", blurb: "How to do a job, written once and shared by all of your bots.", icon: Sparkles, admin: false },
  { id: "apps", group: "bots", label: "Apps", blurb: "Gmail, Slack and the rest for your bots, and your own MCP tool servers.", icon: Blocks, admin: false },
  { id: "secrets", group: "bots", label: "Secrets", blurb: "The cards, sign-ins and keys you gave your bots. Only their names are shown.", icon: KeyRound, admin: false },
  { id: "spaces", group: "bots", label: "Spaces", blurb: "What your bots may do in rooms shared with people on other Gonds, and which may join.", icon: Link2, admin: false },
  { id: "shared-computer", group: "server", label: "Shared computer", blurb: "The computer everyone's bots run on: how it's doing, updating it and resetting it.", icon: Server, admin: true },
  { id: "auth", group: "server", label: "Authentication", blurb: "Your identity provider, and the people who have signed in.", icon: LogIn, admin: true },
  { id: "other-gonds", group: "server", label: "Other Gonds", blurb: "Spaces on this Gond: its name to others, its relay, and the Gonds it knows.", icon: Globe, admin: true },
  { id: "about", group: null, label: "About", blurb: "This app's version and updates, its server, and where Gond comes from.", icon: Info, admin: false },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

export function sectionsFor(role: UserRole) {
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
