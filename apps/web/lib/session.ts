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

/** Who is signed in, or why nobody is: a refusal from the API is signed out, an API that doesn't answer is down, as while it restarts after an update. */
type Session = { user: SessionUser } | { signedOut: true } | { down: true };

export async function getSessionUser(): Promise<Session> {
  let res: Response;
  try {
    res = await apiFetch("/api/me");
  } catch {
    return { down: true };
  }
  if (res.status >= 500) return { down: true };
  if (!res.ok) return { signedOut: true };
  try {
    const data = (await res.json()) as { user?: SessionUser };
    return data.user ? { user: data.user } : { signedOut: true };
  } catch {
    return { down: true };
  }
}

/** Where to sign in so the person comes back to `path` afterwards. */
export function loginHref(path: string): string {
  return `/login?next=${encodeURIComponent(safeNext(path))}`;
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
