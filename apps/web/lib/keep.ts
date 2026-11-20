/**
 * `next`, with every part equal to the same part of `prev` replaced by `prev`'s own, so whatever
 * didn't change keeps its identity and memoized views of it skip. Lists of objects with an `id` are
 * matched by id, so a row moving up the list is still the same row. Plain JSON values only.
 */
export function keep<T>(prev: T, next: T): T {
  return share(prev, next) as T;
}

function share(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) return shareList(prev, next);
  if (isPlain(prev) && isPlain(next)) return shareObject(prev, next);
  return next;
}

function idOf(value: unknown): string | undefined {
  return isPlain(value) && typeof value.id === "string" ? value.id : undefined;
}

function shareList(prev: unknown[], next: unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  for (const item of prev) {
    const id = idOf(item);
    if (id !== undefined) byId.set(id, item);
  }
  let same = prev.length === next.length;
  const out = next.map((item, at) => {
    const id = idOf(item);
    const match = id === undefined ? prev[at] : byId.get(id);
    const kept = match === undefined ? item : share(match, item);
    if (kept !== prev[at]) same = false;
    return kept;
  });
  return same ? prev : out;
}

function shareObject(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(prev).length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const kept = share(prev[key], next[key]);
    out[key] = kept;
    if (kept !== prev[key] || !(key in prev)) same = false;
  }
  return same ? prev : out;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
