import { DEFAULT_ENGINES, ENGINE_ACCESS, ENGINES, MODEL_ID_PATTERN, PROVIDER_KINDS, type Connection, type Engine, type EngineSettings, type Onboarding, type Settings } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { now } from "../ids.ts";

const EMPTY_ONBOARDING: Onboarding = { done: false, templates: [] };

export function readEngines(json: string | null, legacyModel: string | null): Record<Engine, EngineSettings> {
  let stored: Partial<Record<Engine, Partial<EngineSettings>>> = {};
  try {
    stored = json ? (JSON.parse(json) as typeof stored) : {};
  } catch {
    /* defaults */
  }
  const out = { ...DEFAULT_ENGINES };
  if (legacyModel && MODEL_ID_PATTERN.test(legacyModel)) out.claude = { ...out.claude, model: legacyModel };
  for (const engine of ENGINES) {
    const value = stored[engine];
    if (!value || typeof value !== "object") continue;
    out[engine] = {
      access: (ENGINE_ACCESS as readonly string[]).includes(value.access ?? "") ? value.access! : out[engine].access,
      model: typeof value.model === "string" && MODEL_ID_PATTERN.test(value.model) ? value.model : out[engine].model,
      provider: (PROVIDER_KINDS as readonly string[]).includes(value.provider ?? "") ? value.provider! : (out[engine].provider ?? null),
    };
  }
  return out;
}

export function getSettings(): Settings {
  const row = ensureDatabase().query("SELECT onboarding, timezone FROM gond_settings WHERE id = 1").get() as { onboarding: string; timezone: string } | null;
  let onboarding = EMPTY_ONBOARDING;
  try {
    const stored = JSON.parse(row?.onboarding ?? "{}") as Partial<Onboarding>;
    onboarding = { done: stored.done === true, templates: Array.isArray(stored.templates) ? stored.templates : [] };
  } catch {
    /* defaults */
  }
  return {
    onboarding,
    timezone: row?.timezone ?? "UTC",
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    onboarding: { ...current.onboarding, ...(patch.onboarding ?? {}) },
  };
  ensureDatabase()
    .query("UPDATE gond_settings SET onboarding = ?, timezone = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(next.onboarding), next.timezone, now());
  settingsChanged();
  return getSettings();
}

/** While on, the epoch the relay knows this count by and when it began; a new one each time it's turned on. */
export type UsageSharingState = { epoch: string; since: string } | null;

export function usageSharing(): UsageSharingState {
  const row = ensureDatabase().query("SELECT usage_sharing FROM gond_settings WHERE id = 1").get() as { usage_sharing: string | null } | null;
  try {
    const stored = JSON.parse(row?.usage_sharing ?? "null") as { epoch?: unknown; since?: unknown } | null;
    return stored && typeof stored.epoch === "string" && typeof stored.since === "string" ? { epoch: stored.epoch, since: stored.since } : null;
  } catch {
    return null;
  }
}

export function setUsageSharing(on: boolean): UsageSharingState {
  if (on === (usageSharing() !== null)) return usageSharing();
  const next = on ? { epoch: `ep_${crypto.randomUUID().replaceAll("-", "")}`, since: now() } : null;
  ensureDatabase().query("UPDATE gond_settings SET usage_sharing = ?, updated_at = ? WHERE id = 1").run(next ? JSON.stringify(next) : null, now());
  settingsChanged();
  return next;
}

type ConnectionRow = { user_id: string; toolkit: string; name: string; account_id: string; status: string; created_at: string };

function toConnection(row: ConnectionRow): Connection {
  return { toolkit: row.toolkit, name: row.name, accountId: row.account_id, status: row.status as Connection["status"], createdAt: row.created_at };
}

export function listConnections(userId: string): Connection[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_connections WHERE user_id = ? ORDER BY created_at").all(userId) as ConnectionRow[];
  return rows.map(toConnection);
}

export function getConnection(userId: string, toolkit: string): Connection | null {
  const row = ensureDatabase().query("SELECT * FROM gond_connections WHERE user_id = ? AND toolkit = ?").get(userId, toolkit) as ConnectionRow | null;
  return row ? toConnection(row) : null;
}

export function saveConnection(userId: string, input: { toolkit: string; name: string; accountId: string; status: Connection["status"] }): Connection {
  ensureDatabase()
    .query("INSERT INTO gond_connections (user_id, toolkit, name, account_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, toolkit) DO UPDATE SET name = excluded.name, account_id = excluded.account_id, status = excluded.status")
    .run(userId, input.toolkit, input.name, input.accountId, input.status, now());
  settingsChanged();
  return getConnection(userId, input.toolkit)!;
}

export function removeConnection(userId: string, toolkit: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_connections WHERE user_id = ? AND toolkit = ?").run(userId, toolkit).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

export function removeConnections(userId: string): void {
  const changed = ensureDatabase().query("DELETE FROM gond_connections WHERE user_id = ?").run(userId).changes;
  if (changed) settingsChanged();
}
