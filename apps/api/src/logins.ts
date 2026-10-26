import { CARD_FIELDS, cardFieldValue, coverLogin, LOGIN_FIELD_KINDS, type CardDetails, type CardField, type LoginField, type LoginFieldKind } from "@gond/shared";

// A sign-in detail is held here, for the conversation that asked, until it goes stale: the bot
// types it with type_login and never sees it. Codes and anything the person didn't ask to
// remember live only here; remembered ones are also secrets with a site.
const HELD_MS = 30 * 60 * 1000;
// A card the person said yes to is for the checkout in front of the bot, not the rest of the afternoon.
export const CARD_HELD_MS = 10 * 60 * 1000;

type Held = { value: string; until: number };
const holder = globalThis as typeof globalThis & { __gondLogins?: Map<string, Held> };

function held(): Map<string, Held> {
  return (holder.__gondLogins ??= new Map());
}

const keyOf = (threadId: string, name: string) => `${threadId}\n${name}`;

export function holdLogin(threadId: string, name: string, value: string, ms = HELD_MS) {
  held().set(keyOf(threadId, name), { value, until: Date.now() + ms });
}

/** The card the person picked, for this conversation, under the names a bot types it by. */
export function holdCard(threadId: string, card: CardDetails) {
  for (const field of Object.keys(CARD_FIELDS) as CardField[]) {
    const value = cardFieldValue(card, field);
    if (value) holdLogin(threadId, field, value, CARD_HELD_MS);
    else held().delete(keyOf(threadId, field));
  }
}

export function heldLogin(threadId: string, name: string): string | null {
  const key = keyOf(threadId, name);
  const hit = held().get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) {
    held().delete(key);
    return null;
  }
  return hit.value;
}

export function heldLoginValues(): string[] {
  const out: string[] = [];
  for (const [key, hit] of held()) {
    if (Date.now() > hit.until) held().delete(key);
    else out.push(hit.value);
  }
  return out;
}

/** What this conversation holds, to keep out of what a bot reads back off the screen. */
export function heldIn(threadId: string): string[] {
  const prefix = `${threadId}\n`;
  return [...held()].flatMap(([key, hit]) => (key.startsWith(prefix) && Date.now() <= hit.until ? [hit.value] : []));
}

/** A detail the person changed: what their conversations still held of the old one goes. */
export function forgetHeldLogin(name: string, threadIds: Iterable<string>) {
  for (const threadId of threadIds) held().delete(keyOf(threadId, name));
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

/**
 * What a site goes by, squashed: its name without a "(host)" note, and the note as a host. A bot
 * names one site three ways ("Nginx Proxy Manager", "… (npm.zerd.cc)", "… (192.168.6.128:81)"),
 * and each would otherwise be a sign-in of its own that is never found again.
 */
export function siteKeys(site: string): string[] {
  const squash = (part: string) =>
    part
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .replace(/[^a-z0-9]+/g, "");
  const note = /\(([^)]*)\)/.exec(site)?.[1] ?? "";
  const keys = [squash(site.replace(/\([^)]*\)/g, " ")), squash(note)].filter(Boolean);
  return [...new Set(keys)];
}

export type SavedLogin = { name: string; site: string; updatedAt: string };

/**
 * The saved details that sign in to this site, as the field's name for this request to the saved
 * secret's name, or null when nothing saved covers every field. The same site written the same
 * way wins, then the same host, then the same name; among equals, the newest.
 */
export function savedLoginFor(site: string, fields: LoginField[], saved: SavedLogin[]): Map<string, string> | null {
  if (!fields.length || !fields.every(rememberable)) return null;
  const prefix = loginPrefix(site);
  const keys = siteKeys(site);
  const host = keys[1];
  const rank = (other: string) => {
    if (loginPrefix(other) === prefix) return 3;
    const theirs = siteKeys(other);
    if (host && theirs.includes(host)) return 2;
    return theirs.some((key) => keys.includes(key)) ? 1 : 0;
  };
  const sites = new Map<string, { rank: number; newest: string; names: string[] }>();
  for (const row of saved) {
    const score = rank(row.site);
    if (!score) continue;
    const entry = sites.get(row.site) ?? { rank: score, newest: "", names: [] };
    entry.names.push(row.name);
    if (row.updatedAt > entry.newest) entry.newest = row.updatedAt;
    sites.set(row.site, entry);
  }
  const ordered = [...sites.values()].sort((a, b) => b.rank - a.rank || b.newest.localeCompare(a.newest));
  for (const { names } of ordered) {
    const found = coverLogin(fields, names);
    if (found.size === fields.length) return found;
  }
  return null;
}
