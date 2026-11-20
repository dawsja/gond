export const SECRET_REF = /\{\{\s*secret:([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;

const KEY_HEADER = /auth|token|key|secret|password|cookie/i;

/** A header that carries a key, like Authorization: then the server is reached with that key, never an OAuth sign-in, and a 401 means the key was turned down. */
export function isKeyHeader(name: string): boolean {
  return KEY_HEADER.test(name);
}

export function hasKeyHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(isKeyHeader);
}

export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SecretMeta = {
  name: string;

  requestedBy: string | null;

  site: string | null;
  /** A saved payment card: what it is called and the little of it that may be shown. Null for any other secret. */
  card: CardMeta | null;
  createdAt: string;
  updatedAt: string;
};

export type SecretRequest = {
  id: string;
  botId: string;
  threadId: string;
  name: string;
  reason: string;

  target: "secret" | "composio" | "login" | "card";
  /** The card replaces a secret the person already has: its value is overwritten, never shown. */
  replaces: boolean;

  site: string | null;
  fields: LoginField[];
  /** A card request's total, as the bot said it, and the card the person paid with once they did. */
  total: string | null;
  card: string | null;
  status: "pending" | "given" | "declined" | "expired";
  createdAt: string;
  resolvedAt: string | null;
};

/** A saved card as it may be shown: never more of the number than its last four digits. */
export type CardMeta = { nickname: string; brand: string; last4: string; expires: string };

export type CardDetails = { number: string; expiry: string; cvc: string; name: string; zip: string };

/** What a bot types from the card the person picked, by these names, as with a sign-in's details. */
export const CARD_FIELDS = {
  CARD_NUMBER: "the card number",
  CARD_EXPIRY: "the expiry as MM/YY",
  CARD_MONTH: "the expiry month, MM",
  CARD_YEAR: "the expiry year, YYYY",
  CARD_CVC: "the security code",
  CARD_NAME: "the name on the card",
  CARD_ZIP: "the billing ZIP or postal code",
} as const;
export type CardField = keyof typeof CARD_FIELDS;

export function isCardField(name: string): name is CardField {
  return Object.hasOwn(CARD_FIELDS, name);
}

export const CARD_NICKNAME_MAX = 40;

const digitsOf = (value: string) => value.replace(/[\s-]/g, "");

export function luhnValid(number: string): boolean {
  if (!/^\d{12,19}$/.test(number)) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i += 1) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function cardBrand(number: string): string {
  const n = digitsOf(number);
  if (/^4/.test(n)) return "Visa";
  if (/^3[47]/.test(n)) return "Amex";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return "Mastercard";
  if (/^(6011|65|64[4-9])/.test(n)) return "Discover";
  return "Card";
}

/** "08/28", "0828", "8/2028" and the like as month and two-digit year; null when it isn't one. */
export function parseExpiry(value: string): { month: string; year: string } | null {
  const match = /^\s*(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})\s*$/.exec(value);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  return { month: String(month).padStart(2, "0"), year: match[2]!.slice(-2) };
}

const CODE_PROBLEM = "The security code is the 3 or 4 digits on the card.";

/** A security code typed for one payment, or what is wrong with it; a saved card never keeps one. */
export function checkCardCode(value: unknown): { cvc: string } | { error: string } {
  const cvc = typeof value === "string" ? value.trim() : "";
  return /^\d{3,4}$/.test(cvc) ? { cvc } : { error: CODE_PROBLEM };
}

/**
 * A card the person typed, checked and tidied, or what is wrong with it in words; `partial` lets an
 * empty field stand, and `code: false` is a card to save, which leaves the security code out.
 */
export function checkCard(input: Partial<Record<keyof CardDetails, unknown>>, partial = false, { code = true }: { code?: boolean } = {}): { card: Partial<CardDetails> } | { error: string } {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const card: Partial<CardDetails> = {};
  const number = digitsOf(text(input.number));
  if (number || !partial) {
    if (!luhnValid(number)) return { error: "That card number doesn't look right. Check it and try again." };
    card.number = number;
  }
  const expiry = text(input.expiry);
  if (expiry || !partial) {
    const parsed = parseExpiry(expiry);
    if (!parsed) return { error: "Type the expiry as MM/YY, like 08/28." };
    card.expiry = `${parsed.month}/${parsed.year}`;
  }
  const cvc = text(input.cvc);
  if (code && (cvc || !partial)) {
    if (!/^\d{3,4}$/.test(cvc)) return { error: CODE_PROBLEM };
    card.cvc = cvc;
  }
  const name = text(input.name);
  if (name.length > 100) return { error: "That name is too long." };
  if (name || !partial) card.name = name;
  const zip = text(input.zip);
  if (zip.length > 12) return { error: "That ZIP or postal code is too long." };
  if (zip || !partial) card.zip = zip;
  return { card };
}

/** A card's value for one of the names a bot types it by. */
export function cardFieldValue(card: CardDetails, field: CardField): string {
  const [month = "", year = ""] = card.expiry.split("/");
  switch (field) {
    case "CARD_NUMBER":
      return card.number;
    case "CARD_EXPIRY":
      return card.expiry;
    case "CARD_MONTH":
      return month;
    case "CARD_YEAR":
      return year ? `20${year}` : "";
    case "CARD_CVC":
      return card.cvc;
    case "CARD_NAME":
      return card.name;
    case "CARD_ZIP":
      return card.zip;
  }
}

/** "Personal Visa", or the card's own name when the person gave none. */
export function cardLabel(meta: CardMeta): string {
  return meta.nickname || `${meta.brand} ending ${meta.last4}`;
}

const LOOSE_PARTS: Record<string, keyof CardDetails> = {
  NUMBER: "number",
  NUM: "number",
  EXPIRY: "expiry",
  EXP: "expiry",
  EXPIRATION: "expiry",
  EXPIRES: "expiry",
  CVV: "cvc",
  CVC: "cvc",
  CVV2: "cvc",
  CODE: "cvc",
  ZIP: "zip",
  POSTAL: "zip",
  ZIPCODE: "zip",
  NAME: "name",
};

/**
 * Keys that are one card split up, as a bot asked for them before there were cards: SONIC_CARD_NUMBER,
 * _EXPIRY, _CVV and _ZIP. A group needs at least the number, expiry and code.
 */
export function looseCards(names: string[]): { prefix: string; parts: Partial<Record<keyof CardDetails, string>> }[] {
  const groups = new Map<string, Partial<Record<keyof CardDetails, string>>>();
  for (const name of names) {
    const match = /^(.*CARD)_([A-Z0-9]+)$/.exec(name);
    const part = match ? LOOSE_PARTS[match[2]!] : undefined;
    if (!match || !part) continue;
    const parts = groups.get(match[1]!) ?? {};
    parts[part] ??= name;
    groups.set(match[1]!, parts);
  }
  return [...groups].filter(([, parts]) => parts.number && parts.expiry && parts.cvc).map(([prefix, parts]) => ({ prefix, parts }));
}

export const LOGIN_FIELD_KINDS = ["email", "username", "phone", "password", "code"] as const;
export type LoginFieldKind = (typeof LOGIN_FIELD_KINDS)[number];

export type LoginField = {
  name: string;
  label: string;
  kind: LoginFieldKind;
};

export const LOGIN_FIELD_LABELS: Record<LoginFieldKind, string> = {
  email: "Email",
  username: "Username",
  phone: "Phone number",
  password: "Password",
  code: "Code",
};

/** What a saved sign-in detail is, from the end of its name: "UBER_EATS_PASSWORD" is PASSWORD, a second code CODE_2. */
export function loginDetailOf(name: string): string | null {
  return /_((?:EMAIL|USERNAME|PHONE|PASSWORD|CODE)(?:_\d+)?)$/.exec(name)?.[1] ?? null;
}

/**
 * Which of one site's saved details fills each field, by its kind and count; an email and a
 * username stand in for each other, since a page's "Email or username" is either. A code is never
 * saved, so it is never covered. Fields left out are for the person to type.
 */
export function coverLogin(fields: LoginField[], saved: string[]): Map<string, string> {
  const details = new Map<string, string>();
  for (const name of saved) {
    const detail = loginDetailOf(name);
    if (detail && !details.has(detail)) details.set(detail, name);
  }
  const swap: Partial<Record<string, string>> = { EMAIL: "USERNAME", USERNAME: "EMAIL" };
  const counts = new Map<LoginFieldKind, number>();
  const used = new Set<string>();
  const found = new Map<string, string>();
  for (const field of fields) {
    const count = (counts.get(field.kind) ?? 0) + 1;
    counts.set(field.kind, count);
    if (field.kind === "code") continue;
    const kind = field.kind.toUpperCase();
    const suffix = count > 1 ? `_${count}` : "";
    const name = [kind, swap[kind]].map((k) => (k ? details.get(`${k}${suffix}`) : undefined)).find((n) => n && !used.has(n));
    if (!name) continue;
    used.add(name);
    found.set(field.name, name);
  }
  return found;
}
