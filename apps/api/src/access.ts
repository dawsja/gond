import type { Context, Next } from "hono";
import type { Env } from "./app.ts";
import { getBot } from "./data/bots.ts";
import { getThread, threadOwner } from "./data/threads.ts";
import { isAdmin } from "./data/users.ts";

/**
 * Whose things a request reads and writes: the profile this device has open, which is the person
 * themselves on their default profile. Everything a person owns is keyed by it.
 */
export function userId(c: Context<Env>): string {
  return c.get("profile") ?? c.get("session").user.id;
}

/** Who is signed in, whichever profile is open: for what is the person's across profiles. */
export function personId(c: Context<Env>): string {
  return c.get("session").user.id;
}

export function admin(c: Context<Env>): boolean {
  return isAdmin(c.get("session").user);
}

export async function requireAdmin(c: Context<Env>, next: Next) {
  if (!admin(c)) return c.json({ error: "Only the admin can do that" }, 403);
  await next();
}

export function ownBot(c: Context<Env>, id: string) {
  const bot = getBot(id);
  return bot && bot.userId === userId(c) ? bot : null;
}

export function ownThread(c: Context<Env>, id: string) {
  const thread = getThread(id);
  return thread && thread.userId === userId(c) ? thread : null;
}

export function ownsThread(c: Context<Env>, id: string): boolean {
  return threadOwner(id) === userId(c);
}
