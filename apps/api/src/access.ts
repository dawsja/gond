import type { Context, Next } from "hono";
import type { Env } from "./app.ts";
import { getBot } from "./data/bots.ts";
import { getThread } from "./data/threads.ts";
import { isAdmin } from "./data/users.ts";

export function userId(c: Context<Env>): string {
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
