import { CHATGPT_USAGE_URL, PROVIDER_LABELS, isOpenAiShaped, isPlanProvider, toolLabel, toolLine, type EngineProviderKind, type ProviderKind } from "@gond/shared";
import type { ModelUsage, StepUsage } from "./data/usage.ts";
import { clipParts, clipToolResult, isToolParts, resultAsText, type DriverTool, type ToolPart } from "./driver.ts";
import { sseStream } from "./sse.ts";
import { labelStep, type StepUpdate } from "./work.ts";
import { ANTHROPIC_VERSION, CODER_ONLY_TEXT, authHeaders, coderOnlyRefusal, isAnthropicHost, isMiniMaxHost, isOpenAiHost, upstreamUrl } from "./providers.ts";

const MAX_STEPS = 80;

// Thinking counts toward it on the models that think (MiniMax M3.1 thinks at its deepest unless told otherwise).
const MAX_OUTPUT_TOKENS = 16_000;


export type NativeAccess = {
  kind: EngineProviderKind;

  baseUrl: string;

  token: string;
  upstream?: string;
};

const COMPUTER_USE_BETA = "computer-use-2025-01-24";

const SEARCHES_PER_STEP = 5;

function anthropicNative(access: NativeAccess): boolean {
  return access.kind === "anthropic" && isAnthropicHost(access.upstream ?? "");
}

/** Only Anthropic's own API reads a PDF sent inline; elsewhere the bot opens it on the computer. */
export function readsPdf(access: NativeAccess): boolean {
  return anthropicNative(access);
}

type NativeTurn = {
  access: NativeAccess;
  model: string;

  instructions: string;
  prompt: string;
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: Record<string, DriverTool>;
  maxSteps?: number;
  signal?: AbortSignal;

  onLog?: (line: string) => void;

  onStep?: (step: StepUpdate) => void;

  steers?: SteerQueue;
  // Keeps one conversation's requests on the same cache, where the API takes a key (a ChatGPT plan).
  cacheKey?: string;
  // The reply's words so far as the model writes them, or null when a tool call ends them.
  onText?: TextSink;
  // False leaves out the provider's own web search, for a guest in a space who may only talk.
  search?: boolean;
  onUsage?: (usage: ModelUsage) => void;
};

/** A tool's answer, or the stop's once the turn is stopped, so a tool that ignores the signal never holds a stopped turn open. */
export function unlessStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const stopped = () => (signal.reason instanceof Error ? signal.reason : new Error("Stopped"));
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class SteerQueue {
  private items: string[] = [];
  private open = true;

  push(text: string): boolean {
    if (!this.open) return false;
    this.items.push(text);
    return true;
  }

  take(): string[] {
    return this.items.splice(0);
  }

  last(): string[] {
    const rest = this.take();
    if (!rest.length) this.open = false;
    return rest;
  }

  shut() {
    this.open = false;
  }
}

type NativeResult = {
  ok: boolean;
  text: string;
  stopReason: string | null;
  error: string | null;
};

type Call = { id: string; name: string; input: Record<string, unknown> };

type Step = { text: string; calls: Call[]; searches: Call[]; stopReason: string | null; raw: unknown[]; usage: StepUsage | null };

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

// xAI states a request's billed cost in ticks, 10^10 to the dollar.
const USD_TICKS = 1e10;

/** What a provider says it billed: xAI's ticks, or OpenRouter's `cost` in dollars. Nothing else is a price. */
function billed(usage: Record<string, unknown>): number | null {
  if (typeof usage.cost_in_usd_ticks === "number" && Number.isFinite(usage.cost_in_usd_ticks)) return usage.cost_in_usd_ticks / USD_TICKS;
  return typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null;
}

/** Anthropic's usage: its input leaves out what was read from or written to the cache. */
function anthropicUsage(raw: unknown): StepUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  return { tokens: { input: count(usage.input_tokens), output: count(usage.output_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens) }, cost: null };
}

