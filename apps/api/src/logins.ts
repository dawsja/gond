import { LOGIN_FIELD_KINDS, type LoginField, type LoginFieldKind } from "@gond/shared";

// A sign-in detail is held here, for the conversation that asked, until it goes stale: the bot
// types it with type_login and never sees it. Codes and anything the person didn't ask to
// remember live only here; remembered ones are also secrets with a site.
const HELD_MS = 30 * 60 * 1000;

type Held = { value: string; at: number };
const holder = globalThis as typeof globalThis & { __gondLogins?: Map<string, Held> };

function held(): Map<string, Held> {
  return (holder.__gondLogins ??= new Map());
}

const keyOf = (threadId: string, name: string) => `${threadId}\n${name}`;

export function holdLogin(threadId: string, name: string, value: string) {
  held().set(keyOf(threadId, name), { value, at: Date.now() });
}

export function heldLogin(threadId: string, name: string): string | null {
  const key = keyOf(threadId, name);
  const hit = held().get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > HELD_MS) {
    held().delete(key);
    return null;
  }
  return hit.value;
}

export function heldLoginValues(): string[] {
  const out: string[] = [];
  for (const [key, hit] of held()) {
    if (Date.now() - hit.at > HELD_MS) held().delete(key);
    else out.push(hit.value);
  }
  return out;
}

/** A detail the person changed: what their conversations still held of the old one goes. */
export function forgetHeldLogin(name: string, threadIds: Iterable<string>) {
  for (const threadId of threadIds) held().delete(keyOf(threadId, name));
}

export function forgetHeldLogins(threadId: string) {
  for (const key of held().keys()) if (key.startsWith(`${threadId}\n`)) held().delete(key);
}

export function loginPrefix(site: string): string {
  const words = site
    .toUpperCase()
    .replace(/^HTTPS?:\/\//, "")
    .replace(/^WWW\./, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  if (!words) return "";
  return /^[A-Z]/.test(words) ? words : `SITE_${words}`;
}

export function loginFields(prefix: string, raw: unknown): LoginField[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "fields needs at least one of email, username, phone, password or code" };
  if (raw.length > 4) return { error: "ask for four fields at most" };
  const fields: LoginField[] = [];
  const seen = new Map<LoginFieldKind, number>();
  for (const item of raw) {
    const entry = (item && typeof item === "object" ? item : { kind: item }) as { kind?: unknown; label?: unknown };
    const kind = String(entry.kind ?? "").toLowerCase() as LoginFieldKind;
    if (!LOGIN_FIELD_KINDS.includes(kind)) return { error: `fields are ${LOGIN_FIELD_KINDS.join(", ")}; "${String(entry.kind ?? "")}" isn't one` };
    const count = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, count);
    const label = typeof entry.label === "string" ? entry.label.trim().slice(0, 60) : "";
    fields.push({ name: `${prefix}_${kind.toUpperCase()}${count > 1 ? `_${count}` : ""}`, label, kind });
  }
  return fields;
}

export const rememberable = (field: LoginField) => field.kind !== "code";
