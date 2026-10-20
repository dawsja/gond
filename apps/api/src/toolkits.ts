import type { Bot } from "@gond/shared";
import { getUser, isAdmin } from "./data/users.ts";

const TOOLKIT_SLUG = /^[a-z0-9_-]{1,64}$/;

export function ownerIsAdmin(userId: string): boolean {
  return isAdmin(getUser(userId));
}

export function allowedToolkits(toolkits: string[]): string[] {
  return toolkits.filter((t) => TOOLKIT_SLUG.test(t));
}

export function usableBot<T extends Pick<Bot, "toolkits" | "userId">>(bot: T): T {
  return { ...bot, toolkits: allowedToolkits(bot.toolkits) };
}
