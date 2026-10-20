import type { AuthConfig, Me } from "@gond/shared";
import { cookies } from "next/headers";
import { apiUrl } from "@/lib/api-url";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
    cache: "no-store",
  });
}

export type SessionUser = Me;

export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const res = await apiFetch("/api/me");
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: SessionUser };
    return data.user ?? null;
  } catch {
    return null;
  }
}

export async function getAuthConfig(): Promise<AuthConfig | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/auth-config`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as AuthConfig;
  } catch {
    return null;
  }
}

export async function countAccounts(): Promise<number | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/account`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { accounts: number }).accounts;
  } catch {
    return null;
  }
}

export function safeNext(value: string | null | undefined, fallback = "/app") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  try {
    const base = "http://gond.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}