/** A chat API's usage, whose prompt tokens include those read from the cache. */
function openAiUsage(raw: unknown): StepUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const cached = count((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  return { tokens: { input: Math.max(0, count(usage.prompt_tokens) - cached), output: count(usage.completion_tokens), cacheRead: cached, cacheWrite: 0 }, cost: billed(usage) };
}

/** The Responses API's usage. A plan's requests are the plan's, so nothing on them is a cost. */
function responsesUsage(raw: unknown): StepUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const cached = count((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  return { tokens: { input: Math.max(0, count(usage.input_tokens) - cached), output: count(usage.output_tokens), cacheRead: cached, cacheWrite: 0 }, cost: null };
}

function partsOf(value: unknown): ToolPart[] {
  return isToolParts(value) ? clipParts(value) : [{ type: "text", text: clipToolResult(resultAsText(value)) }];
}

function mediaBlocks(kind: ProviderKind, attachments: NativeTurn["attachments"]): unknown[] {
  const out: unknown[] = [];
  for (const file of attachments ?? []) {
    const image = file.mediaType.startsWith("image/");
    if (isPlanProvider(kind)) {
      if (image) out.push({ type: "input_image", image_url: `data:${file.mediaType};base64,${file.data}` });
    } else if (isOpenAiShaped(kind)) {
      if (image) out.push({ type: "image_url", image_url: { url: `data:${file.mediaType};base64,${file.data}` } });
    } else if (image) {
      out.push({ type: "image", source: { type: "base64", media_type: file.mediaType, data: file.data } });
    } else if (file.mediaType === "application/pdf") {
      out.push({ type: "document", source: { type: "base64", media_type: file.mediaType, data: file.data } });
    }
  }
  return out;
}

/**
 * Web search the provider runs on its side, declared in `tools`: Anthropic's own (dynamic filtering from
 * Opus 4.6 / Sonnet 4.6 on, the basic tool before) and MiniMax's Anthropic-compatible API, which takes the
 * basic one. Results come back as `server_tool_use` and `web_search_tool_result` blocks in the same reply.
 */
export function serverSearch(access: NativeAccess, model: string): unknown | null {
  if (isOpenAiShaped(access.kind) || !access.upstream) return null;
  if (anthropicNative(access)) {
    const type = /^claude-(opus-(4-[6-9]|[5-9])|sonnet-(4-6|[5-9]))/.test(model) ? "web_search_20260209" : "web_search_20250305";
    return { type, name: "web_search", max_uses: SEARCHES_PER_STEP };
  }
  return isMiniMaxHost(access.upstream) ? { type: "web_search_20250305", name: "web_search" } : null;
}

export function toolList(access: NativeAccess, tools: Record<string, DriverTool>, model = "", withSearch = true): unknown[] {
  const native = anthropicNative(access);
  const list = Object.entries(tools).map(([name, tool]) => {
    if (native && tool.native?.anthropic) return tool.native.anthropic;
    const parameters = (tool.inputSchema as object | undefined) ?? { type: "object", properties: {} };
    // Strict is the Responses API's default, and it wants every property required; the tools' schemas aren't written that way.
    if (isPlanProvider(access.kind)) return { type: "function", name, description: tool.description, parameters, strict: false };
    return isOpenAiShaped(access.kind) ? { type: "function", function: { name, description: tool.description, parameters } } : { name, description: tool.description, input_schema: parameters };
  });
  // A ChatGPT plan takes function tools only inside a namespace.
  if (access.kind === "chatgpt") return list.length ? [{ type: "namespace", name: TOOL_NAMESPACE, description: "Gond's tools for this bot.", tools: list }] : [];
  const search = withSearch ? serverSearch(access, model) : null;
  return search ? [...list, search] : list;
}

const TOOL_NAMESPACE = "gond";

function betaHeaders(access: NativeAccess, tools: Record<string, DriverTool>): Record<string, string> {
  return anthropicNative(access) && Object.values(tools).some((tool) => tool.native?.anthropic) ? { "anthropic-beta": COMPUTER_USE_BETA } : {};
}

export function providerError(status: number, body: unknown): string {
  const error = (body as { error?: unknown })?.error;
  const message = typeof error === "string" ? error : ((error as { message?: unknown })?.message ?? (body as { message?: unknown })?.message);
  const detail = typeof message === "string" && message.trim() ? message.trim() : typeof body === "string" && body.trim() ? body.trim() : "";
  if (status === 403 && coderOnlyRefusal(body)) return CODER_ONLY_TEXT;
  if (status === 401 || status === 403) return `The API refused the key${detail ? `: ${detail}` : "."}`;
  if (status === 404) return `The API has no such endpoint or model${detail ? `: ${detail}` : ". Check the base URL and the model id."}`;
  if (!status) return `The API stopped partway${detail ? `: ${detail}` : "."}`;
  return `The API answered ${status}${detail ? `: ${detail}` : "."}`;
}

const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `Usage limit reached on your ChatGPT plan. Manage usage at ${CHATGPT_USAGE_URL}.`,
  subscription_sharing_user_not_eligible: "This ChatGPT account's plan can't be used in other apps.",
  subscription_sharing_invalid_user: "Your ChatGPT sign-in ended. Sign in again in Settings → AI.",
  chatpass_v2_scope_not_authorized: "ChatGPT didn't let Gond use your plan. Sign in again in Settings → AI and allow it.",
  subscription_sharing_usage_unavailable: "ChatGPT couldn't check your plan's usage just now. Try again in a moment.",
  subscription_sharing_user_unavailable: "ChatGPT couldn't check your plan just now. Try again in a moment.",
};

/** What a Grok plan's refusal means to the person; its errors are `{ code, error }`. */
export function grokError(status: number, body: unknown): string {
  const data = (body ?? {}) as { code?: unknown; error?: unknown; message?: unknown };
  const nested = data.error && typeof data.error === "object" ? (data.error as { code?: unknown; message?: unknown }) : null;
  const code = String(nested?.code ?? data.code ?? "");
  const said = nested?.message ?? (typeof data.error === "string" ? data.error : data.message);
  const detail = typeof said === "string" && said.trim() ? said.trim() : "";
  if (code === "subscription:free-usage-exhausted") return "Your free Grok usage is used up for now. A SuperGrok plan raises the limit.";
  if (status === 429) return `Usage limit reached on your Grok plan${detail ? `: ${detail}` : "."}`;
  if (status === 401) return "Your Grok sign-in ended. Sign in again in Settings → AI.";
  if (status === 403) return /subscription/i.test(detail) ? "This Grok account's plan can't be used here. It needs SuperGrok or X Premium+." : `Grok refused the request${detail ? `: ${detail}` : "."}`;
  if (!status) return detail ? `Grok stopped: ${detail}` : "Grok stopped without saying why.";
  return providerError(status, body);
}

/** What a ChatGPT plan's refusal means to the person, from its code, before or inside the stream. */
export function planError(status: number, body: unknown): string {
  const error = (body as { error?: unknown; response?: { error?: unknown } })?.error ?? (body as { response?: { error?: unknown } })?.response?.error;
  const code = (error as { code?: unknown })?.code ?? (body as { code?: unknown })?.code;
  if (typeof code === "string" && PLAN_ERRORS[code]) return PLAN_ERRORS[code];
  const message = (error as { message?: unknown })?.message ?? (body as { detail?: unknown; message?: unknown })?.detail ?? (body as { message?: unknown })?.message;
  const detail = typeof message === "string" && message.trim() ? message.trim() : "";
  if (code === "subscription_sharing_unsupported_capability") return `Your ChatGPT plan can't do that here${detail ? `: ${detail}` : "."}`;
  if (status === 401) return "Your ChatGPT sign-in ended. Sign in again in Settings → AI.";
  if (status === 403) return `ChatGPT refused the request${detail ? `: ${detail}` : "."}`;
  if (status === 429) return `Usage limit reached on your ChatGPT plan. Manage usage at ${CHATGPT_USAGE_URL}.`;
  if (!status) return detail ? `ChatGPT stopped: ${detail}` : "ChatGPT stopped without saying why.";
  return providerError(status, body);
}

type TextSink = (text: string | null) => void;

/** Anthropic's streamed events back into the message an unstreamed call answers, telling `onText` the reply's words on the way. */
export function anthropicAssembler(onText?: TextSink) {
  let message: Record<string, unknown> = {};
  const blocks: Record<string, unknown>[] = [];
  const json = new Map<number, string>();
  let text = "";
  let failure: unknown = null;
  return {
    push(raw: unknown) {
      const event = (raw ?? {}) as { type?: string; index?: number; message?: Record<string, unknown>; content_block?: Record<string, unknown>; delta?: Record<string, unknown>; error?: unknown };
      const index = event.index ?? 0;
      if (event.type === "message_start" && event.message) message = event.message;
      else if (event.type === "content_block_start" && event.content_block) {
        blocks[index] = { ...event.content_block };
        const type = String(event.content_block.type ?? "");
        // What came before a tool call or a search narrated it; the reply is what follows.
        if (type.endsWith("tool_use") || type === "web_search_tool_result") {
          if (text) onText?.(null);
          text = "";
        }
      } else if (event.type === "content_block_delta" && event.delta && blocks[index]) {
        const block = blocks[index];
        const delta = event.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = `${block.text ?? ""}${delta.text}`;
          text += delta.text;
          onText?.(text);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") json.set(index, (json.get(index) ?? "") + delta.partial_json);
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
        else if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature = delta.signature;
        else if (delta.type === "citations_delta" && delta.citation) block.citations = [...((block.citations as unknown[]) ?? []), delta.citation];
      } else if (event.type === "content_block_stop" && blocks[index] && json.has(index)) {
        try {
          blocks[index].input = JSON.parse(json.get(index) || "{}");
        } catch {
          blocks[index].input = {};
        }
        json.delete(index);
      } else if (event.type === "message_delta" && event.delta) {
        // The delta's usage is the running count for the message; the start's carries the input.
        const usage = (event as { usage?: Record<string, unknown> }).usage;
        message = { ...message, ...event.delta, ...(usage ? { usage: { ...((message.usage as object | undefined) ?? {}), ...usage } } : {}) };
      }
      else if (event.type === "error") failure = event;
    },
    result(): { payload: unknown; failure: unknown } {
      return { payload: { ...message, content: blocks.filter(Boolean) }, failure };
    },
  };
}

/** A chat API's streamed chunks back into the message an unstreamed call answers. */
export function openAiAssembler(onText?: TextSink) {
  const message: Record<string, unknown> = {};
  const calls: { id?: string; type?: string; function: { name: string; arguments: string } }[] = [];
  let finish: unknown = null;
  let failure: unknown = null;
  let usage: unknown = null;
  return {
    push(raw: unknown) {
      const chunk = (raw ?? {}) as { choices?: { delta?: Record<string, unknown>; finish_reason?: unknown }[]; error?: unknown; usage?: unknown };
      if (chunk.error) failure = chunk;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      for (const [key, value] of Object.entries(choice.delta ?? {})) {
        if (key === "tool_calls" && Array.isArray(value)) {
          if (!calls.length && typeof message.content === "string" && message.content) onText?.(null);
          for (const part of value as { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[]) {
            const call = (calls[part.index ?? 0] ??= { function: { name: "", arguments: "" } });
            if (part.id) call.id = part.id;
            if (part.type) call.type = part.type;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
          }
        } else if (key === "role") message.role = value;
        // Every other field a provider streams (the content, a model's reasoning) is text to join, as it arrives whole when not streamed.
        else if (typeof value === "string") {
          message[key] = `${(message[key] as string | undefined) ?? ""}${value}`;
          if (key === "content" && !calls.length) onText?.(message.content as string);
        }
      }
    },
    result(): { payload: unknown; failure: unknown } {
      const toolCalls = calls.filter(Boolean).map((call) => ({ ...call, type: call.type ?? "function" }));
      return { payload: { choices: [{ message: { role: "assistant", ...message, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], ...(usage ? { usage } : {}) }, failure };
    },
  };
}

/** The reply's words in a Responses API stream, for `onText`; the step itself is still `readResponses`. */
export function responsesText(onText?: TextSink) {
  let text = "";
  return (raw: unknown) => {
    const event = (raw ?? {}) as { type?: string; delta?: unknown; item?: { type?: string } };
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      onText?.(text);
    } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      if (text) onText?.(null);
      text = "";
    }
  };
}

type ResponseItem = { type?: string; id?: string; role?: string; content?: unknown; call_id?: string; name?: string; arguments?: string; namespace?: string; encrypted_content?: unknown };

/** One Responses API stream into a step. Items go back without their ids, since nothing is stored to point at. */
export function readResponses(events: unknown[], kind: ProviderKind = "chatgpt"): Step {
  const failed = (body: unknown) => (kind === "grok" ? grokError(0, body) : planError(0, body));
  let output: ResponseItem[] | null = null;
  const done: ResponseItem[] = [];
  let stopReason: string | null = null;
  let usage: StepUsage | null = null;
  for (const event of events as { type?: string; item?: ResponseItem; response?: { output?: unknown; usage?: unknown; incomplete_details?: { reason?: unknown } } }[]) {
    if (event.type === "response.output_item.done" && event.item) done.push(event.item);
    if (event.type === "response.failed" || event.type === "error") throw new Error(failed(event));
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      if (Array.isArray(event.response?.output) && event.response.output.length) output = event.response.output as ResponseItem[];
      usage = responsesUsage(event.response?.usage);
      const reason = event.response?.incomplete_details?.reason;
      stopReason = event.type === "response.completed" ? "completed" : reason === "max_output_tokens" ? "max_tokens" : typeof reason === "string" ? reason : "incomplete";
    }
  }
  if (!stopReason) throw new Error(`${isPlanProvider(kind) ? PROVIDER_LABELS[kind].short : "The model"}'s answer broke off before it finished.`);
  // Nothing is stored, so a model that thinks gets its reasoning back only as the encrypted copy it handed over.
  const items = (output ?? done).filter((item) => item.type === "message" || item.type === "function_call" || (item.type === "reasoning" && typeof item.encrypted_content === "string"));
  const text = items
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => (item.content as { type?: string; text?: string }[]).filter((part) => part.type === "output_text").map((part) => part.text ?? ""))
    .join("")
    .trim();
  const calls: Call[] = items
    .filter((item) => item.type === "function_call" && typeof item.name === "string")
    .map((item) => {
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(item.arguments || "{}");
        if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
      } catch {
        /* a model that writes broken JSON gets the tool's own complaint back */
      }
      const name = item.name!.startsWith(`${TOOL_NAMESPACE}.`) ? item.name!.slice(TOOL_NAMESPACE.length + 1) : item.name!;
      return { id: String(item.call_id ?? ""), name, input };
    });
  const raw = items.map(({ id: _id, ...item }) => item);
  return { text, calls, searches: [], stopReason, raw, usage };
}

