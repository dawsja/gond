"use client";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function statusMessage(status: number): string {
  if (status === 401) return "You've been signed out. Sign in again to carry on.";
  if (status === 403) return "You don't have access to that.";
  if (status === 404) return "That isn't there any more.";
  if (status === 413) return "That's too large to send.";
  if (status === 429) return "Too many tries at once. Wait a moment and try again.";
  if (status === 503) return "Gond is busy updating. Try again in a minute.";
  if (status >= 500) return "Gond couldn't do that just now. Try again in a moment.";
  return "That didn't work. Try again.";
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  }).catch((failure: unknown) => {
    if (init.signal?.aborted) throw failure;
    throw new ApiError("Can't reach Gond. Check your connection and try again.", 0);
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(data.error ?? statusMessage(res.status), res.status);
  return data;
}

export const post = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });

const inFlight = new Map<string, Promise<unknown>>();

/** A GET that shares one request with every caller asking for the same path while it is on its way (several cards in one conversation). */
export function apiShared<T = unknown>(path: string): Promise<T> {
  let pending = inFlight.get(path) as Promise<T> | undefined;
  if (!pending) {
    pending = api<T>(path).finally(() => inFlight.delete(path));
    inFlight.set(path, pending);
  }
  return pending;
}
