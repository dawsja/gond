import { AI_SETUP_CARD } from "@gond/shared";
import { getAi } from "./data/ai.ts";
import { getBot } from "./data/bots.ts";
import { cardHolders, cardsOf, dropMessage, failuresAnswering, getMessage, getThread, recentMessages, unsteer } from "./data/threads.ts";
import { EngineSetupError, engineRun } from "./engines.ts";
import { subscribe } from "./events.ts";
import { activeTurns } from "./responder.ts";
import { claudeSignedIn } from "./status.ts";
import { greet } from "./templates.ts";

// Settings → AI saves in a few steps; the check waits for them to settle.
const SETTLE_MS = 1_500;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether the person's bots can run now: the engine's key or plan is there, and Claude Code on a plan is signed in. */
export async function aiWorks(userId: string): Promise<boolean> {
  try {
    const run = engineRun(getAi(userId), userId);
    if (run.native || run.access.kind === "api") return true;
  } catch (error) {
    if (error instanceof EngineSetupError) return false;
    throw error;
  }
  return claudeSignedIn(userId);
}

/**
 * Once the person's AI works, the "Your bots don't have an AI yet" cards go and what they held up
 * runs: the message a card was waiting on is answered, and a bot that never got to greet them does.
 */
export async function settleSetupCards(userId: string): Promise<void> {
  const cards = cardsOf(userId, AI_SETUP_CARD);
  if (!cards.length || !(await aiWorks(userId))) return;
  const answering = new Set([...activeTurns().values()].map((turn) => turn.messageId));
  for (const card of cards) {
    const waiting = card.answering ? getMessage(card.answering) : null;
    if (waiting) {
      if (answering.has(waiting.id)) continue;
      for (const failure of failuresAnswering(waiting, AI_SETUP_CARD)) dropMessage(failure.id);
      unsteer(waiting.id);
      continue;
    }
    dropMessage(card.id);
    const bot = getBot(card.author);
    const thread = getThread(card.threadId);
    if (bot && thread?.kind === "bot" && thread.botId === bot.id && !recentMessages(thread.id, 50).some((m) => m.author === bot.id && m.kind === "message")) greet(bot);
  }
}

function soon(userId: string) {
  clearTimeout(pending.get(userId));
  const timer = setTimeout(() => {
    pending.delete(userId);
    void settleSetupCards(userId).catch((error: unknown) => console.warn("[gond] couldn't clear the AI setup cards:", error));
  }, SETTLE_MS);
  if (typeof timer.unref === "function") timer.unref();
  pending.set(userId, timer);
}

/** Checks whenever someone's AI settings change, and once at start for an AI set up while Gond was down. */
export function watchSetupCards(): () => void {
  for (const userId of cardHolders(AI_SETUP_CARD)) soon(userId);
  return subscribe((event) => {
    if (event.topic === "ai" && event.userId) soon(event.userId);
  });
}