async function sendResponses(turn: NativeTurn, input: unknown[], onText?: TextSink): Promise<Step> {
  const { baseUrl, token } = turn.access;
  const grok = turn.access.kind === "grok";
  const tools = toolList(turn.access, turn.tools, turn.model, turn.search !== false);
  const res = await fetch(upstreamUrl(baseUrl, "responses", ""), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: turn.model, instructions: turn.instructions, input, ...(tools.length ? { tools } : {}), store: false, stream: true, ...(grok ? { include: ["reasoning.encrypted_content"] } : {}), ...(turn.access.kind === "chatgpt" && turn.cacheKey ? { prompt_cache_key: turn.cacheKey } : {}) }),
    redirect: "manual",
    signal: turn.signal,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* plain text */
    }
    throw new Error(grok ? grokError(res.status, payload) : planError(res.status, payload));
  }
  const events: unknown[] = [];
  const words = responsesText(onText);
  for await (const event of sseStream(res.body!)) {
    events.push(event);
    words(event);
  }
  return readResponses(events, turn.access.kind);
}

/**
 * OpenAI's own API refuses `max_tokens` from its reasoning models on (GPT-5, o-series) and wants
 * `max_completion_tokens`; servers that copy its API (OpenRouter, a local model) mostly know only the old name.
 */
