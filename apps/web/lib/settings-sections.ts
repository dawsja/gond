import type { UserRole } from "@gond/shared";
import { Blocks, BrainCircuit, KeyRound, LogIn, Monitor, Sparkles, UserRound, Users } from "lucide-react";

export const SETTINGS_SECTIONS = [
  { id: "account", label: "Account", blurb: "Your picture, password, theme and notifications.", icon: UserRound, admin: false },
  { id: "team", label: "Team", blurb: "The people on it and the computer they all share.", icon: Users, admin: true },
  { id: "ai", label: "AI", blurb: "What your bots run on: a coding CLI on your plan, or your API key called directly.", icon: BrainCircuit, admin: false },
  { id: "computer", label: "Computer", blurb: "Your account on the computer your bots use, and starting it fresh.", icon: Monitor, admin: false },
  { id: "skills", label: "Skills", blurb: "How to do a job, written once and shared by all of your bots.", icon: Sparkles, admin: false },
  { id: "apps", label: "Apps", blurb: "Your Composio key, your connected apps and your MCP servers.", icon: Blocks, admin: false },
  { id: "secrets", label: "Secrets", blurb: "The sign-ins and keys you gave your bots. Only their names are shown.", icon: KeyRound, admin: false },
  { id: "auth", label: "Authentication", blurb: "Who can sign in: the OIDC provider, and the people who have.", icon: LogIn, admin: true },
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
