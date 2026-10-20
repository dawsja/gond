import { OIDC_DEFAULT_SCOPES, type OidcPatch, type OidcSettings } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { now } from "../ids.ts";
import { decryptSecret, encryptSecret, isLegacySecret } from "../secrets.ts";

type Stored = { enabled?: boolean; name?: string; issuer?: string; clientId?: string; clientSecret?: string; scopes?: string; updatedAt?: string };

function read(): Stored {
  const row = ensureDatabase().query("SELECT oidc FROM gond_settings WHERE id = 1").get() as { oidc: string | null } | null;
  try {
    return row?.oidc ? (JSON.parse(row.oidc) as Stored) : {};
  } catch {
    return {};
  }
}

export function reencryptOidcSecret(oidc: string | null): string | null {
  if (!oidc) return null;
  let stored: Stored;
  try {
    stored = JSON.parse(oidc) as Stored;
  } catch {
    return null;
  }
  if (!stored.clientSecret || !isLegacySecret(stored.clientSecret)) return null;
  return JSON.stringify({ ...stored, clientSecret: encryptSecret(decryptSecret(stored.clientSecret)) });
}

function write(stored: Stored) {
  ensureDatabase().query("UPDATE gond_settings SET oidc = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(stored), now());
}

export function getOidcSettings(): OidcSettings {
  const stored = read();
  return {
    enabled: stored.enabled === true,
    name: stored.name?.trim() || "SSO",
    issuer: stored.issuer ?? "",
    clientId: stored.clientId ?? "",
    scopes: stored.scopes?.trim() || OIDC_DEFAULT_SCOPES,
    hasClientSecret: Boolean(stored.clientSecret),
    updatedAt: stored.updatedAt ?? null,
  };
}

export function oidcProvider(): { name: string; issuer: string; clientId: string; clientSecret: string; scopes: string[] } | null {
  const stored = read();
  if (stored.enabled !== true || !stored.issuer || !stored.clientId || !stored.clientSecret) return null;
  return {
    name: stored.name?.trim() || "SSO",
    issuer: stored.issuer.replace(/\/+$/, ""),
    clientId: stored.clientId,
    clientSecret: decryptSecret(stored.clientSecret),
    scopes: (stored.scopes?.trim() || OIDC_DEFAULT_SCOPES).split(/\s+/).filter(Boolean),
  };
}

export function oidcReady(): boolean {
  return oidcProvider() !== null;
}

export function updateOidcSettings(patch: OidcPatch): OidcSettings {
  const stored = read();
  const next: Stored = { ...stored, updatedAt: now() };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.issuer !== undefined) next.issuer = patch.issuer.replace(/\/+$/, "");
  if (patch.clientId !== undefined) next.clientId = patch.clientId;
  if (patch.scopes !== undefined) next.scopes = patch.scopes || OIDC_DEFAULT_SCOPES;

  if (patch.clientSecret) next.clientSecret = encryptSecret(patch.clientSecret);
  write(next);
  settingsChanged();
  return getOidcSettings();
}

export function clearOidcSecret(): OidcSettings {
  const stored = read();
  write({ ...stored, enabled: false, clientSecret: undefined, updatedAt: now() });
  settingsChanged();
  return getOidcSettings();
}
