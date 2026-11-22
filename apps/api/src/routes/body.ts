import type { Context } from "hono";

export type Body = Record<string, unknown>;

export async function readBody(c: Context): Promise<Body> {
  const value: unknown = await c.req.json().catch(() => null);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Body) : {};
}