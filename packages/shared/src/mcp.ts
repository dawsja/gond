import type { z } from "zod";
import type { mcpServerInputSchema } from "./schemas.ts";

export const MCP_TRANSPORTS = ["http", "stdio"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

export function joinCommandLine(words: string[]): string {
  return words.map((w) => (w && !/[\s"'\\]/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(" ");
}

export const COMPOSIO_CARD = "composio:";

/** The approval id of the card a turn posts when the AI isn't set up or signed in. */
export const AI_SETUP_CARD = "ai:setup";

export function composioCard(toolkit: string): string {
  return `${COMPOSIO_CARD}${toolkit}`;
}

export function composioCardToolkit(id: string | null | undefined): string | null {
  return id?.startsWith(COMPOSIO_CARD) ? id.slice(COMPOSIO_CARD.length) : null;
}

export const MCP_OAUTH_REDIRECTS = ["app", "localhost"] as const;
export type McpOAuthRedirect = (typeof MCP_OAUTH_REDIRECTS)[number];

export const MCP_LOOPBACK_PORT = 47651;
export const MCP_LOOPBACK_CALLBACK = `http://localhost:${MCP_LOOPBACK_PORT}/callback`;

export const DESKTOP_SIGN_IN_CALLBACK = `http://localhost:${MCP_LOOPBACK_PORT}/sign-in`;

const LOOPBACK_HOSTS = ["agent.robinhood.com"];

export function defaultOAuthRedirect(url: string | undefined): McpOAuthRedirect {
  try {
    return url && LOOPBACK_HOSTS.includes(new URL(url).hostname) ? "localhost" : "app";
  } catch {
    return "app";
  }
}

export type McpAuthStatus = "none" | "needed" | "signed_in" | "error";

export type McpServer = McpServerInput & {
  id: string;
  oauthRedirect: McpOAuthRedirect;
  authStatus: McpAuthStatus;

  authError: string | null;
  createdAt: string;
  updatedAt: string;
  refreshedAt: string | null;
};
