import type { Bot, Thread } from "@gond/shared";
import { closeAgent, type BoxConfig } from "./box.ts";
import { allSecretValues } from "./data/secrets.ts";
import { getSummary, setSummary, unsummarized } from "./data/summaries.ts";
import { cliTurn } from "./driver.ts";
import type { EngineRun } from "./engines.ts";
import { nativeTurn } from "./native.ts";
import { createRedactor } from "./redact.ts";
import { clippedLines } from "./tools.ts";

// Folded in batches, not every turn: a summary costs a model call.
export const SUMMARY_BATCH = 20;
const SUMMARY_CHARS = 4000;
const SUMMARY_TIMEOUT_MS = 3 * 60_000;

export const SUMMARY_INSTRUCTIONS = "You keep the running summary of a conversation between a person and their bots in Gond. You only write the summary: you have no tools and do nothing else.";

export function summaryPrompt(previous: string | null, lines: string): string {
  return [
    `The summary so far:\n${previous?.trim() || "(none yet)"}`,
    `Older messages to fold in (oldest first):\n${lines}`,
    "Write the updated summary of everything above, for the bots to read before the recent messages: the decisions made, what is still open or promised, the person's rules and preferences, and facts that will matter later (names, numbers, addresses, links). Drop greetings, back-and-forth, and work that is finished and no longer matters. Use short bullet points under the headings Decisions, Open, Rules and preferences and Facts, leaving out a heading with nothing under it. At most 300 words. Answer with the summary only.",
  ].join("\n\n");
}

/** What the model wrote, as the summary to keep: trimmed, capped, secrets hidden. */
export function cleanSummary(text: string, secrets: string[] = allSecretValues()): string | null {
  const trimmed = createRedactor(secrets, Infinity)(text.trim());
  if (!trimmed) return null;
  return trimmed.length > SUMMARY_CHARS ? `${trimmed.slice(0, SUMMARY_CHARS).trimEnd()}…` : trimmed;
}

const holder = globalThis as typeof globalThis & { __gondSummarizing?: Set<string> };
const summarizing = () => (holder.__gondSummarizing ??= new Set());

/**
 * Folds what has dropped out of a conversation's recent window into its
 * summary once there is a batch of it, on the person's own AI. It runs after
 * a reply, in the background, one at a time per conversation; a failure
 * leaves the summary as it was and the next reply tries again.
 */
export async function summarizeThread(input: { box: BoxConfig | null; bot: Bot; thread: Thread; bots: Bot[]; run: EngineRun; window: number }): Promise<boolean> {
  const { box, bot, thread, bots, run, window } = input;
  if (summarizing().has(thread.id)) return false;
  const current = getSummary(thread.id);
  const older = unsummarized(thread.id, window, current?.through ?? null);
  if (older.length < SUMMARY_BATCH) return false;
  summarizing().add(thread.id);
  const signal = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
  const prompt = summaryPrompt(current?.summary ?? null, clippedLines(older, bots, bot));
  try {
    let text = "";
    if (run.native) {
      const result = await nativeTurn({ access: run.native, model: run.model, instructions: SUMMARY_INSTRUCTIONS, prompt, tools: {}, maxSteps: 1, signal });
      if (result.ok) text = result.text;
    } else if (box) {
      // An agent of its own, closed after: the summary never lands in the bot's own session.
      const agentId = `${bot.id}--sum-${thread.id}`;
      try {
        const result = await cliTurn({ box, agentId, botId: bot.id, engine: run.engine, access: run.access, modelId: run.model, maxTurns: 1, permission: "ask", instructions: SUMMARY_INSTRUCTIONS, prompt, tools: {}, timeoutMs: SUMMARY_TIMEOUT_MS, signal });
        if (result.ok) text = result.text;
      } finally {
        await closeAgent(box, agentId).catch(() => undefined);
      }
    }
    const summary = cleanSummary(text);
    if (!summary) return false;
    setSummary(thread.id, summary, older.at(-1)!.createdAt);
    return true;
  } catch (error) {
    console.warn(`[gond] couldn't summarize ${thread.id}: ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    summarizing().delete(thread.id);
  }
}
