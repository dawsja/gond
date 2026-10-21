export const VIEWING_TTL_MS = 60_000;

const views = new Map<string, { userId: string; threadId: string; until: number }>();

export function markViewing(userId: string, client: string, threadId: string | null, now = Date.now()) {
  const key = `${userId}\0${client}`;
  if (threadId) views.set(key, { userId, threadId, until: now + VIEWING_TTL_MS });
  else views.delete(key);
}

export function isViewing(userId: string, threadId: string, now = Date.now()): boolean {
  let found = false;
  for (const [key, view] of views) {
    if (view.until <= now) views.delete(key);
    else if (view.userId === userId && view.threadId === threadId) found = true;
  }
  return found;
}

const lastActive = new Map<string, { device: string; at: number }>();

/** The person used this browser or app just now: from here on, notices go only to it. */
export function markActive(userId: string, device: string, now = Date.now()) {
  const current = lastActive.get(userId);
  if (!current || current.at <= now) lastActive.set(userId, { device, at: now });
}

/** Null until the person has been seen since the API started; then every device gets the notice. */
export function activeDevice(userId: string): string | null {
  return lastActive.get(userId)?.device ?? null;
}
