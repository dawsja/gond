import { bareToolName, describeTool, isQuietTool, toolLine, WORK_OUTPUT_MAX, WORK_STEPS_MAX, type ToolLabelContext, type WorkStep } from "@gond/shared";
import { emit } from "./events.ts";

export type StepUpdate = { id: string; tool?: string; input?: Record<string, unknown> } & Partial<Omit<WorkStep, "id" | "at">>;

const holder = globalThis as typeof globalThis & { __gondWork?: Map<string, Map<string, WorkStep>> };

function logs(): Map<string, Map<string, WorkStep>> {
  return (holder.__gondWork ??= new Map());
}

const keyOf = (threadId: string, botId: string) => `${threadId}\n${botId}`;

export function clipOutput(text: string, max = WORK_OUTPUT_MAX): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  return `${text.slice(0, head)}\n[… ${text.length - max} characters …]\n${text.slice(text.length - (max - head))}`;
}

export function labelStep(update: StepUpdate, context: ToolLabelContext = {}): StepUpdate {
  if (update.title !== undefined || !update.tool) return update;
  const input = update.input ?? {};
  const command = update.tool === "Bash" && typeof input.command === "string" ? input.command : null;
  const { tool, input: _input, ...rest } = update;
  return {
    ...rest,
    tool,
    kind: update.kind ?? (command !== null ? "command" : typeof input.file_path === "string" ? "file" : "tool"),
    title: toolLine(describeTool(tool, input, context)) ?? "",
    detail: update.detail !== undefined ? update.detail : (command ?? (Object.keys(input).length ? JSON.stringify(input, null, 2) : null)),
    quiet: isQuietTool(tool, input),
  };
}

export function recordStep(threadId: string, botId: string, raw: StepUpdate, context: ToolLabelContext = {}): WorkStep | null {
  const update = labelStep(raw, context);
  const key = keyOf(threadId, botId);
  let log = logs().get(key);
  const known = log?.get(update.id);
  if (!known && update.title === undefined) return null;
  if (!log) logs().set(key, (log = new Map()));
  const quiet = update.quiet ?? known?.quiet ?? false;
  const step: WorkStep = {
    id: update.id,
    kind: update.kind ?? known?.kind ?? "tool",
    title: update.title ?? known?.title ?? "",
    detail: update.detail !== undefined ? update.detail : (known?.detail ?? null),
    output: update.output !== undefined ? (update.output === null ? null : clipOutput(update.output)) : (known?.output ?? null),
    status: update.status ?? known?.status ?? "running",
    ...(quiet ? { quiet: true } : {}),
    at: known?.at ?? new Date().toISOString(),
  };
  log.set(step.id, step);
  while (log.size > WORK_STEPS_MAX) log.delete(log.keys().next().value!);
  emit({ topic: "work", threadId, botId, step });
  return step;
}

export function workFor(threadId: string): Record<string, WorkStep[]> {
  const out: Record<string, WorkStep[]> = {};
  for (const [key, log] of logs()) {
    const [thread, bot] = key.split("\n");
    if (thread === threadId && bot) out[bot] = [...log.values()];
  }
  return out;
}

export function clearWork(threadId: string, botId: string) {
  logs().delete(keyOf(threadId, botId));
}

type TurnTiming = { totalMs: number; toolsMs: number; modelMs: number; rounds: number; calls: number; screen: number; queuedMs: number; setupMs: number; firstMs: number | null };

/**
 * A turn's time from the message to its end: how long it waited to start (`queuedSince`), its setup
 * until `ready()` (the model is asked), when `firstText()` came, then the model's rounds and the tools.
 */
export function createTurnClock(now: () => number = Date.now, queuedSince?: number) {
  const started = now();
  const open = new Map<string, number>();
  let idleSince: number | null = started;
  let setupMs = 0;
  let firstMs: number | null = null;
  let modelMs = 0;
  let rounds = 0;
  let calls = 0;
  let screen = 0;
  return {
    ready() {
      if (setupMs || rounds || open.size) return;
      setupMs = now() - started;
      idleSince = now();
    },
    firstText() {
      if (firstMs === null) firstMs = now() - started;
    },
    step(update: StepUpdate) {
      const finished = update.status === "done" || update.status === "failed";
      if (!finished && !open.has(update.id) && update.tool) {
        if (open.size === 0 && idleSince !== null) {
          modelMs += now() - idleSince;
          idleSince = null;
          rounds++;
        }
        open.set(update.id, now());
        calls++;
        const tool = bareToolName(update.tool);
        if (tool === "browser" || tool === "computer") screen++;
      } else if (finished && open.delete(update.id) && open.size === 0) {
        idleSince = now();
      }
    },
    timing(): TurnTiming {
      const totalMs = now() - started;
      const model = modelMs + (idleSince !== null ? now() - idleSince : 0);
      const queuedMs = queuedSince === undefined ? 0 : Math.max(0, started - queuedSince);
      return { totalMs, toolsMs: totalMs - setupMs - model, modelMs: model, rounds: rounds + 1, calls, screen, queuedMs, setupMs, firstMs };
    },
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function timingLine(name: string, run: string, timing: TurnTiming): string {
  const start = `waited ${seconds(timing.queuedMs)}, setup ${seconds(timing.setupMs)}, first words ${timing.firstMs === null ? "never" : `at ${seconds(timing.firstMs)}`}`;
  return `[gond] ${name} took ${seconds(timing.totalMs)} on ${run} (${start}): ${timing.rounds} model round${timing.rounds === 1 ? "" : "s"} (${seconds(timing.modelMs)}), ${timing.calls} tool call${timing.calls === 1 ? "" : "s"} (${timing.screen} on the screen, ${seconds(timing.toolsMs)})`;
}