export function outputLimit(access: Pick<NativeAccess, "upstream">): { max_tokens: number } | { max_completion_tokens: number } {
  return access.upstream && isOpenAiHost(access.upstream) ? { max_completion_tokens: MAX_OUTPUT_TOKENS } : { max_tokens: MAX_OUTPUT_TOKENS };
}

const CACHEABLE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result"]);

/**
 * Anthropic's cache breakpoints: after the tools, after the system prompt and after the conversation
 * so far, so a turn's next model round reads everything before it from the cache.
 */
export function withCacheBreakpoints(system: string, tools: unknown[], messages: unknown[]): { system: unknown[]; tools: unknown[]; messages: unknown[] } {
  const mark = <T extends object>(block: T) => ({ ...block, cache_control: { type: "ephemeral" } });
  const last = messages.at(-1) as { role?: string; content?: unknown } | undefined;
  let marked = messages;
  if (last && typeof last.content === "string") {
    marked = [...messages.slice(0, -1), { ...last, content: [mark({ type: "text", text: last.content })] }];
  } else if (last && Array.isArray(last.content) && last.content.length) {
    const tail = last.content.at(-1) as { type?: string };
    if (CACHEABLE_BLOCKS.has(tail.type ?? "")) marked = [...messages.slice(0, -1), { ...last, content: [...last.content.slice(0, -1), mark(tail)] }];
  }
  return {
    system: [mark({ type: "text", text: system })],
    tools: tools.length ? [...tools.slice(0, -1), mark(tools.at(-1) as object)] : tools,
    messages: marked,
  };
}

