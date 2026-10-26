import type { Composio } from "@composio/core";
import { APP_CATALOG, CURATED_TOOLKITS, appLogoUrl, type AppCatalogEntry, type Connection } from "@gond/shared";
import { indexApps, type AppIndex } from "./catalog.ts";
import { appUrl } from "./config.ts";
import { readComposioKey, setComposioKey } from "./data/composio-keys.ts";
import { getConnection, listConnections, removeConnection, removeConnections, saveConnection } from "./data/settings.ts";
import { getUser, isAdmin } from "./data/users.ts";

export const COMPOSIO_ADMIN_ENTITY = "krubot-owner";
export const COMPOSIO_ENTITY_PREFIX = "kru-";

export function composioUserId(userId: string): string {
  return isAdmin(getUser(userId)) ? COMPOSIO_ADMIN_ENTITY : `${COMPOSIO_ENTITY_PREFIX}${userId}`;
}

export type ComposioTool = {
  slug: string;
  name: string;
  description?: string;
  toolkit?: { slug: string; name?: string };
  inputParameters?: unknown;
};

const clients = new Map<string, Promise<Composio>>();

export function serverComposioKey(): string | null {
  const key = (process.env.COMPOSIO_API_KEY ?? "").trim();
  return key || null;
}

export function composioKeySource(userId: string): "own" | "server" | null {
  if (readComposioKey(userId)) return "own";
  if (serverComposioKey() && isAdmin(getUser(userId))) return "server";
  return null;
}

export function composioKey(userId: string): string | null {
  const source = composioKeySource(userId);
  return source === "own" ? readComposioKey(userId) : source === "server" ? serverComposioKey() : null;
}

export function composioConfigured(userId: string) {
  return composioKeySource(userId) !== null;
}

export function applyComposioKey(userId: string, apiKey: string) {
  const before = composioKey(userId);
  setComposioKey(userId, apiKey);
  if (composioKey(userId) === before) return;
  removeConnections(userId);
  forgetComposioCache(userId);
}

async function sdk(userId: string): Promise<Composio> {
  const key = composioKey(userId);
  if (!key) throw new Error("Connected apps need your Composio API key. Add it under Settings → Apps.");
  const hit = clients.get(key);
  if (hit) return hit;
  const ready = import("@composio/core").then((mod) => new mod.Composio({ apiKey: key }));
  clients.set(key, ready);
  return ready;
}

