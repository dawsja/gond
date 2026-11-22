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

export type DetailInputKind = "text" | "date" | "email" | "phone" | "vin";

export type DetailFieldType = { id: string; label: string; input: DetailInputKind; private: boolean; kind: Exclude<DetailKind, "other">; aliases: readonly string[] };

export const DETAIL_FIELD_TYPES: readonly DetailFieldType[] = [
  { id: "full_name", label: "Full name", input: "text", private: false, kind: "person", aliases: ["Name", "Legal name"] },
  { id: "date_of_birth", label: "Date of birth", input: "date", private: false, kind: "person", aliases: ["DOB", "Birthday", "Birth date", "Birthdate"] },
  { id: "email", label: "Email", input: "email", private: false, kind: "person", aliases: ["Email address", "E-mail"] },
  { id: "phone", label: "Phone", input: "phone", private: false, kind: "person", aliases: ["Phone number", "Mobile", "Cell", "Telephone"] },
  { id: "address", label: "Address", input: "text", private: false, kind: "person", aliases: ["Home address", "Street address", "Mailing address"] },
  { id: "allergies", label: "Allergies", input: "text", private: false, kind: "person", aliases: ["Allergy"] },
  { id: "number", label: "Number", input: "text", private: true, kind: "document", aliases: ["Document number", "ID number", "Passport number", "Licence number", "License number"] },
  { id: "name_on_it", label: "Name on it", input: "text", private: false, kind: "document", aliases: ["Name on document"] },
  { id: "issued_by", label: "Issued by", input: "text", private: false, kind: "document", aliases: ["Issuer", "Issuing country", "Issuing authority"] },
  { id: "issue_date", label: "Issue date", input: "date", private: false, kind: "document", aliases: ["Date of issue", "Issued on"] },
  { id: "provider", label: "Provider", input: "text", private: false, kind: "insurance", aliases: ["Insurer", "Insurance company"] },
  { id: "member_id", label: "Member ID", input: "text", private: true, kind: "insurance", aliases: ["Member number", "Subscriber ID"] },
  { id: "policy_number", label: "Policy number", input: "text", private: true, kind: "insurance", aliases: ["Policy", "Policy ID"] },
  { id: "group_number", label: "Group number", input: "text", private: true, kind: "insurance", aliases: ["Group ID"] },
  { id: "make_model", label: "Make and model", input: "text", private: false, kind: "vehicle", aliases: ["Make", "Model", "Car"] },
  { id: "plate", label: "Plate", input: "text", private: false, kind: "vehicle", aliases: ["License plate", "Licence plate", "Plate number", "Registration"] },
  { id: "vin", label: "VIN", input: "vin", private: true, kind: "vehicle", aliases: ["Vehicle identification number"] },
];

export const CUSTOM_DETAIL = "custom";

export function detailFieldType(id: string): DetailFieldType | null {
  return DETAIL_FIELD_TYPES.find((type) => type.id === id) ?? null;
}

export function detailTypeFor(label: string): DetailFieldType | null {
  return DETAIL_FIELD_TYPES.find((type) => [type.label, ...type.aliases].some((name) => sameDetailName(name, label))) ?? null;
}

export const DETAIL_PRESETS: Record<DetailKind, readonly { type: string; label?: string }[]> = {
  person: [{ type: "full_name" }, { type: "date_of_birth" }, { type: "phone" }, { type: "email" }, { type: "address" }],
  document: [{ type: "number" }, { type: "name_on_it" }, { type: "issued_by" }],
  insurance: [{ type: "provider" }, { type: "member_id" }, { type: "group_number" }, { type: "phone" }],
  vehicle: [{ type: "make_model" }, { type: "plate" }, { type: "vin" }],
  other: [{ type: CUSTOM_DETAIL, label: "Details" }],
};

export const DETAIL_LIMITS = { records: 100, fields: 20, label: 60, fieldLabel: 40, value: 500 } as const;

/** A field as the web and bots see it: a private one's value is never sent, only whether one is saved. */
export type DetailField = { id: string; type: string; label: string; private: boolean; saved: boolean; value: string | null };

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
export type DetailFieldInput = { id?: string; type: string; label: string; private: boolean; value: string };
export type DetailInput = { kind: DetailKind; label: string; expiresOn: string | null; fields: DetailFieldInput[] };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/**
 * A day as YYYY-MM-DD from how a person or a bot wrote it ("2018-03-03", "March 3, 2018", "03/03/2018"),
 * read in the local calendar so it never moves a day; null when it isn't plainly one.
 */
export function toDay(value: string): string | null {
  const text = value.trim();
  if (isDay(text)) return text;
  if (!/\b\d{4}\b/.test(text) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return null;
  const at = new Date(text);
  // Parsing rolls a day that doesn't exist into the next month (31 February is 3 March): its day must be one written.
  if (Number.isNaN(at.getTime()) || !(text.match(/\d+/g) ?? []).map(Number).includes(at.getDate())) return null;
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return isDay(day) ? day : null;
}

const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const PHONE = /^\+?[\d\s().-]+$/;
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

export function checkDetailValue(input: DetailInputKind, raw: string): { value: string } | { error: string } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { value };
  switch (input) {
    case "date": {
      const day = toDay(value);
      return day ? { value: day } : { error: "Pick a date from the calendar." };
    }
    case "email":
      return EMAIL.test(value) ? { value } : { error: "An email needs an @ and a domain, like sam@example.com." };
    case "phone": {
      const digits = value.replace(/\D/g, "").length;
      return PHONE.test(value) && digits >= 7 && digits <= 15 ? { value } : { error: "A phone number is 7 to 15 digits, like +1 555 014 2000." };
    }
    case "vin": {
      const vin = value.toUpperCase().replace(/[\s-]/g, "");
      return VIN.test(vin) ? { value: vin } : { error: "A VIN is 17 letters and numbers, without I, O or Q." };
    }
    default:
      return { value };
  }
}

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

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
    const known = detailFieldType(text(field.type));
    const name = known?.label ?? text(field.label);
    const given = text(field.value);
    if (!known && !name && !given) continue;
    if (!name) return { error: "Every detail needs a name." };
    if (name.length > DETAIL_LIMITS.fieldLabel) return { error: `"${name.slice(0, 20)}…" is too long a name for a detail.` };
    if (given.length > DETAIL_LIMITS.value) return { error: `${name} is too long.` };
    const checked = checkDetailValue(known?.input ?? "text", given);
    if ("error" in checked) return { error: `${name}: ${checked.error}` };
    const key = squash(name);
    if (!key) return { error: `"${name}" needs a letter or a number in it.` };
    if (seen.has(key)) return { error: `There are two details called ${name}.` };
    seen.add(key);
    fields.push({ ...(typeof field.id === "string" && field.id ? { id: field.id } : {}), type: known?.id ?? CUSTOM_DETAIL, label: name, private: field.private === true, value: checked.value });
  }
  if (!fields.length) return { error: "Add at least one detail." };
  return { detail: { kind: raw.kind, label, expiresOn: expires || null, fields } };
}

export const EXPIRY_STAGES = [90, 30, 7, 0] as const;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function expiryStage(expiresOn: string, today: string): number | null {
  const left = daysBetween(today, expiresOn);
  return [...EXPIRY_STAGES].reverse().find((stage) => left <= stage) ?? null;
}

export function sameDetailName(a: string, b: string): boolean {
  return squash(a) === squash(b) && squash(a) !== "";
}