async function send(turn: NativeTurn, messages: unknown[], onText?: TextSink): Promise<Step> {
  if (isPlanProvider(turn.access.kind)) return sendResponses(turn, messages, onText);
  const { kind, baseUrl, token } = turn.access;
  const openai = isOpenAiShaped(kind);
  const url = upstreamUrl(baseUrl, openai ? "chat/completions" : "v1/messages", "");
  const body = openai
    ? { model: turn.model, messages: [{ role: "system", content: turn.instructions }, ...messages], tools: toolList(turn.access, turn.tools, turn.model, turn.search !== false), ...outputLimit(turn.access), stream: true, stream_options: { include_usage: true } }
    : anthropicNative(turn.access)
      ? { model: turn.model, ...withCacheBreakpoints(turn.instructions, toolList(turn.access, turn.tools, turn.model, turn.search !== false), messages), max_tokens: MAX_OUTPUT_TOKENS, stream: true }
      : { model: turn.model, system: turn.instructions, messages, tools: toolList(turn.access, turn.tools, turn.model, turn.search !== false), max_tokens: MAX_OUTPUT_TOKENS, stream: true };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(kind, baseUrl, token), ...(openai ? {} : { "anthropic-version": ANTHROPIC_VERSION, ...betaHeaders(turn.access, turn.tools) }) },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: turn.signal,
  });
  // A server that doesn't stream answers the whole thing at once, as it did before streaming was asked for.
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(providerError(res.status, payload));
    return openai ? readOpenAi(payload) : readAnthropic(payload);
  }
  const assembler = openai ? openAiAssembler(onText) : anthropicAssembler(onText);
  for await (const event of sseStream(res.body)) assembler.push(event);
  const { payload, failure } = assembler.result();
  if (failure) throw new Error(providerError(0, failure));
  return openai ? readOpenAi(payload) : readAnthropic(payload);
}

