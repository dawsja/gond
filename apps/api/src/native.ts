import { isOpenAiShaped, toolLabel, toolLine, type ProviderKind } from "@gond/shared";
import { clipParts, isToolParts, resultAsText, type DriverTool, type ToolPart } from "./driver.ts";
import { labelStep, type StepUpdate } from "./work.ts";
import { authHeaders, isAnthropicHost, isMiniMaxHost, upstreamUrl } from "./routes/llm.ts";

const MAX_STEPS = 80;

// Thinking counts toward it on the models that think (MiniMax M3.1 thinks at its deepest unless told otherwise).
const MAX_OUTPUT_TOKENS = 16_000;

const MAX_TOOL_RESULT = 24_000;

export type NativeAccess = {
  kind: ProviderKind;

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

export type NativeTurn = {
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
};

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

export type NativeResult = {
  ok: boolean;
  text: string;
  stopReason: string | null;
  error: string | null;
};

type Call = { id: string; name: string; input: Record<string, unknown> };

type Step = { text: string; calls: Call[]; searches: Call[]; stopReason: string | null; raw: unknown };

function clip(text: string) {
  return text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}\n[… ${text.length - MAX_TOOL_RESULT} more characters]` : text;
}

function partsOf(value: unknown): ToolPart[] {
  return isToolParts(value) ? clipParts(value) : [{ type: "text", text: clip(resultAsText(value)) }];
}

function mediaBlocks(kind: ProviderKind, attachments: NativeTurn["attachments"]): unknown[] {
  const out: unknown[] = [];
  for (const file of attachments ?? []) {
    const image = file.mediaType.startsWith("image/");
    if (isOpenAiShaped(kind)) {
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

export function toolList(access: NativeAccess, tools: Record<string, DriverTool>, model = ""): unknown[] {
  const native = anthropicNative(access);
  const list = Object.entries(tools).map(([name, tool]) => {
    if (native && tool.native?.anthropic) return tool.native.anthropic;
    const parameters = (tool.inputSchema as object | undefined) ?? { type: "object", properties: {} };
    return isOpenAiShaped(access.kind) ? { type: "function", function: { name, description: tool.description, parameters } } : { name, description: tool.description, input_schema: parameters };
  });
  const search = serverSearch(access, model);
  return search ? [...list, search] : list;
}

function betaHeaders(access: NativeAccess, tools: Record<string, DriverTool>): Record<string, string> {
  return anthropicNative(access) && Object.values(tools).some((tool) => tool.native?.anthropic) ? { "anthropic-beta": COMPUTER_USE_BETA } : {};
}

export function providerError(status: number, body: unknown): string {
  const error = (body as { error?: unknown })?.error;
  const message = typeof error === "string" ? error : ((error as { message?: unknown })?.message ?? (body as { message?: unknown })?.message);
  const detail = typeof message === "string" && message.trim() ? message.trim() : typeof body === "string" && body.trim() ? body.trim() : "";
  if (status === 401 || status === 403) return `The API refused the key${detail ? `: ${detail}` : "."}`;
  if (status === 404) return `The API has no such endpoint or model${detail ? `: ${detail}` : ". Check the base URL and the model id."}`;
  return `The API answered ${status}${detail ? `: ${detail}` : "."}`;
}

async function send(turn: NativeTurn, messages: unknown[]): Promise<Step> {
  const { kind, baseUrl, token } = turn.access;
  const openai = isOpenAiShaped(kind);
  const url = upstreamUrl(baseUrl, openai ? "chat/completions" : "v1/messages", "");
  const body = openai
    ? { model: turn.model, messages: [{ role: "system", content: turn.instructions }, ...messages], tools: toolList(turn.access, turn.tools, turn.model), max_tokens: MAX_OUTPUT_TOKENS }
    : { model: turn.model, system: turn.instructions, messages, tools: toolList(turn.access, turn.tools, turn.model), max_tokens: MAX_OUTPUT_TOKENS };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(kind, baseUrl, token), ...(openai ? {} : { "anthropic-version": "2023-06-01", ...betaHeaders(turn.access, turn.tools) }) },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: turn.signal,
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(providerError(res.status, payload));
  return openai ? readOpenAi(payload) : readAnthropic(payload);
}

export function readAnthropic(payload: unknown): Step {
  const data = (payload ?? {}) as { content?: unknown; stop_reason?: unknown };
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
    raw: { role: "assistant", content: blocks },
  };
}

export function readOpenAi(payload: unknown): Step {
  const data = (payload ?? {}) as { choices?: unknown };
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
    raw: message,
  };
}

export type ToolAnswer = { call: { id: string }; parts: ToolPart[]; isError: boolean };

function toolAnswer(kind: ProviderKind, answer: ToolAnswer): unknown {
  const text = answer.parts.filter((part): part is Extract<ToolPart, { type: "text" }> => part.type === "text").map((part) => part.text);
  const images = answer.parts.filter((part): part is Extract<ToolPart, { type: "image" }> => part.type === "image");
  if (isOpenAiShaped(kind)) return { role: "tool", tool_call_id: answer.call.id, content: [...text, ...(images.length ? ["(the screenshot follows as an image)"] : [])].join("\n") };
  const content = images.length ? answer.parts.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } })) : text.join("\n");
  return { type: "tool_result", tool_use_id: answer.call.id, content, is_error: answer.isError };
}

export function stepMessages(kind: ProviderKind, answers: ToolAnswer[], steers: string[] = []): unknown[] {
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
  const openai = isOpenAiShaped(kind);
  const media = mediaBlocks(kind, turn.attachments);
  const first = media.length ? [...media, openai ? { type: "text", text: turn.prompt } : { type: "text", text: turn.prompt }] : turn.prompt;
  const messages: unknown[] = [{ role: "user", content: first }];
  const maxSteps = turn.maxSteps ?? MAX_STEPS;

  const said: string[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    if (turn.signal?.aborted) return { ok: false, text: "", stopReason: "aborted", error: null };
    let answer: Step;
    try {
      answer = await send(turn, messages);
    } catch (error) {
      if (turn.signal?.aborted) return { ok: false, text: "", stopReason: "aborted", error: null };
      throw error;
    }
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
      messages.push(answer.raw);
      continue;
    }
    if (!answer.calls.length) {
      const late = turn.steers?.last() ?? [];
      if (late.length) {
        if (answer.text) said.push(answer.text);
        messages.push(answer.raw, { role: "user", content: late.join("\n\n") });
        continue;
      }
      const text = [...said, answer.text].filter(Boolean).join("\n\n");
      const empty = answer.stopReason === "max_tokens" ? "The model spent its whole reply thinking and wrote nothing. Try again, or a model that thinks less." : "The API answered with nothing.";
      return { ok: Boolean(text), text, stopReason: answer.stopReason, error: text ? null : empty };
    }
    messages.push(answer.raw);
    const answers = await Promise.all(
      answer.calls.map(async (call) => {
        const line = toolLine(toolLabel(call.name, call.input));
        if (line) turn.onLog?.(line);
        turn.onStep?.(labelStep({ id: call.id, tool: call.name, input: call.input, status: "running" }));
        const tool = turn.tools[call.name];
        try {
          if (!tool) throw new Error(`No such tool: ${call.name}`);
          const value = await tool.execute(call.input, call.id);
          turn.onStep?.({ id: call.id, output: resultAsText(value), status: "done" });
          return { call, parts: partsOf(value), isError: false } satisfies ToolAnswer;
        } catch (error) {
          const text = error instanceof Error ? error.message : "Tool failed";
          turn.onStep?.({ id: call.id, output: text, status: "failed" });
          return { call, parts: [{ type: "text", text: clip(text) }], isError: true } satisfies ToolAnswer;
        }
      }),
    );
    messages.push(...stepMessages(kind, answers, turn.steers?.take() ?? []));
  }
  return { ok: false, text: "", stopReason: "max_steps", error: `The model was still working after ${maxSteps} steps, so the turn was stopped.` };
}
