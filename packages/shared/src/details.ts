/**
 * Your details: what a person keeps about their household (people, IDs, insurance, vehicles) so bots
 * can fill forms with it. A private field is encrypted like a secret and never leaves the API: a bot
 * types it into a page with `use_details`, on a card the person allows each time.
 */
export const DETAIL_KINDS = ["person", "document", "insurance", "vehicle", "other"] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

export const DETAIL_KIND_LABELS: Record<DetailKind, string> = {
  person: "Person",
  document: "ID or document",
  insurance: "Insurance",
  vehicle: "Vehicle",
  other: "Something else",
};

export function isDetailKind(value: unknown): value is DetailKind {
  return typeof value === "string" && (DETAIL_KINDS as readonly string[]).includes(value);
}

/** The fields a new record of each kind starts with; the person adds, renames or removes any. */
export const DETAIL_PRESETS: Record<DetailKind, readonly { label: string; private: boolean }[]> = {
  person: [
    { label: "Full name", private: false },
    { label: "Date of birth", private: false },
    { label: "Phone", private: false },
    { label: "Email", private: false },
    { label: "Address", private: false },
  ],
  document: [
    { label: "Number", private: true },
    { label: "Name on it", private: false },
    { label: "Issued by", private: false },
  ],
  insurance: [
    { label: "Provider", private: false },
    { label: "Member ID", private: true },
    { label: "Group number", private: true },
    { label: "Phone", private: false },
  ],
  vehicle: [
    { label: "Make and model", private: false },
    { label: "Plate", private: false },
    { label: "VIN", private: true },
  ],
  other: [{ label: "Details", private: false }],
};

export const DETAIL_LIMITS = { records: 100, fields: 20, label: 60, fieldLabel: 40, value: 500 } as const;

/** A field as the web and bots see it: a private one's value is never sent, only whether one is saved. */
export type DetailField = { id: string; label: string; private: boolean; saved: boolean; value: string | null };

export type DetailRecord = {
  id: string;
  kind: DetailKind;
  label: string;
  /** The day it runs out (YYYY-MM-DD), for a passport, a licence or a policy; the primary bot speaks up before then. */
  expiresOn: string | null;
  fields: DetailField[];
  createdAt: string;
  updatedAt: string;
};

/** A field as it is saved: with `id`, the field it was; a private one left empty keeps what it had. */
export type DetailFieldInput = { id?: string; label: string; private: boolean; value: string };
export type DetailInput = { kind: DetailKind; label: string; expiresOn: string | null; fields: DetailFieldInput[] };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a YYYY-MM-DD names a real day. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A record the person typed, checked and tidied, or what is wrong with it in words. */
export function checkDetail(raw: Record<string, unknown>): { detail: DetailInput } | { error: string } {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  if (!isDetailKind(raw.kind)) return { error: "Pick what kind of details these are." };
  const label = text(raw.label);
  if (!label) return { error: "Give it a name, like Maya or Passport." };
  if (label.length > DETAIL_LIMITS.label) return { error: "That name is too long." };
  const expires = text(raw.expiresOn);
  if (expires && !isDay(expires)) return { error: "That expiry date doesn't look right." };
  if (!Array.isArray(raw.fields)) return { error: "Add at least one detail." };
  if (raw.fields.length > DETAIL_LIMITS.fields) return { error: `Keep it to ${DETAIL_LIMITS.fields} details or fewer.` };
  const fields: DetailFieldInput[] = [];
  const seen = new Set<string>();
  for (const item of raw.fields) {
    const field = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const name = text(field.label);
    const value = text(field.value);
    if (!name && !value) continue;
    if (!name) return { error: "Every detail needs a name." };
    if (name.length > DETAIL_LIMITS.fieldLabel) return { error: `"${name.slice(0, 20)}…" is too long a name for a detail.` };
    if (value.length > DETAIL_LIMITS.value) return { error: `${name} is too long.` };
    const key = squash(name);
    if (!key) return { error: `"${name}" needs a letter or a number in it.` };
    if (seen.has(key)) return { error: `There are two details called ${name}.` };
    seen.add(key);
    fields.push({ ...(typeof field.id === "string" && field.id ? { id: field.id } : {}), label: name, private: field.private === true, value });
  }
  if (!fields.length) return { error: "Add at least one detail." };
  return { detail: { kind: raw.kind, label, expiresOn: expires || null, fields } };
}

/** The reminders an expiry date gets: so many days before it, and on the day it runs out. */
export const EXPIRY_STAGES = [90, 30, 7, 0] as const;

/** Days from one YYYY-MM-DD to another, negative once it has passed. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The reminder an expiry date is due for today: the nearest of `EXPIRY_STAGES` it has reached, or null while it's further off. */
export function expiryStage(expiresOn: string, today: string): number | null {
  const left = daysBetween(today, expiresOn);
  return [...EXPIRY_STAGES].reverse().find((stage) => left <= stage) ?? null;
}

/** Whether a record's name and a name a bot gave for it are the same, however each is written. */
export function sameDetailName(a: string, b: string): boolean {
  return squash(a) === squash(b) && squash(a) !== "";
}