export function readAnthropic(payload: unknown): Step {
  const data = (payload ?? {}) as { content?: unknown; stop_reason?: unknown; usage?: unknown };
  const blocks = Array.isArray(data.content) ? (data.content as { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]) : [];
  // After a search the answer is the text past the last result; what came before narrated the search.
  const lastSearch = blocks.findLastIndex((block) => block.type === "server_tool_use" || block.type === "web_search_tool_result");
  const text = blocks
    .slice(lastSearch + 1)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  const calls: Call[] = blocks
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({ id: String(block.id ?? ""), name: block.name as string, input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown> }));
  const searches: Call[] = blocks
    .filter((block) => block.type === "server_tool_use" && block.name === "web_search")
    .map((block) => ({ id: String(block.id ?? ""), name: "WebSearch", input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown> }));
  return {
    text,
    calls,
    searches,
    stopReason: typeof data.stop_reason === "string" ? data.stop_reason : null,
    raw: [{ role: "assistant", content: blocks }],
    usage: anthropicUsage(data.usage),
  };
}

export function readOpenAi(payload: unknown): Step {
  const data = (payload ?? {}) as { choices?: unknown; usage?: unknown };
  const choice = (Array.isArray(data.choices) ? data.choices[0] : null) as { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown } | null;
  const message = choice?.message ?? {};
  const content = message.content;

  const text = typeof content === "string" ? content.trim() : Array.isArray(content) ? (content as { text?: string }[]).map((part) => part.text ?? "").join("").trim() : "";
  const calls: Call[] = (Array.isArray(message.tool_calls) ? (message.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[]) : [])
    .filter((call) => typeof call.function?.name === "string")
    .map((call) => {
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function?.arguments || "{}");
        if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
      } catch {
        /* a model that writes broken JSON gets the tool's own complaint back */
      }
      return { id: String(call.id ?? ""), name: call.function!.name as string, input };
    });
  return {
    text,
    calls,
    searches: [],
    stopReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    raw: [message],
    usage: openAiUsage(data.usage),
  };
}

