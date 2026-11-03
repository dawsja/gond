import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { shoppingUrl, type ShoppingProduct } from "@gond/shared";
import { pictureType } from "./images.ts";

/** Whether an address is loopback, private, link-local, shared, multicast or otherwise not on the public internet. */
export function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const h = ip.toLowerCase();
  return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("ff") || h.startsWith("64:ff9b:") || h.startsWith("2001:db8:");
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const MAX_PAGE = 6 * 1024 * 1024;

/**
 * GET a URL a bot gave, only while it and every redirect stay public HTTPS that resolves off the private
 * network: the API runs beside the box and the Docker socket, so a store link must never reach them.
 */
async function getPublic(url: string, accept: string, signal: AbortSignal): Promise<Response | null> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!shoppingUrl(at)) return null;
    const host = new URL(at).hostname;
    const addresses = await lookup(host, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some((a) => privateAddress(a.address))) return null;
    const res = await fetch(at, { redirect: "manual", signal, headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9" } });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      await res.body?.cancel().catch(() => undefined);
      at = new URL(next, at).href;
      continue;
    }
    return res;
  }
  return null;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type Loads = "yes" | "no" | "unknown";

/**
 * Whether a photo address answers with a picture: the bytes say so, or a raster type the bytes can't (AVIF),
 * never an SVG. "unknown" when the store was too slow to say, which is no proof the address is wrong.
 */
export async function photoLoads(url: string, signal: AbortSignal): Promise<Loads> {
  const own = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
  try {
    const res = await getPublic(url, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", own);
    if (!res?.ok) {
      await res?.body?.cancel().catch(() => undefined);
      return "no";
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const head = await readCapped(res, 64);
    if (!head?.length) return "no";
    return pictureType(head) || (/^image\/(avif|heic|heif|jxl)/.test(type) && !type.includes("svg")) ? "yes" : "no";
  } catch {
    return own.aborted ? "unknown" : "no";
  }
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/gi, "/").replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decode(m[2] ?? m[3] ?? "") : null;
}

/** JSON-LD Product images, in the page's order: a string, a list, or ImageObjects. */
function jsonLdImages(html: string): string[] {
  const out: string[] = [];
  const visit = (node: unknown, inProduct: boolean) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, inProduct));
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = ([] as unknown[]).concat(obj["@type"] ?? []).map(String);
    const product = inProduct || type.some((t) => /Product|ProductGroup|IndividualProduct/i.test(t));
    if (product && obj.image !== undefined) {
      for (const image of ([] as unknown[]).concat(obj.image)) {
        if (typeof image === "string") out.push(image);
        else if (image && typeof image === "object") {
          const url = (image as Record<string, unknown>).contentUrl ?? (image as Record<string, unknown>).url;
          if (typeof url === "string") out.push(url);
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) if (key !== "image" && value && typeof value === "object") visit(value, product && key === "hasVariant");
  };
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]!.trim()), false);
    } catch {
      /* a store's broken JSON-LD */
    }
  }
  return out;
}

/**
 * A store page's product photos, best first: Amazon's own hi-res image, the page's JSON-LD Product
 * images, then its og:image and twitter:image. Only public https addresses, each once.
 */
export function photosInPage(html: string, base: string): string[] {
  const found: string[] = [];
  // Amazon: the main image's hi-res address, then the gallery's.
  for (const m of html.matchAll(/data-old-hires\s*=\s*"([^"]+)"/gi)) found.push(decode(m[1]!));
  const landing = html.match(/<img[^>]+id\s*=\s*["'](?:landingImage|imgBlkFront|main-image)["'][^>]*>/i)?.[0];
  if (landing) {
    const dynamic = attr(landing, "data-a-dynamic-image");
    if (dynamic) {
      try {
        const sizes = Object.entries(JSON.parse(dynamic) as Record<string, [number, number]>).sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1]);
        if (sizes[0]) found.push(sizes[0][0]);
      } catch {
        /* not JSON */
      }
    }
    const src = attr(landing, "src");
    if (src) found.push(src);
  }
  for (const m of html.matchAll(/"hiRes"\s*:\s*"(https:[^"]+)"/g)) found.push(decode(m[1]!));
  found.push(...jsonLdImages(html));
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], "property") ?? attr(m[0], "name") ?? attr(m[0], "itemprop") ?? "").toLowerCase();
    if (["og:image", "og:image:secure_url", "og:image:url", "twitter:image", "twitter:image:src", "image"].includes(key)) {
      const content = attr(m[0], "content");
      if (content) found.push(content);
    }
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (attr(m[0], "rel")?.toLowerCase() === "image_src") found.push(attr(m[0], "href") ?? "");
  const out: string[] = [];
  for (const raw of found) {
    try {
      const url = new URL(raw.trim(), base);
      if (url.protocol === "http:") url.protocol = "https:";
      if (shoppingUrl(url.href) && !/\.svg(\?|$)/i.test(url.pathname) && !out.includes(url.href)) out.push(url.href);
    } catch {
      /* not an address */
    }
  }
  return out;
}

