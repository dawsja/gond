import { PROVIDER_KINDS, PROVIDER_LABELS, isPlanProvider, type PlanProviderKind, type ProviderInput, type ProviderKind, type ProviderMeta } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { newId, now, randomString } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

type Row = { id: string; user_id: string | null; kind: string; base_url: string; api_key: string; proxy_token: string; last_check: string | null; oauth: string | null; created_at: string; updated_at: string };

/** A plan's sign-in; the access token itself is the row's `api_key`, like a key. */
export type PlanSession = {
  clientId: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number;
  scope: string;
  email: string | null;
  name: string | null;
};

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The URL starts with http:// or https://");
  if (url.username || url.password) throw new Error("Leave the username and password out of the URL");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

function toMeta(row: Row): ProviderMeta {
  let check: ProviderMeta["check"] = null;
  try {
    check = row.last_check ? (JSON.parse(row.last_check) as ProviderMeta["check"]) : null;
  } catch {
    /* no check */
  }
  const session = isPlanProvider(row.kind as ProviderKind) ? sessionOf(row) : null;
  return { kind: row.kind as ProviderKind, baseUrl: row.base_url, account: session ? { email: session.email, name: session.name } : null, check, updatedAt: row.updated_at };
}

function sessionOf(row: Row): PlanSession | null {
  if (!row.oauth) return null;
  try {
    return JSON.parse(decryptSecret(row.oauth)) as PlanSession;
  } catch {
    return null;
  }
}

function row(userId: string, kind: ProviderKind): Row | null {
  return ensureDatabase().query("SELECT * FROM gond_providers WHERE user_id = ? AND kind = ?").get(userId, kind) as Row | null;
}

export function listProviders(userId: string): ProviderMeta[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_providers WHERE user_id = ? ORDER BY kind").all(userId) as Row[];
  return rows.filter((r) => isProviderKind(r.kind)).map(toMeta);
}

export function getProvider(userId: string, kind: ProviderKind): ProviderMeta | null {
  const found = row(userId, kind);
  return found ? toMeta(found) : null;
}

export function saveProvider(userId: string, kind: ProviderKind, input: ProviderInput): ProviderMeta {
  if (isPlanProvider(kind)) throw new Error(`A ${PROVIDER_LABELS[kind].name} is signed in to, not given a key.`);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const current = row(userId, kind);
  if (!current && !input.apiKey) throw new Error("Add the API key");
  const at = now();
  if (current) {
    ensureDatabase()
      .query("UPDATE gond_providers SET base_url = ?, api_key = ?, last_check = ?, updated_at = ? WHERE id = ?")
      .run(baseUrl, input.apiKey ? encryptSecret(input.apiKey) : current.api_key, input.apiKey || baseUrl !== current.base_url ? null : current.last_check, at, current.id);
  } else {
    ensureDatabase()
      .query("INSERT INTO gond_providers (id, user_id, kind, base_url, api_key, proxy_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId("prov_"), userId, kind, baseUrl, encryptSecret(input.apiKey!), randomString(32), at, at);
  }
  emit({ topic: "ai", userId });
  return getProvider(userId, kind)!;
}

/** Saves a plan's sign-in, or the tokens a refresh replaced, keeping the row's proxy token. */
export function savePlanSession(userId: string, kind: PlanProviderKind, accessToken: string, session: PlanSession): void {
  const current = row(userId, kind);
  const at = now();
  if (current) {
    ensureDatabase().query("UPDATE gond_providers SET api_key = ?, oauth = ?, updated_at = ? WHERE id = ?").run(encryptSecret(accessToken), encryptSecret(JSON.stringify(session)), at, current.id);
  } else {
    ensureDatabase()
      .query("INSERT INTO gond_providers (id, user_id, kind, base_url, api_key, proxy_token, oauth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId("prov_"), userId, kind, PROVIDER_LABELS[kind].defaultUrl, encryptSecret(accessToken), randomString(32), encryptSecret(JSON.stringify(session)), at, at);
  }
  emit({ topic: "ai", userId });
}

export function planSession(userId: string, kind: PlanProviderKind): (PlanSession & { accessToken: string }) | null {
  const found = row(userId, kind);
  const session = found ? sessionOf(found) : null;
  if (!found || !session) return null;
  try {
    return { ...session, accessToken: decryptSecret(found.api_key) };
  } catch {
    return null;
  }
}

/** A sign-in the plan won't renew: the tokens go, the row stays to say why, until the person signs in again. */
export function endPlanSession(userId: string, kind: PlanProviderKind, detail: string): void {
  ensureDatabase()
    .query("UPDATE gond_providers SET api_key = ?, oauth = NULL, last_check = ?, updated_at = ? WHERE user_id = ? AND kind = ?")
    .run(encryptSecret(""), JSON.stringify({ ok: false, detail, at: now() }), now(), userId, kind);
  emit({ topic: "ai", userId });
}

export function recordProviderCheck(userId: string, kind: ProviderKind, check: { ok: boolean; detail: string }): ProviderMeta | null {
  ensureDatabase()
    .query("UPDATE gond_providers SET last_check = ? WHERE user_id = ? AND kind = ?")
    .run(JSON.stringify({ ...check, at: now() }), userId, kind);
  emit({ topic: "ai", userId });
  return getProvider(userId, kind);
}

export function deleteProvider(userId: string, kind: ProviderKind): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_providers WHERE user_id = ? AND kind = ?").run(userId, kind).changes;
  if (changed) emit({ topic: "ai", userId });
  return changed > 0;
}

export function providerKey(userId: string, kind: ProviderKind): string | null {
  const found = row(userId, kind);
  return found ? decryptSecret(found.api_key) : null;
}

export function providerProxyToken(userId: string, kind: ProviderKind): string | null {
  return row(userId, kind)?.proxy_token ?? null;
}

export function providerBaseUrl(userId: string, kind: ProviderKind): string | null {
  return row(userId, kind)?.base_url ?? null;
}

export function providerByToken(kind: ProviderKind, token: string): { userId: string; baseUrl: string; key: string } | null {
  if (!token) return null;
  const found = ensureDatabase().query("SELECT * FROM gond_providers WHERE kind = ? AND proxy_token = ? AND user_id IS NOT NULL").get(kind, token) as Row | null;
  if (!found) return null;
  try {
    return { userId: found.user_id!, baseUrl: found.base_url, key: decryptSecret(found.api_key) };
  } catch {
    return null;
  }
}

export function allProviderProxyTokens(): string[] {
  const rows = ensureDatabase().query("SELECT proxy_token FROM gond_providers").all() as { proxy_token: string }[];
  return rows.map((r) => r.proxy_token).filter(Boolean);
}

export function allProviderKeys(): string[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_providers").all() as Row[];
  const out: string[] = [];
  for (const r of rows) {
    try {
      out.push(decryptSecret(r.api_key));
    } catch {
      /* unreadable, can't leak */
    }
    const session = sessionOf(r);
    if (session) out.push(...[session.refreshToken, session.idToken].filter((value): value is string => Boolean(value)));
  }
  return out;
}