type ToolAnswer = { call: { id: string }; parts: ToolPart[]; isError: boolean };

function toolAnswer(kind: ProviderKind, answer: ToolAnswer): unknown {
  const text = answer.parts.filter((part): part is Extract<ToolPart, { type: "text" }> => part.type === "text").map((part) => part.text);
  const images = answer.parts.filter((part): part is Extract<ToolPart, { type: "image" }> => part.type === "image");
  if (isOpenAiShaped(kind)) return { role: "tool", tool_call_id: answer.call.id, content: [...text, ...(images.length ? ["(the picture follows as an image)"] : [])].join("\n") };
  const content = images.length ? answer.parts.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } })) : text.join("\n");
  return { type: "tool_result", tool_use_id: answer.call.id, content, is_error: answer.isError };
}

export function stepMessages(kind: ProviderKind, answers: ToolAnswer[], steers: string[] = []): unknown[] {
  if (isPlanProvider(kind)) {
    const outputs = answers.map((answer) => ({
      type: "function_call_output",
      call_id: answer.call.id,
      output: answer.parts.some((part) => part.type === "image")
        ? answer.parts.map((part) => (part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` }))
        : answer.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    }));
    return steers.length ? [...outputs, { role: "user", content: steers.join("\n\n") }] : outputs;
  }
  if (!isOpenAiShaped(kind)) return [{ role: "user", content: [...answers.map((answer) => toolAnswer(kind, answer)), ...steers.map((text) => ({ type: "text", text }))] }];
  const messages = answers.map((answer) => toolAnswer(kind, answer));
  const images = answers.flatMap((answer) => answer.parts.filter((part): part is Extract<ToolPart, { type: "image" }> => part.type === "image"));
  if (images.length) {
    messages.push({ role: "user", content: [...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })), ...steers.map((text) => ({ type: "text", text }))] });
  } else if (steers.length) {
    messages.push({ role: "user", content: steers.join("\n\n") });
  }
  return messages;
}

export async function nativeTurn(turn: NativeTurn): Promise<NativeResult> {
  const { kind } = turn.access;
  const media = mediaBlocks(kind, turn.attachments);
  const first = media.length ? [...media, isPlanProvider(kind) ? { type: "input_text", text: turn.prompt } : { type: "text", text: turn.prompt }] : turn.prompt;
  const messages: unknown[] = [{ role: "user", content: first }];
  const maxSteps = turn.maxSteps ?? MAX_STEPS;

  const said: string[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    if (turn.signal?.aborted) return { ok: false, text: "", stopReason: "aborted", error: null };
    let answer: Step;
    try {
      const before = said.filter(Boolean);
      answer = await send(turn, messages, turn.onText && ((text) => turn.onText!(text === null ? null : [...before, text].join("\n\n"))));
    } catch (error) {
      if (turn.signal?.aborted) return { ok: false, text: "", stopReason: "aborted", error: null };
      throw error;
    }
    if (answer.usage) turn.onUsage?.({ model: turn.model, ...answer.usage });
    for (const search of answer.searches) {
      const line = toolLine(toolLabel(search.name, search.input));
      if (line) turn.onLog?.(line);
      turn.onStep?.(labelStep({ id: search.id, tool: search.name, input: search.input, status: "done" }));
    }
    if (answer.text && turn.onLog) turn.onLog(answer.text.replace(/\s+/g, " ").slice(0, 200));
    if (answer.text.trim() && answer.calls.length) turn.onStep?.({ id: `note-${crypto.randomUUID()}`, kind: "note", title: answer.text.trim().replace(/\s+/g, " ").slice(0, 200), detail: answer.text.trim(), status: "done" });
    if (!answer.calls.length && answer.stopReason === "pause_turn") {
      // The provider's search loop paused; sending its turn back as it is resumes it.
      if (answer.text) said.push(answer.text);
      messages.push(...answer.raw);
      continue;
    }
    if (!answer.calls.length) {
      const late = turn.steers?.last() ?? [];
      if (late.length) {
        if (answer.text) said.push(answer.text);
        messages.push(...answer.raw, { role: "user", content: late.join("\n\n") });
        continue;
      }
      const text = [...said, answer.text].filter(Boolean).join("\n\n");
      const empty = answer.stopReason === "max_tokens" ? "The model spent its whole reply thinking and wrote nothing. Try again, or a model that thinks less." : "The API answered with nothing.";
      return { ok: Boolean(text), text, stopReason: answer.stopReason, error: text ? null : empty };
    }
    turn.onText?.(null);
    messages.push(...answer.raw);
    const answers = await Promise.all(
      answer.calls.map(async (call) => {
        const line = toolLine(toolLabel(call.name, call.input));
        if (line) turn.onLog?.(line);
        turn.onStep?.(labelStep({ id: call.id, tool: call.name, input: call.input, status: "running" }));
        const tool = turn.tools[call.name];
        try {
          if (!tool) throw new Error(`No such tool: ${call.name}`);
          const value = await unlessStopped(tool.execute(call.input, call.id), turn.signal);
          turn.onStep?.({ id: call.id, output: resultAsText(value), status: "done" });
          return { call, parts: partsOf(value), isError: false } satisfies ToolAnswer;
        } catch (error) {
          const text = error instanceof Error ? error.message : "Tool failed";
          turn.onStep?.({ id: call.id, output: text, status: "failed" });
          return { call, parts: [{ type: "text", text: clipToolResult(text) }], isError: true } satisfies ToolAnswer;
        }
      }),
    );
    messages.push(...stepMessages(kind, answers, turn.steers?.take() ?? []));
  }
  return { ok: false, text: "", stopReason: "max_steps", error: `The model was still working after ${maxSteps} steps, so the turn was stopped.` };
}
