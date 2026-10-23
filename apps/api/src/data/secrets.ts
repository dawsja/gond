import { SECRET_NAME, SECRET_REF, type LoginField, type SecretMeta, type SecretRequest } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit, settingsChanged, threadChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { heldLoginValues } from "../logins.ts";
import { createRedactor } from "../redact.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";
import { allComposioKeys } from "./composio-keys.ts";
import { allProviderKeys } from "./providers.ts";

export function listSecrets(userId: string): SecretMeta[] {
  const rows = ensureDatabase().query("SELECT name, requested_by, site, created_at, updated_at FROM gond_secrets WHERE user_id = ? ORDER BY name").all(userId) as { name: string; requested_by: string | null; site: string | null; created_at: string; updated_at: string }[];
  return rows.map((r) => ({ name: r.name, requestedBy: r.requested_by, site: r.site, createdAt: r.created_at, updatedAt: r.updated_at }));
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
    .query("INSERT INTO gond_secrets (user_id, name, value, requested_by, site, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET value = excluded.value, requested_by = COALESCE(excluded.requested_by, gond_secrets.requested_by), site = excluded.site, updated_at = excluded.updated_at")
    .run(userId, name, encryptSecret(value), requestedBy, site, at, at);
  settingsChanged();
}

/**
 * Replaces the value of a secret the person already has, keeping its site and who asked for it; written
 * afresh, so it is encrypted again with a new IV. False when there is no such secret.
 */
export function changeSecret(userId: string, name: string, value: string): boolean {
  const row = ensureDatabase().query("SELECT requested_by, site FROM gond_secrets WHERE user_id = ? AND name = ?").get(userId, name) as { requested_by: string | null; site: string | null } | null;
  if (!row) return false;
  setSecret(userId, name, value, row.requested_by, row.site);
  return true;
}

/** The plain value, for injection only. Never send it to a route or the box. */
export function readSecret(userId: string, name: string): string | null {
  const row = ensureDatabase().query("SELECT value FROM gond_secrets WHERE user_id = ? AND name = ?").get(userId, name) as { value: string } | null;
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

export function allSecretValues(): string[] {
  const rows = ensureDatabase().query("SELECT value FROM gond_secrets").all() as { value: string }[];
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(decryptSecret(row.value));
    } catch {
      /* an unreadable secret can't leak either */
    }
  }
  const serverComposio = (process.env.COMPOSIO_API_KEY ?? "").trim();
  return [...out, ...heldLoginValues(), ...allProviderKeys(), ...allComposioKeys(), ...(serverComposio ? [serverComposio] : [])];
}

export function injectSecrets(text: string, userId: string, missing?: (name: string) => void): string {
  return text.replace(SECRET_REF, (_match, name: string) => {
    const value = readSecret(userId, name);
    if (value === null) missing?.(name);
    return value ?? "";
  });
}

type RequestRow = { id: string; bot_id: string; thread_id: string; name: string; reason: string; target: SecretRequest["target"] | null; site: string | null; fields: string | null; status: SecretRequest["status"]; created_at: string; resolved_at: string | null };

function toRequest(row: RequestRow): SecretRequest {
  return { id: row.id, botId: row.bot_id, threadId: row.thread_id, name: row.name, reason: row.reason, target: row.target ?? "secret", site: row.site, fields: parseFields(row.fields), status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at };
}

function parseFields(raw: string | null): LoginField[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as LoginField[]) : [];
  } catch {
    return [];
  }
}

export function createSecretRequest(input: { botId: string; threadId: string; name: string; reason: string; target?: SecretRequest["target"]; site?: string | null; fields?: LoginField[] }): SecretRequest {
  const id = newId("sr");
  ensureDatabase()
    .query("INSERT INTO gond_secret_requests (id, bot_id, thread_id, name, reason, target, site, fields, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
    .run(id, input.botId, input.threadId, input.name, input.reason, input.target ?? "secret", input.site ?? null, JSON.stringify(input.fields ?? []), now());
  return getSecretRequest(id)!;
}

export function getSecretRequest(id: string): SecretRequest | null {
  const row = ensureDatabase().query("SELECT * FROM gond_secret_requests WHERE id = ?").get(id) as RequestRow | null;
  return row ? toRequest(row) : null;
}

export function resolveSecretRequest(id: string, status: Exclude<SecretRequest["status"], "pending">): SecretRequest | null {
  const current = getSecretRequest(id);
  if (!current || current.status !== "pending") return current;
  ensureDatabase().query("UPDATE gond_secret_requests SET status = ?, resolved_at = ? WHERE id = ?").run(status, now(), id);
  const next = getSecretRequest(id)!;
  threadChanged(next.threadId);
  emit({ topic: "approvals" });
  return next;
}
