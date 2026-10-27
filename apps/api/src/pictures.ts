import { IMAGE_MODELS, IMAGE_SHAPES, IMAGE_SOURCES, PROVIDER_LABELS, type ImageAspect, type ImageSource } from "@gond/shared";
import { planSession, providerBaseUrl, providerKey } from "./data/providers.ts";
import type { StepUsage } from "./data/usage.ts";
import { GROK_MEDIA_HEADERS, grokAccessToken } from "./grok.ts";
import { keyHolder } from "./households.ts";
import { pictureType } from "./images.ts";
import { authHeaders, upstreamUrl } from "./providers.ts";
import { sseStream } from "./sse.ts";

// A plan's token is good on the public API for pictures, as the Grok CLI uses it; its chat proxy has no images route.
const XAI_API_URL = PROVIDER_LABELS.xai.defaultUrl;
const IMAGE_TIMEOUT_MS = 180_000;
const PREVIEWS = 2;

export type ImageAccess = { source: ImageSource; baseUrl: string; headers: Record<string, string> };
export type ImageReference = { name: string; mediaType: string; data: Uint8Array };
export type MadeImage = { data: Uint8Array; mediaType: "image/png" | "image/jpeg" | "image/webp"; source: ImageSource; usage?: StepUsage | null };
export type ImageRequest = { prompt: string; aspect: ImageAspect; references: ImageReference[]; signal?: AbortSignal; onPreview?: (picture: MadeImage) => void };

/** The person's first way to make pictures, in `IMAGE_SOURCES` order; null when they have none. */
export async function imageAccess(userId: string): Promise<ImageAccess | null> {
  // A household member makes pictures on the household's keys, never on anyone's plan.
  const keys = keyHolder(userId);
  for (const source of IMAGE_SOURCES) {
    if (source === "grok") {
      if (keys !== userId || !planSession(userId, "grok")) continue;
      const token = await grokAccessToken(userId).catch(() => null);
      if (token) return { source, baseUrl: XAI_API_URL, headers: { authorization: `Bearer ${token}`, ...GROK_MEDIA_HEADERS } };
      continue;
    }
    const baseUrl = providerBaseUrl(keys, source);
    const key = providerKey(keys, source);
    if (baseUrl && key) return { source, baseUrl, headers: authHeaders(source, baseUrl, key) };
  }
  return null;
}