export function curatedToolkits(env = process.env.COMPOSIO_TOOLKITS): Set<string> {
  const allow = (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const curated = new Set(CURATED_TOOLKITS);
  return allow.length ? new Set(allow.filter((t) => curated.has(t))) : curated;
}

let fallbackIndex: AppIndex | null = null;
function fallbackCatalog(): AppIndex {
  fallbackIndex ??= indexApps(narrowed(APP_CATALOG.map((app) => ({ ...app, logo: appLogoUrl(app.toolkit) }))));
  return fallbackIndex;
}

export function narrowed(apps: AppCatalogEntry[], allow = curatedToolkits()): AppCatalogEntry[] {
  return apps.filter((a) => allow.has(a.toolkit));
}

function entryOf(item: { slug: string; name?: string; meta?: { logo?: string; description?: string; categories?: { name?: string }[] } }): AppCatalogEntry {
  const toolkit = item.slug.toLowerCase();
  const known = APP_CATALOG.find((a) => a.toolkit === toolkit);
  const description = item.meta?.description?.trim();
  return {
    toolkit,
    name: item.name?.trim() || known?.name || toolkit,
    icon: known?.icon ?? toolkit,
    category: item.meta?.categories?.[0]?.name?.trim() || known?.category || "Apps",
    logo: item.meta?.logo || appLogoUrl(toolkit),
    ...(description ? { description } : {}),
  };
}

const catalogCache = new Map<string, { at: number; index: AppIndex }>();

const catalogFetches = new Map<string, Promise<AppIndex>>();
const CATALOG_CACHE_MS = 10 * 60 * 1000;

const TOOLKIT_PAGE = 500;
const TOOLKIT_PAGES = 40;

/**
 * Every toolkit Composio offers the person's project, page by page. The
 * SDK's own list drops the cursor, so this asks the API client under it.
 */
async function fetchToolkits(userId: string): Promise<AppCatalogEntry[]> {
  const client = (await sdk(userId)).getClient();
  const apps = new Map<string, AppCatalogEntry>();
  let cursor: string | undefined;
  for (let page = 0; page < TOOLKIT_PAGES; page++) {
    const answer = await client.toolkits.list({ limit: TOOLKIT_PAGE, ...(cursor ? { cursor } : {}) });
    for (const item of answer.items) {
      if (item.type === "custom") continue;
      const entry = entryOf(item);
      if (!apps.has(entry.toolkit)) apps.set(entry.toolkit, entry);
    }
    cursor = answer.next_cursor ?? undefined;
    if (!cursor || answer.items.length === 0) break;
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function catalogIndex(userId: string): Promise<AppIndex> {
  const key = composioKey(userId);
  if (!key) return fallbackCatalog();
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_CACHE_MS) return hit.index;
  const running = catalogFetches.get(key);
  if (running) return running;
  const ready = fetchToolkits(userId)
    .then((apps) => {
      if (!apps.length) throw new Error("Composio listed no toolkits");
      const index = indexApps(narrowed(apps));
      catalogCache.set(key, { at: Date.now(), index });
      return index;
    })
    .catch((error: unknown) => {
      console.warn(`[gond] could not list Composio toolkits: ${error instanceof Error ? error.message : error}`);
      return fallbackCatalog();
    })
    .finally(() => catalogFetches.delete(key));
  catalogFetches.set(key, ready);
  return ready;
}

export async function catalogEntry(userId: string, toolkit: string): Promise<AppCatalogEntry | null> {
  const index = await catalogIndex(userId).catch(() => fallbackCatalog());
  return index.bySlug.get(toolkit.toLowerCase()) ?? null;
}

async function nameOf(userId: string, toolkit: string): Promise<string> {
  return (await catalogEntry(userId, toolkit))?.name ?? APP_CATALOG.find((a) => a.toolkit === toolkit)?.name ?? toolkit;
}

function statusOf(raw: string): Connection["status"] {
  const value = raw.toUpperCase();
  if (value === "ACTIVE") return "active";
  if (value === "FAILED" || value === "EXPIRED" || value === "INACTIVE") return "failed";
  return "pending";
}

async function authConfigFor(client: Composio, toolkit: string, name: string): Promise<string> {
  const existing = await client.authConfigs.list({ toolkit });
  const id = existing.items.find((c) => c.status !== "DISABLED")?.id;
  if (id) return id;
  try {
    const created = await client.authConfigs.create(toolkit, { type: "use_composio_managed_auth", name: `${name} (Gond)` });
    return created.id;
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (!/managed|default auth config|auth_config_default/i.test(said)) throw error;
    throw new Error(`${name} needs credentials of your own: Composio has none it manages for it. Make an auth config for ${toolkit} in your Composio project (dashboard.composio.dev → Auth Configs) with your own client id and secret, then connect again.`);
  }
}

/** The person's live account for an app in Composio, under whichever auth config made it. */
async function activeAccountFor(client: Composio, userId: string, toolkit: string): Promise<string | null> {
  const active = await client.connectedAccounts.list({ userIds: [composioUserId(userId)], toolkitSlugs: [toolkit], statuses: ["ACTIVE"] });
  return active.items[0]?.id ?? null;
}

export async function startConnection(userId: string, toolkit: string, threadId?: string | null): Promise<{ redirectUrl: string | null; accountId: string }> {
  const client = await sdk(userId);
  const name = await nameOf(userId, toolkit);
  // Asking again for an app that works must never trade its account for a fresh, pending sign-in.
  const healed = await healConnection(userId, toolkit);
  if (healed?.status === "active") return { redirectUrl: null, accountId: healed.accountId };
  const live = await activeAccountFor(client, userId, toolkit);
  if (live) {
    saveConnection(userId, { toolkit, name, accountId: live, status: "active" });
    return { redirectUrl: null, accountId: live };
  }
  const authConfigId = await authConfigFor(client, toolkit, name);
  const callbackUrl = `${appUrl()}/api/connections/callback?toolkit=${encodeURIComponent(toolkit)}${threadId ? `&thread=${encodeURIComponent(threadId)}` : ""}`;
  const request = await client.connectedAccounts.link(composioUserId(userId), authConfigId, { callbackUrl });
  saveConnection(userId, { toolkit, name, accountId: request.id, status: request.redirectUrl ? "pending" : statusOf(request.status ?? "") });
  return { redirectUrl: request.redirectUrl ?? null, accountId: request.id };
}

export async function refreshConnection(userId: string, toolkit: string): Promise<Connection | null> {
  const stored = getConnection(userId, toolkit);
  if (!stored) return null;
  try {
    const client = await sdk(userId);
    const account = await client.connectedAccounts.get(stored.accountId);
    return saveConnection(userId, { toolkit, name: stored.name, accountId: stored.accountId, status: statusOf(account.status) });
  } catch {
    return stored;
  }
}

/**
 * What Composio says of the stored account, and when that isn't live (a missed callback, a newer account
 * made elsewhere) the person's live account for the app instead. Keeps the row as it was if Composio
 * can't be asked.
 */
export async function healConnection(userId: string, toolkit: string): Promise<Connection | null> {
  const stored = await refreshConnection(userId, toolkit);
  if (stored?.status === "active") return stored;
  try {
    const live = await activeAccountFor(await sdk(userId), userId, toolkit);
    if (!live) return stored;
    return saveConnection(userId, { toolkit, name: stored?.name ?? (await nameOf(userId, toolkit)), accountId: live, status: "active" });
  } catch {
    return stored;
  }
}

export async function disconnect(userId: string, toolkit: string): Promise<boolean> {
  const stored = getConnection(userId, toolkit);
  if (!stored) return false;
  try {
    const client = await sdk(userId);
    await client.connectedAccounts.delete(stored.accountId);
  } catch {
    /* the local record goes either way */
  }
  return removeConnection(userId, toolkit);
}

const toolCache = new Map<string, { at: number; tools: ComposioTool[] }>();
const TOOL_CACHE_MS = 10 * 60 * 1000;

export function forgetComposioCache(userId: string) {
  for (const key of toolCache.keys()) if (key.startsWith(`${userId}:`)) toolCache.delete(key);
}

export async function toolsFor(userId: string): Promise<ComposioTool[]> {
  const wanted = [...new Set(listConnections(userId).filter((c) => c.status === "active").map((c) => c.toolkit))].sort();
  if (wanted.length === 0 || !composioConfigured(userId)) return [];
  const key = `${userId}:${wanted.join(",")}`;
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_CACHE_MS) return hit.tools;
  const client = await sdk(userId);
  const lists = await Promise.allSettled(wanted.map((toolkit) => toolsOfApp(client, toolkit)));
  const tools: ComposioTool[] = [];
  lists.forEach((list, i) => {
    if (list.status === "fulfilled") tools.push(...list.value);
    else console.warn(`[gond] could not load ${wanted[i]} tools: ${list.reason instanceof Error ? list.reason.message : list.reason}`);
  });
  if (lists.every((list) => list.status === "fulfilled")) toolCache.set(key, { at: Date.now(), tools });
  return tools;
}

const TOOLS_PER_APP = 100;

// One app at a time: a single request for every app shares one limit, and GitHub's hundreds of
// actions used to fill it and leave the others out. "important" is Composio's everyday set per app.
async function toolsOfApp(client: Composio, toolkit: string): Promise<ComposioTool[]> {
  const important: ComposioTool[] = await client.tools.getRawComposioTools({ toolkits: [toolkit], important: true, limit: TOOLS_PER_APP });
  if (important.length) return important;
  return client.tools.getRawComposioTools({ toolkits: [toolkit], limit: TOOLS_PER_APP });
}

export function isReadOnlyAction(slug: string) {
  return /(_GET_|_LIST_|_FETCH_|_SEARCH_|_READ_|_FIND_|_RETRIEVE_|_QUERY_|_LOOKUP_|_CHECK_|_COUNT_|_DOWNLOAD_)|(_GET|_LIST|_FETCH|_SEARCH|_READ|_FIND|_RETRIEVE)$/.test(slug.toUpperCase());
}

export async function executeAction(userId: string, slug: string, args: Record<string, unknown>, toolkit?: string): Promise<unknown> {
  const client = await sdk(userId);
  let account = toolkit ? getConnection(userId, toolkit.toLowerCase()) : null;
  if (toolkit && account?.status !== "active") account = await healConnection(userId, toolkit.toLowerCase());
  if (!account || account.status !== "active") throw new Error(`${toolkit ?? slug} isn't connected for this person. Call connect_app for it: the person gets a sign-in card.`);
  const result = await client.tools.execute(slug, { userId: composioUserId(userId), arguments: args, connectedAccountId: account.accountId, dangerouslySkipVersionCheck: true });
  if (!result.successful) throw new Error(`${result.error ?? `${slug} failed`}${result.logId ? ` (Composio log ${result.logId})` : ""}`);
  return result.data;
}
