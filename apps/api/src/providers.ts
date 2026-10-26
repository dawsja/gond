import { isOpenAiShaped, type ProviderKind } from "@gond/shared";
import { GROK_PLAN_HEADERS } from "./grok.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

export function isOpenAiHost(baseUrl: string): boolean {
  try {
    return /(^|\.)openai\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isAnthropicHost(baseUrl: string): boolean {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isMiniMaxHost(baseUrl: string): boolean {
  try {
    return /(^|\.)minimaxi?\.(io|com)$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** A coding plan's key (Kimi Code) that its provider serves only to coding agents it knows, Claude Code among them. */
export function coderOnlyRefusal(body: unknown): boolean {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return /access_terminated_error|only available for coding agents/i.test(text);
}

export const CODER_ONLY_TEXT = "This key works only through a coding agent. Put Claude Code on it under Settings → AI instead.";

export function authHeaders(kind: ProviderKind, baseUrl: string, key: string): Record<string, string> {
  if (kind === "grok") return { authorization: `Bearer ${key}`, ...GROK_PLAN_HEADERS };
  if (isOpenAiShaped(kind)) return { authorization: `Bearer ${key}` };
  return isAnthropicHost(baseUrl) ? { "x-api-key": key } : { "x-api-key": key, authorization: `Bearer ${key}` };
}

export function upstreamUrl(baseUrl: string, suffix: string, search: string): URL {
  const target = new URL(suffix.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  target.search = search;
  return target;
}

export function proxiedUrl(baseUrl: string, suffix: string, search: string): URL | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    target = upstreamUrl(baseUrl, suffix, search);
  } catch {
    return null;
  }
  if (target.origin !== base.origin || target.username || target.password) return null;
  if (!target.pathname.startsWith(base.pathname)) return null;
  return target;
}
