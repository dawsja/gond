import { SECRET_REF, isKeyHeader, type Bot, type McpServer } from "@gond/shared";
import { env } from "./config.ts";
import { listMcpServers, mcpProxyToken } from "./data/mcp.ts";

export type BoxMcpServer = ({ name: string; type: "http"; url: string; headers: Record<string, string> } | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string> }) & { rev?: string };

export function apiInternalUrl(): string {
  return (env("API_INTERNAL_URL") ?? `http://127.0.0.1:${process.env.PORT || 8790}`).replace(/\/$/, "");
}

export function mcpServersFor(bot: Pick<Bot, "userId">): McpServer[] {
  return listMcpServers(bot.userId).filter((server) => server.enabled);
}

export function boxMcpServers(bot: Pick<Bot, "userId">): BoxMcpServer[] {
  // A server waiting for its sign-in stays off the session: a CLI that met it would try a sign-in of its own.
  return mcpServersFor(bot).filter((server) => server.authStatus !== "needed").map(toBoxServer);
}

function toBoxServer(server: McpServer): BoxMcpServer {
  if (server.transport === "http") {
    return { name: server.name, type: "http", url: `${apiInternalUrl()}/api/mcp/${server.id}/mcp`, headers: { "X-Gond-Mcp-Token": mcpProxyToken(server.id) ?? "", "X-Gond-Mcp-Auth": server.authStatus }, ...rev(server) };
  }
  return { name: server.name, type: "stdio", command: server.command ?? "", args: server.args, env: server.env, ...rev(server) };
}

function rev(server: McpServer): { rev?: string } {
  return server.refreshedAt ? { rev: server.refreshedAt } : {};
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
export function secretNamesIn(value: string): string[] {
  return [...value.matchAll(SECRET_REF)].map((match) => match[1]!);
}

/**
 * Headers a bot gives a remote MCP server, or why not. A key goes in only as
 * `{{secret:NAME}}`, filled in by the API at the moment of use, so the value
 * never sits in the row, the approval card or the computer.
 */
export function checkMcpHeaders(raw: unknown, stored: (name: string) => boolean, secretValues: string[]): Record<string, string> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return "headers maps a header's name to its value.";
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 10) return "give at most 10 headers.";
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (typeof value !== "string" || !value.trim()) return `${name} needs a value.`;
    if (!HEADER_NAME.test(name)) return `${name} isn't a header's name.`;
    if (/^x-gond-/i.test(name)) return `${name} is Gond's own.`;
    if (secretValues.some((secret) => secret.length >= 8 && value.includes(secret))) return `${name} holds a stored secret's value. Write {{secret:NAME}} instead, and the API fills it in.`;
    const names = secretNamesIn(value);
    if (isKeyHeader(name) && !names.length) return `${name} carries a key, so it goes in as {{secret:NAME}}, like "Bearer {{secret:CURA_TOKEN}}". Ask for the key with request_secret first.`;
    const missing = names.filter((secret) => !stored(secret));
    if (missing.length) return `${missing.join(", ")} isn't stored yet. Ask for it with request_secret first.`;
    headers[name] = value.trim();
  }
  return headers;
}
