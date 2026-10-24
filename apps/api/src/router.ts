import { handleOf, mentionsIn, roomAnswerer, roomTargets, type Bot, type Message, type Thread } from "@gond/shared";
import { boxConfig, closeAgent } from "./box.ts";
import { getAi } from "./data/ai.ts";
import { cliTurn } from "./driver.ts";
import { engineRun, type EngineRun } from "./engines.ts";
import { nativeTurn } from "./native.ts";
import { transcriptLines } from "./transcript.ts";

// The room's lines the router reads, each cut short: it needs the thread of talk, not the detail.
const ROUTE_LINES = 12;
const ROUTE_LINE_CHARS = 300;
// Past this the person's line goes by the rules instead: a slow pick is worse than a plain one.
export const ROUTE_TIMEOUT_MS = 8_000;

export const ROUTER_INSTRUCTIONS = "You decide which bot in a group chat a person's message is for. You only answer with @handles: you have no tools and do nothing else.";

export function routerPrompt(members: Bot[], lines: string, body: string): string {
  const roster = members.map((b) => `- @${handleOf(b.name)}: ${b.name}${b.title ? `, ${b.title}` : ""}${b.description ? `. ${b.description.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n");
  return [
    `The bots in this room, with their jobs:\n${roster}`,
    `The room so far (newest last):\n${lines || "(nothing yet)"}`,
    `The person's new message, which names nobody:\n${body}`,
    "Which bot is it for? Weigh whose job it is and who the person has been talking to: a short follow-up (yes, go ahead, do it) is for the bot whose question or offer it answers. Answer with exactly one @handle, or several only when the message plainly asks for work in several bots' areas. Nothing else.",
  ].join("\n\n");
}

/** The members a router's answer names, or null when it names none of them. */
export function parseRoute(text: string, members: Bot[]): Bot[] | null {
  const handles = mentionsIn(text);
  const byHandle = members.filter((b) => handles.includes(handleOf(b.name)));
  if (byHandle.length) return byHandle;
  const byName = members.filter((b) => new RegExp(`(?<![\\w@])${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i").test(text));
  return byName.length ? byName : null;
}

/** The model the router asks: Claude Code's smallest on the person's plan, else the key's own small one, else theirs. */
function routerModel(run: EngineRun): string {
  if (run.native) return run.model;
  return run.access.kind === "plan" ? "haiku" : run.access.smallModel || run.model;
}

/** Whether the person has an AI the router can ask right now; without one, lines go by the rules at once rather than wait. */
export function canRoute(userId: string): boolean {
  try {
    const run = engineRun(getAi(userId), userId);
    return Boolean(run.native) || boxConfig(userId) !== null;
  } catch {
    return false;
  }
}

async function ask(userId: string, speaker: Bot, threadId: string, prompt: string, signal: AbortSignal): Promise<string> {
  const run = engineRun(getAi(userId), userId);
  if (run.native) {
    const result = await nativeTurn({ access: run.native, model: routerModel(run), instructions: ROUTER_INSTRUCTIONS, prompt, tools: {}, maxSteps: 1, signal });
    return result.ok ? result.text : "";
  }
  const box = boxConfig(userId);
  if (!box) return "";
  // An agent of its own, closed after: the question never lands in a bot's session.
  const agentId = `${speaker.id}--route-${threadId}`;
  try {
    const result = await cliTurn({ box, agentId, botId: speaker.id, engine: run.engine, access: run.access, modelId: routerModel(run), maxTurns: 1, permission: "ask", instructions: ROUTER_INSTRUCTIONS, prompt, tools: {}, timeoutMs: ROUTE_TIMEOUT_MS, signal });
    return result.ok ? result.text : "";
  } finally {
    await closeAgent(box, agentId).catch(() => undefined);
  }
}

/**
 * Whom a person's room line that names nobody is for, judged by a one-turn call on the person's own
 * AI from the bots' jobs and the talk so far. Anything short of a clear answer in time (no AI set up,
 * an error, a timeout, a name that isn't in the room) falls back to the rules, `roomTargets`.
 * `before` is the room's messages ahead of it, oldest first (`roomBefore`).
 */
export async function routeLine(thread: Thread, message: Message, members: Bot[], bots: Bot[], before: Message[]): Promise<{ targets: Bot[]; routed: boolean }> {
  const byRules = () => roomTargets(message.body, members, before);
  const speaker = roomAnswerer(members);
  if (!speaker || members.length < 2) return { targets: byRules(), routed: false };
  const lines = transcriptLines(before.filter((m) => m.kind === "message").slice(-ROUTE_LINES), bots, null, ROUTE_LINE_CHARS);
  try {
    const answer = await ask(thread.userId, speaker, thread.id, routerPrompt(members, lines, message.body), AbortSignal.timeout(ROUTE_TIMEOUT_MS));
    const picked = parseRoute(answer, members);
    if (picked) return { targets: picked, routed: true };
  } catch (error) {
    console.warn(`[gond] couldn't route a line in ${thread.id}: ${error instanceof Error ? error.message : error}`);
  }
  return { targets: byRules(), routed: false };
}
