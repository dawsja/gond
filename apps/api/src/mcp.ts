import type { Bot, McpServer } from "@gond/shared";
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
