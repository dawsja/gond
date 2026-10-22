import { defaultOAuthRedirect, type McpAuthStatus, type McpOAuthRedirect, type McpServer, type McpServerInput } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { botsChanged, settingsChanged } from "../events.ts";
import { newId, now, randomString } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

type Row = { id: string; user_id: string; name: string; transport: McpServer["transport"]; url: string | null; headers: string; command: string | null; args: string; env: string; enabled: number; proxy_token: string; oauth: string | null; auth_status: McpAuthStatus; auth_error: string | null; oauth_redirect: McpOAuthRedirect; created_at: string; updated_at: string; refreshed_at: string | null };

function json<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toServer(row: Row): McpServer {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url ?? undefined,
    headers: json<Record<string, string>>(row.headers, {}),
    command: row.command ?? undefined,
    args: json<string[]>(row.args, []),
    env: json<Record<string, string>>(row.env, {}),
    enabled: row.enabled === 1,
    oauthRedirect: row.oauth_redirect === "localhost" ? "localhost" : "app",
    authStatus: row.auth_status ?? "none",
    authError: row.auth_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    refreshedAt: row.refreshed_at ?? null,
  };
}

export type McpOAuthState = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** RFC 8707: the MCP server's canonical URL, sent as `resource`. */
  resource: string;
  scope?: string;
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;

  expiresAt?: number;

  redirectUri?: string;
};

export function getMcpOAuth(id: string): McpOAuthState | null {
  const row = ensureDatabase().query("SELECT oauth FROM gond_mcp_servers WHERE id = ?").get(id) as { oauth: string | null } | null;
  if (!row?.oauth) return null;
  try {
    return JSON.parse(decryptSecret(row.oauth)) as McpOAuthState;
  } catch {
    return null;
  }
}

export function setMcpOAuth(id: string, state: McpOAuthState | null): void {
  ensureDatabase().query("UPDATE gond_mcp_servers SET oauth = ?, updated_at = ? WHERE id = ?").run(state ? encryptSecret(JSON.stringify(state)) : null, now(), id);
}

export function setMcpAuthStatus(id: string, status: McpAuthStatus, error: string | null = null): void {
  ensureDatabase().query("UPDATE gond_mcp_servers SET auth_status = ?, auth_error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), id);
  settingsChanged();
}

export function markMcpRefreshed(id: string): void {
  ensureDatabase().query("UPDATE gond_mcp_servers SET refreshed_at = ? WHERE id = ?").run(now(), id);
}

export function listMcpServers(userId: string): McpServer[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_mcp_servers WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(userId) as Row[];
  return rows.map(toServer);
}

export function mcpServerOwner(id: string): string | null {
  const row = ensureDatabase().query("SELECT user_id FROM gond_mcp_servers WHERE id = ?").get(id) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

export function getMcpServer(id: string): McpServer | null {
  const row = ensureDatabase().query("SELECT * FROM gond_mcp_servers WHERE id = ?").get(id) as Row | null;
  return row ? toServer(row) : null;
}

export function mcpProxyToken(id: string): string | null {
  const row = ensureDatabase().query("SELECT proxy_token FROM gond_mcp_servers WHERE id = ?").get(id) as { proxy_token: string } | null;
  return row?.proxy_token ?? null;
}

export function createMcpServer(input: McpServerInput, userId: string): McpServer {
  const id = newId("mcp");
  const at = now();
  ensureDatabase()
    .query("INSERT INTO gond_mcp_servers (id, user_id, name, transport, url, headers, command, args, env, enabled, oauth_redirect, proxy_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.name, input.transport, input.url ?? null, JSON.stringify(input.headers), input.command ?? null, JSON.stringify(input.args), JSON.stringify(input.env), input.enabled ? 1 : 0, input.oauthRedirect ?? defaultOAuthRedirect(input.url), randomString(32), at, at);
  settingsChanged();
  return getMcpServer(id)!;
}

export function updateMcpServer(id: string, patch: Partial<McpServerInput>): McpServer | null {
  const current = getMcpServer(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  ensureDatabase()
    .query("UPDATE gond_mcp_servers SET name = ?, transport = ?, url = ?, headers = ?, command = ?, args = ?, env = ?, enabled = ?, oauth_redirect = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.transport, next.url ?? null, JSON.stringify(next.headers), next.command ?? null, JSON.stringify(next.args), JSON.stringify(next.env), next.enabled ? 1 : 0, next.oauthRedirect ?? "app", now(), id);
  settingsChanged();
  return getMcpServer(id);
}

export function deleteMcpServer(id: string): boolean {
  const db = ensureDatabase();
  const changed = db.query("DELETE FROM gond_mcp_servers WHERE id = ?").run(id).changes;
  if (changed) {
    settingsChanged();
    botsChanged();
  }
  return changed > 0;
}