export type PhotoDeps = { loads: (url: string, signal: AbortSignal) => Promise<Loads>; page: (url: string, signal: AbortSignal) => Promise<string | null> };

async function fetchPage(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await getPublic(url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", AbortSignal.any([signal, AbortSignal.timeout(8_000)]));
    if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
      await res?.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readCapped(res, MAX_PAGE);
    return bytes ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
}

const KEEP = 6;

/** Amazon serves every photo at any size by its name's modifiers; a thumbnail's (SX300, FMwebp) becomes the large one. */
export function largerPhoto(url: string): string {
  const m = url.match(/^(https:\/\/m\.media-amazon\.com\/images\/I\/[\w+%-]+)\.[^/]*_\.(jpe?g|png|webp)$/i);
  return m ? `${m[1]}._AC_SL1500_.jpg` : url;
}

/** The larger version when it loads, else the address as given. */
async function check(url: string, deps: PhotoDeps, signal: AbortSignal): Promise<{ url: string; loads: Loads }> {
  const larger = largerPhoto(url);
  if (larger !== url && (await deps.loads(larger, signal)) === "yes") return { url: larger, loads: "yes" };
  return { url, loads: await deps.loads(url, signal) };
}

async function photosFor(product: ShoppingProduct, deps: PhotoDeps, signal: AbortSignal): Promise<{ images: string[]; from: "bot" | "page" | "none" }> {
  const checked = await Promise.all(product.images.slice(0, 8).map((url) => check(url, deps, signal)));
  const good = checked.filter((c) => c.loads === "yes").map((c) => c.url);
  if (good.length) return { images: good, from: "bot" };
  const unsure = checked.filter((c) => c.loads === "unknown").map((c) => c.url);
  const pages = [...new Set(product.variants.flatMap((v) => v.offers.map((o) => o.url)))].slice(0, 3);
  for (const page of pages) {
    if (signal.aborted) break;
    const html = await deps.page(page, signal);
    if (!html) continue;
    const candidates = photosInPage(html, page).slice(0, 10);
    const ok = await Promise.all(candidates.map(async (url) => {
      const c = await check(url, deps, signal);
      return c.loads === "yes" ? c.url : null;
    }));
    const images = [...new Set(ok.filter((url): url is string => Boolean(url)))].slice(0, KEEP);
    if (images.length) return { images, from: "page" };
  }
  return { images: unsure, from: unsure.length ? "bot" : "none" };
}

/**
 * Products with photos that load. A bot's own addresses are kept only when they answer with a picture (a
 * guessed or broken one leaves a blank card), and a product left with none takes its store page's photos.
 * Past the deadline a product keeps what the bot sent, unchecked.
 */
export async function withPhotos(products: ShoppingProduct[], deps: PhotoDeps = { loads: photoLoads, page: fetchPage }, ms = 20_000): Promise<{ products: ShoppingProduct[]; missing: string[] }> {
  const signal = AbortSignal.timeout(ms);
  const results = await Promise.all(products.map((p) => photosFor(p, deps, signal).catch(() => null)));
  const out = products.map((p, i) => {
    const r = results[i];
    if (!r || (signal.aborted && r.from === "none")) return p;
    return { ...p, images: r.images };
  });
  return { products: out, missing: out.filter((p) => !p.images.length).map((p) => p.title) };
}
