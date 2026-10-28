import { cardBrand, CARD_NICKNAME_MAX, luhnValid, SECRET_NAME, SECRET_REF, type CardDetails, type CardMeta, type LoginField, type SecretMeta, type SecretRequest } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit, settingsChanged, threadChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { heldLoginValues } from "../logins.ts";
import { createRedactor } from "../redact.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";
import { allComposioKeys } from "./composio-keys.ts";
import { allMcpProxyTokens } from "./mcp.ts";
import { allProviderKeys, allProviderProxyTokens } from "./providers.ts";

function cardMetaOf(raw: string | null): CardMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CardMeta;
  } catch {
    return null;
  }
}

export function listSecrets(userId: string): SecretMeta[] {
  const rows = ensureDatabase().query("SELECT name, requested_by, site, card, created_at, updated_at FROM gond_secrets WHERE user_id = ? ORDER BY name").all(userId) as { name: string; requested_by: string | null; site: string | null; card: string | null; created_at: string; updated_at: string }[];
  return rows.map((r) => ({ name: r.name, requestedBy: r.requested_by, site: r.site, card: cardMetaOf(r.card), createdAt: r.created_at, updatedAt: r.updated_at }));
}

function cardName(userId: string, meta: CardMeta): string {
  const slug = (meta.nickname || `${meta.brand} ${meta.last4}`).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || meta.last4;
  const base = `SAVED_CARD_${slug}`;
  let name = base;
  for (let n = 2; hasSecret(userId, name); n += 1) name = `${base}_${n}`;
  return name;
}

/**
 * Saves a payment card as one secret, its details encrypted together; only its name, brand, last four
 * digits and expiry are kept readable. With `name` it replaces that card's details and nickname.
 */
export function saveCard(userId: string, card: CardDetails, nickname: string, name?: string): string {
  if (!luhnValid(card.number)) throw new Error("That card number doesn't look right");
  const meta: CardMeta = { nickname: nickname.trim().slice(0, CARD_NICKNAME_MAX), brand: cardBrand(card.number), last4: card.number.slice(-4), expires: card.expiry };
  const target = name ?? cardName(userId, meta);
  const at = now();
  ensureDatabase()
    .query("INSERT INTO gond_secrets (user_id, name, value, requested_by, site, card, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET value = excluded.value, card = excluded.card, updated_at = excluded.updated_at")
    .run(userId, target, encryptSecret(JSON.stringify(card)), JSON.stringify(meta), at, at);
  settingsChanged();
  return target;
}

/** A saved card's details, for typing into a checkout the person allowed. Never send them to a route. */
export function readCard(userId: string, name: string): { card: CardDetails; meta: CardMeta } | null {
  const row = ensureDatabase().query("SELECT value, card FROM gond_secrets WHERE user_id = ? AND name = ? AND card IS NOT NULL").get(userId, name) as { value: string; card: string } | null;
  const meta = cardMetaOf(row?.card ?? null);
  if (!row || !meta) return null;
  try {
    return { card: JSON.parse(decryptSecret(row.value)) as CardDetails, meta };
  } catch {
    return null;
  }
}

export function deleteSecret(userId: string, name: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_secrets WHERE user_id = ? AND name = ?").run(userId, name).changes > 0;
  if (changed) settingsChanged();
  return changed;
}

export function hasSecret(userId: string, name: string): boolean {
  return Boolean(ensureDatabase().query("SELECT 1 FROM gond_secrets WHERE user_id = ? AND name = ?").get(userId, name));
}

export function setSecret(userId: string, name: string, value: string, requestedBy: string | null = null, site: string | null = null): void {
  if (!SECRET_NAME.test(name)) throw new Error("A secret's name is letters, digits and underscores, like OPENAI_API_KEY");
  if (!value || value.length > 8_000) throw new Error("The value is empty or too long");
  const at = now();
  ensureDatabase()
    .query("INSERT INTO gond_secrets (user_id, name, value, requested_by, site, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET value = excluded.value, requested_by = COALESCE(excluded.requested_by, gond_secrets.requested_by), site = excluded.site, card = NULL, updated_at = excluded.updated_at")
    .run(userId, name, encryptSecret(value), requestedBy, site, at, at);
  settingsChanged();
}

/**
 * Replaces the value of a secret the person already has, keeping its site and who asked for it; written
 * afresh, so it is encrypted again with a new IV. False when there is no such secret.
 */
export function changeSecret(userId: string, name: string, value: string): boolean {
  const row = ensureDatabase().query("SELECT requested_by, site FROM gond_secrets WHERE user_id = ? AND name = ? AND card IS NULL").get(userId, name) as { requested_by: string | null; site: string | null } | null;
  if (!row) return false;
  setSecret(userId, name, value, row.requested_by, row.site);
  return true;
}

