import type { UserRole } from "@gond/shared";
import { Bell, Blocks, BrainCircuit, Info, KeyRound, LogIn, MessageCircleHeart, Mic, Monitor, Palette, Server, Sparkles, UserRound } from "lucide-react";

export const SETTINGS_SECTIONS = [
  { id: "account", label: "Account", blurb: "Your picture, your password, and exporting your chats.", icon: UserRound, admin: false },
  { id: "notifications", label: "Notifications", blurb: "Where Gond tells you a bot finished or needs you: this browser or app, and a service like ntfy or Pushover.", icon: Bell, admin: false },
  { id: "appearance", label: "Appearance", blurb: "Light or dark, and the color of your chats.", icon: Palette, admin: false },
  { id: "personalization", label: "Personalization", blurb: "How your bots talk to you: their style, and how many emoji.", icon: MessageCircleHeart, admin: false },
  { id: "shared-computer", label: "Shared computer", blurb: "The computer everyone's bots run on: how it's doing, updating it and resetting it.", icon: Server, admin: true },
  { id: "ai", label: "AI", blurb: "What your bots run on: Claude Code on your plan or a key, your ChatGPT or Grok plan, or an API key.", icon: BrainCircuit, admin: false },
  { id: "voice", label: "Voice", blurb: "Talk to your bots instead of typing: the model that turns speech into text.", icon: Mic, admin: false },
  { id: "computer", label: "Your space", blurb: "Your own space on the computer your bots use, and starting it fresh.", icon: Monitor, admin: false },
  { id: "skills", label: "Skills", blurb: "How to do a job, written once and shared by all of your bots.", icon: Sparkles, admin: false },
  { id: "apps", label: "Apps", blurb: "Gmail, Slack and the rest for your bots, and your own MCP tool servers.", icon: Blocks, admin: false },
  { id: "secrets", label: "Secrets", blurb: "The sign-ins and keys you gave your bots. Only their names are shown.", icon: KeyRound, admin: false },
  { id: "auth", label: "Sign-in", blurb: "Who can sign in to this Gond, and the people who have.", icon: LogIn, admin: true },
  { id: "about", label: "About", blurb: "This app's version and updates, its server, and where Gond comes from.", icon: Info, admin: false },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

export function sectionsFor(role: UserRole) {
  return SETTINGS_SECTIONS.filter((s) => role === "admin" || !s.admin);
}

export function canOpenSection(role: UserRole, section: SettingsSection) {
  return sectionsFor(role).some((s) => s.id === section);
}

export function settingsHref(section: SettingsSection) {
  return `/app/settings/${section}`;
}
