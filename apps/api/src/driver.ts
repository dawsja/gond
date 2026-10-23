import { isQuietTool, toolLabel, toolLine, type Engine, type ToolLabelContext } from "@gond/shared";
import { answerAgentTool, runAgentTurn, type AgentTool, type BoxAccess, type BoxConfig } from "./box.ts";
import { labelStep, type StepUpdate } from "./work.ts";

export type ToolPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };
export type ToolResult = string | ToolPart[];

export type DriverTool = {
  description: string;
  inputSchema: unknown;
  execute: (input: Record<string, unknown>, callId: string) => Promise<unknown>;
  native?: { anthropic?: unknown };
};

export function isToolParts(value: unknown): value is ToolPart[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => part && typeof part === "object" && ((part as ToolPart).type === "text" || (part as ToolPart).type === "image"));
}

export function pngSize(base64: string): { width: number; height: number } | null {
  try {
    const head = Buffer.from(base64.slice(0, 44), "base64");
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

export function resultAsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isToolParts(value)) {
    return value
      .map((part) => {
        if (part.type === "text") return part.text;
        const size = part.mimeType === "image/png" ? pngSize(part.data) : null;
        return size ? `[screenshot ${size.width}x${size.height}]` : "[screenshot]";
      })
      .join("\n");
  }
  return JSON.stringify(value ?? "");
}

export function agentToolsFor(tools: Record<string, DriverTool>): AgentTool[] {
  return Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema ?? { type: "object", properties: {} } }));
}

const MAX_TOOL_RESULT = 24_000;

export function clipToolResult(text: string, limit = MAX_TOOL_RESULT) {
  return text.length > limit ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]` : text;
}

export function clipParts(parts: ToolPart[]): ToolPart[] {
  return parts.map((part) => (part.type === "text" ? { ...part, text: clipToolResult(part.text) } : part));
}

export type CliTurn = {
  box: BoxConfig;
  engine: Engine;
  access: BoxAccess;

  agentId: string;
  botId: string;
  modelId: string;
  maxTurns?: number;
  permission: "ask" | "full";
  instructions: string;
  prompt: string;
  // Only what is new since this agent's last turn; the box sends it instead
  // of `prompt` when the CLI session already carries the conversation.
  followUp?: string;
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: Record<string, DriverTool>;

  mcpServers?: unknown[];

  home?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;

  onLog?: (line: string) => void;

  onStep?: (step: StepUpdate) => void;
  // The reply's words so far as the model writes them, or null when a tool call ends them.
  onText?: (text: string | null) => void;
};

export type CliTurnResult = {
  ok: boolean;
  text: string;
  stopReason: string | null;
  error: string | null;
  recovered: boolean;
};

type StreamEvent = { type?: string; message?: { content?: unknown }; parent_tool_use_id?: string | null };
type ContentBlock = { type?: string; id?: string; text?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

function isPermissionTool(name: string): boolean {
  return name === "mcp__gond__permission";
}

function parseStream(line: string): StreamEvent | null {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
}

export function activityLine(line: string, context: ToolLabelContext = {}): string[] {
  const event = parseStream(line);
  if (event?.type !== "assistant") return [];
  const blocks = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push(block.text.trim().replace(/\s+/g, " ").slice(0, 200));
    } else if (block.type === "tool_use") {
      const title = toolLine(toolLabel(block.name ?? "tool", block.input ?? {}, context));
      if (title) out.push(title);
    }
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : part.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export function workSteps(line: string, context: ToolLabelContext = {}): StepUpdate[] {
  const event = parseStream(line);
  if (event?.type !== "assistant" && event?.type !== "user") return [];
  const blocks = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];
  const out: StepUpdate[] = [];
  for (const block of blocks) {
    if (event.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push({ id: `note-${crypto.randomUUID()}`, kind: "note", title: block.text.trim().replace(/\s+/g, " ").slice(0, 200), detail: block.text.trim(), status: "done" });
    } else if (event.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
      const name = block.name ?? "tool";
      const input = block.input ?? {};
      if (isPermissionTool(name)) continue;
      const title = toolLine(toolLabel(name, input, context));
      if (!title && !isQuietTool(name, input)) continue;
      out.push(labelStep({ id: block.id, tool: name, input, status: "running" }, context));
    } else if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      out.push({ id: block.tool_use_id, output: resultText(block.content), status: block.is_error ? "failed" : "done" });
    }
  }
  return out;
}

export async function cliTurn(turn: CliTurn): Promise<CliTurnResult> {
  const inflight: Promise<void>[] = [];
  const handleCall = async (callId: string, name: string, input: Record<string, unknown>) => {
    const tool = turn.tools[name];
    let content: ToolResult;
    let isError = false;
    try {
      if (!tool) throw new Error(`No such tool: ${name}`);
      const value = await tool.execute(input, callId);
      content = isToolParts(value) ? clipParts(value) : clipToolResult(resultAsText(value));
    } catch (error) {
      content = error instanceof Error ? error.message : "Tool failed";
      isError = true;
    }
    await answerAgentTool(turn.box, turn.agentId, { callId, content, isError }).catch(() => undefined);
  };

  const context: ToolLabelContext = { home: turn.home ?? null, servers: (turn.mcpServers ?? []).flatMap((server) => (typeof (server as { name?: unknown }).name === "string" ? [{ name: (server as { name: string }).name }] : [])) };

  let segment = "";
  const result = await runAgentTurn(
    turn.box,
    turn.agentId,
    {
      bot: turn.botId,
      engine: turn.engine,
      access: turn.access,
      model: turn.modelId,
      maxTurns: turn.maxTurns ?? null,
      permission: turn.permission,
      systemPrompt: turn.instructions,
      prompt: turn.prompt,
      ...(turn.followUp ? { followUp: turn.followUp } : {}),
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      tools: agentToolsFor(turn.tools),
      ...(turn.mcpServers?.length ? { mcpServers: turn.mcpServers } : {}),
      timeoutMs: turn.timeoutMs,
    },
    {
      signal: turn.signal,
      onEvent: (event) => {
        if (event.type === "tool_call") {
          inflight.push(handleCall(event.callId, event.name, event.input));
        } else if (event.type === "text_delta") {
          segment += event.text;
          turn.onText?.(segment);
        } else if (event.type === "text_end") {
          if (segment) turn.onText?.(null);
          segment = "";
        } else if (event.type === "line") {
          if (turn.onLog) for (const line of activityLine(event.line, context)) turn.onLog(line);
          if (turn.onStep) for (const step of workSteps(event.line, context)) turn.onStep(step);
        } else if (event.type === "activity" && turn.onLog) {
          turn.onLog(event.line);
        } else if (event.type === "step") {
          const step = labelStep(event.step, context);
          if (turn.onLog && event.step.tool && event.step.title === undefined && step.title && !step.quiet) turn.onLog(step.title);
          turn.onStep?.(step);
        }
      },
    },
  ).finally(() => Promise.allSettled(inflight));
  if (!result) return { ok: false, text: "", stopReason: "no_result", error: "The box closed the stream without a result", recovered: false };
  return {
    ok: result.ok,
    text: result.text,
    stopReason: result.stopReason,
    error: result.error ?? null,
    recovered: result.recovered,
  };
}
