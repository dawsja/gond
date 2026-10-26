import { APP_CATALOG, appLogoUrl, type McpServer } from "@gond/shared";
import { pictureType } from "./images.ts";

export type McpIconResult = { kind: "redirect"; url: string } | { kind: "image"; type: string; bytes: ArrayBuffer } | null;

const ICON_SERVICE = "https://icons.duckduckgo.com/ip3/";
const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; result: McpIconResult }>();

export function iconHosts(url: string | undefined): string[] {
  if (!url) return [];
  let host = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    host = parsed.hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":")) return [];
  const labels = host.split(".");
  return labels.length > 2 ? [host, labels.slice(-2).join(".")] : [host];
}

export function catalogLogoFor(name: string): string | null {
  const wanted = name.trim().toLowerCase();
  const app = APP_CATALOG.find((entry) => entry.toolkit === wanted || entry.name.toLowerCase() === wanted);
  return app ? appLogoUrl(app.toolkit) : null;
}

async function fetchIcon(url: string): Promise<McpIconResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await res.arrayBuffer();
    // The type comes from the bytes, never the remote's header: an SVG or HTML sent as an image could run script on Gond's own address.
    const type = iconType(new Uint8Array(bytes));
    return type && bytes.byteLength > 0 && bytes.byteLength <= 512 * 1024 ? { kind: "image", type, bytes } : null;
  } catch {
    return null;
  }
}

export async function resolveMcpIcon(server: Pick<McpServer, "id" | "name" | "transport" | "url">, options: { iconService?: string; now?: number } = {}): Promise<McpIconResult> {
  if (server.transport !== "http") return null;
  const key = `${server.id}:${server.name}:${server.url ?? ""}`;
  const now = options.now ?? Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.result;
  let result: McpIconResult = null;
  const logo = catalogLogoFor(server.name);
  if (logo) result = { kind: "redirect", url: logo };
  for (const host of logo ? [] : iconHosts(server.url)) {
    result = await fetchIcon(`${options.iconService ?? ICON_SERVICE}${host}.ico`);
    if (result) break;
  }
  cache.set(key, { at: now, result });
  return result;
}


/** PNG, JPEG, GIF and WebP as everywhere else, plus ICO (reserved 0, type 1), which favicons mostly are. */
export function iconType(data: Uint8Array): string | null {
  return pictureType(data) ?? (data.length >= 6 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0 && data[4]! + data[5]! > 0 ? "image/x-icon" : null);
}