/** The plain value, for injection only. Never send it to a route or the box. */
export function readSecret(userId: string, name: string): string | null {
  // A card is typed only from a card request, field by field; never into a command, a header or a page by its name.
  const row = ensureDatabase().query("SELECT value FROM gond_secrets WHERE user_id = ? AND name = ? AND card IS NULL").get(userId, name) as { value: string } | null;
  return row ? decryptSecret(row.value) : null;
}

/** A saved sign-in detail: only secrets a login card stored, never an API key, can be typed into a page. */
export function readLogin(userId: string, name: string): string | null {
  const row = ensureDatabase().query("SELECT value FROM gond_secrets WHERE user_id = ? AND name = ? AND site IS NOT NULL").get(userId, name) as { value: string } | null;
  return row ? decryptSecret(row.value) : null;
}

export function secretHider(): (text: string) => string {
  return createRedactor(allSecretValues(), Infinity);
}

export function hideSecrets(text: string): string {
  return secretHider()(text);
}

export function containsSecret(data: Uint8Array): boolean {
  const secrets = allSecretValues().filter((s) => s.length >= 8);
  if (!secrets.length) return false;
  const bytes = Buffer.from(data);
  return secrets.some((secret) => bytes.includes(secret));
}

/** A card number as a page or a person writes it: whole, in fours, or Amex's 4-6-5, with spaces or dashes. */
export function cardNumberForms(number: string): string[] {
  if (!luhnValid(number)) return [];
  const groups = number.length === 15 ? [number.slice(0, 4), number.slice(4, 10), number.slice(10)] : (number.match(/.{1,4}/g) ?? []);
  return [number, groups.join(" "), groups.join("-")];
}

export function allSecretValues(): string[] {
  const rows = ensureDatabase().query("SELECT value, card FROM gond_secrets").all() as { value: string; card: string | null }[];
  const out: string[] = [];
  for (const row of rows) {
    try {
      const value = decryptSecret(row.value);
      if (!row.card) out.push(value);
      else out.push(...cardNumberForms((JSON.parse(value) as CardDetails).number));
    } catch {
      /* an unreadable secret can't leak either */
    }
  }
  const serverComposio = (process.env.COMPOSIO_API_KEY ?? "").trim();
  return [...out, ...heldLoginValues().flatMap((value) => [value, ...cardNumberForms(value).slice(1)]), ...allProviderKeys(), ...allProviderProxyTokens(), ...allMcpProxyTokens(), ...allComposioKeys(), ...(serverComposio ? [serverComposio] : [])];
}

export function injectSecrets(text: string, userId: string, missing?: (name: string) => void): string {
  return text.replace(SECRET_REF, (_match, name: string) => {
    const value = readSecret(userId, name);
    if (value === null) missing?.(name);
    return value ?? "";
  });
}

type RequestRow = { id: string; bot_id: string; thread_id: string; name: string; reason: string; target: SecretRequest["target"] | null; site: string | null; fields: string | null; total: string | null; card: string | null; status: SecretRequest["status"]; replaces: number; created_at: string; resolved_at: string | null };

function toRequest(row: RequestRow): SecretRequest {
  return { id: row.id, botId: row.bot_id, threadId: row.thread_id, name: row.name, reason: row.reason, target: row.target ?? "secret", replaces: row.replaces === 1, site: row.site, fields: parseFields(row.fields), total: row.total, card: row.card, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at };
}

function parseFields(raw: string | null): LoginField[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as LoginField[]) : [];
  } catch {
    return [];
  }
}

export function createSecretRequest(input: { botId: string; threadId: string; name: string; reason: string; target?: SecretRequest["target"]; site?: string | null; fields?: LoginField[]; replaces?: boolean; total?: string | null }): SecretRequest {
  const id = newId("sr");
  ensureDatabase()
    .query("INSERT INTO gond_secret_requests (id, bot_id, thread_id, name, reason, target, site, fields, replaces, total, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
    .run(id, input.botId, input.threadId, input.name, input.reason, input.target ?? "secret", input.site ?? null, JSON.stringify(input.fields ?? []), input.replaces ? 1 : 0, input.total ?? null, now());
  return getSecretRequest(id)!;
}

export function getSecretRequest(id: string): SecretRequest | null {
  const row = ensureDatabase().query("SELECT * FROM gond_secret_requests WHERE id = ?").get(id) as RequestRow | null;
  return row ? toRequest(row) : null;
}

export function resolveSecretRequest(id: string, status: Exclude<SecretRequest["status"], "pending">, card: string | null = null): SecretRequest | null {
  const current = getSecretRequest(id);
  if (!current || current.status !== "pending") return current;
  ensureDatabase().query("UPDATE gond_secret_requests SET status = ?, card = ?, resolved_at = ? WHERE id = ?").run(status, card, now(), id);
  const next = getSecretRequest(id)!;
  threadChanged(next.threadId);
  emit({ topic: "approvals" });
  return next;
}