/** The picture in an images API answer: `data[0]` as base64 or, when a server ignored the format asked for, a URL. */
export function imageFromBody(body: unknown): { b64: string } | { url: string } | null {
  const first = (body as { data?: unknown } | null)?.data;
  const item = Array.isArray(first) ? (first[0] as { b64_json?: unknown; url?: unknown } | undefined) : undefined;
  if (typeof item?.b64_json === "string" && item.b64_json) return { b64: item.b64_json };
  if (typeof item?.url === "string" && /^https:\/\//i.test(item.url)) return { url: item.url };
  return null;
}

/**
 * What making a picture used: OpenAI's tokens (its input counts what was read from the cache) and xAI's
 * billed cost in ticks, 10^10 to the dollar. A Grok plan's picture is the plan's, so it costs nothing here.
 */
export function imageUsage(source: ImageSource, raw: unknown): StepUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const cached = n((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  const ticks = source === "xai" && typeof usage.cost_in_usd_ticks === "number" && Number.isFinite(usage.cost_in_usd_ticks) ? usage.cost_in_usd_ticks / 1e10 : null;
  const tokens = { input: Math.max(0, n(usage.input_tokens) - cached), output: n(usage.output_tokens), cacheRead: cached, cacheWrite: 0 };
  return tokens.input || tokens.output || tokens.cacheRead || ticks ? { tokens, cost: ticks } : null;
}

/** One event of OpenAI's streamed images API: a rough preview, the finished picture, or a failure. */
export function imageStreamEvent(event: unknown): { kind: "partial" | "final"; b64: string } | { kind: "error"; message: string } | null {
  const { type, b64_json, error } = (event ?? {}) as { type?: unknown; b64_json?: unknown; error?: { message?: unknown } };
  if (typeof type !== "string") return null;
  if (type === "error" || type.endsWith(".failed")) return { kind: "error", message: typeof error?.message === "string" ? error.message : "" };
  if (typeof b64_json !== "string" || !b64_json) return null;
  if (type.endsWith(".partial_image")) return { kind: "partial", b64: b64_json };
  if (type.endsWith(".completed")) return { kind: "final", b64: b64_json };
  return null;
}

function errorText(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  const text = typeof error === "string" ? error : typeof (error as { message?: unknown } | null)?.message === "string" ? (error as { message: string }).message : typeof body === "string" ? body : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A refusal in words the bot can pass on. */
export function imageRefusal(source: ImageSource, status: number, body: unknown): string {
  const said = errorText(body);
  const where = IMAGE_MODELS[source].label;
  if (/safety|moderat|content.?polic|not allowed|violat/i.test(said)) return `${where} turned that picture down under its content rules${said ? ` ("${said}")` : ""}. Ask the person for something else, or reword it.`;
  if (source === "grok" && (status === 401 || status === 403)) return "The person's Grok plan can't make pictures: that needs SuperGrok. Tell them, or they can add an xAI or OpenAI key in Settings → AI.";
  if (status === 401 || status === 403) return `${where} refused the person's key. They can check it in Settings → AI.`;
  if (status === 429) return `${where} says the person has hit a usage limit. Try again later.`;
  if (status >= 400 && status < 500) return `${where} couldn't make that picture${said ? `: ${said}` : ""}.`;
  return `${where} didn't make the picture (it answered ${status}). Try again in a moment.`;
}

function decoded(b64: string, source: ImageSource): MadeImage | null {
  const data = new Uint8Array(Buffer.from(b64, "base64"));
  const mediaType = pictureType(data);
  return mediaType && mediaType !== "image/gif" ? { data, mediaType, source } : null;
}

function dataUrl(reference: ImageReference): string {
  return `data:${reference.mediaType};base64,${Buffer.from(reference.data).toString("base64")}`;
}

function xaiBody(access: ImageAccess, request: ImageRequest): Record<string, unknown> {
  const { model, editModel } = IMAGE_MODELS[access.source];
  const body: Record<string, unknown> = { model: request.references.length ? editModel : model, prompt: request.prompt, n: 1, resolution: "1k", response_format: "b64_json" };
  // One picture decides the shape of its own edit; with several, or none, the shape is asked for.
  if (request.references.length !== 1) body.aspect_ratio = IMAGE_SHAPES[request.aspect].ratio;
  if (request.references.length === 1) body.image = { url: dataUrl(request.references[0]!) };
  if (request.references.length > 1) body.images = request.references.map((reference) => ({ url: dataUrl(reference) }));
  return body;
}

function openAiBody(access: ImageAccess, request: ImageRequest): BodyInit {
  const { model, editModel } = IMAGE_MODELS[access.source];
  const size = IMAGE_SHAPES[request.aspect].size;
  if (!request.references.length) return JSON.stringify({ model, prompt: request.prompt, size, n: 1, stream: true, partial_images: PREVIEWS });
  const form = new FormData();
  form.set("model", editModel);
  form.set("prompt", request.prompt);
  form.set("size", size);
  form.set("stream", "true");
  form.set("partial_images", String(PREVIEWS));
  for (const reference of request.references) form.append("image[]", new File([new Uint8Array(reference.data)], reference.name, { type: reference.mediaType }));
  return form;
}

/** Makes one picture with the person's own plan or key. Throws an Error whose message is meant for the bot. */
export async function createImage(access: ImageAccess, request: ImageRequest): Promise<MadeImage> {
  const openai = access.source === "openai";
  const editing = request.references.length > 0;
  const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]) : AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  const body = openai ? openAiBody(access, request) : JSON.stringify(xaiBody(access, request));
  const headers: Record<string, string> = { ...access.headers, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) };
  let res: Response;
  try {
    res = await fetch(upstreamUrl(access.baseUrl, editing ? "images/edits" : "images/generations", ""), { method: "POST", headers, body, redirect: "manual", signal });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new Error(`${IMAGE_MODELS[access.source].label} didn't answer in time. Try again.`);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* plain text */
    }
    throw new Error(imageRefusal(access.source, res.status, payload));
  }

  const unreadable = () => new Error(`${IMAGE_MODELS[access.source].label} answered without a picture. Try again.`);
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
    let made: MadeImage | null = null;
    let usage: StepUsage | null = null;
    for await (const event of sseStream(res.body)) {
      usage = imageUsage(access.source, (event as { usage?: unknown } | null)?.usage) ?? usage;
      const read = imageStreamEvent(event);
      if (!read) continue;
      if (read.kind === "error") throw new Error(imageRefusal(access.source, 400, { error: read.message }));
      const picture = decoded(read.b64, access.source);
      if (!picture) continue;
      if (read.kind === "partial") request.onPreview?.(picture);
      else made = picture;
    }
    if (!made) throw unreadable();
    return { ...made, usage };
  }

  const answer: unknown = await res.json().catch(() => null);
  const usage = imageUsage(access.source, (answer as { usage?: unknown } | null)?.usage);
  const found = imageFromBody(answer);
  if (!found) throw unreadable();
  if ("b64" in found) {
    const picture = decoded(found.b64, access.source);
    if (!picture) throw unreadable();
    return { ...picture, usage };
  }
  // A temporary link the API made for this picture; its bytes are checked like any other.
  const download = await fetch(found.url, { redirect: "follow", signal }).catch(() => null);
  const data = download?.ok ? new Uint8Array(await download.arrayBuffer()) : null;
  const mediaType = data ? pictureType(data) : null;
  if (!data || !mediaType || mediaType === "image/gif") throw unreadable();
  return { data, mediaType, source: access.source, usage };
}

type Preview = { threadId: string; data: Uint8Array; mediaType: string };
const holder = globalThis as typeof globalThis & { __gondPicturePreviews?: Map<string, Preview> };
const previews = () => (holder.__gondPicturePreviews ??= new Map());

/** The latest rough preview of a picture being made, kept in memory only while it is made. */
export function keepPreview(id: string, preview: Preview | null) {
  if (preview) previews().set(id, preview);
  else previews().delete(id);
}

export function previewOf(id: string, threadId: string): Preview | null {
  const preview = previews().get(id);
  return preview?.threadId === threadId ? preview : null;
}
