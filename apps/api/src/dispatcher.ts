import { getBot } from "./data/bots.ts";
import { claimDueFollowUps } from "./data/follow-ups.ts";
import { claimDueRoutines, recordRoutineRun, routinePrompt } from "./data/routines.ts";
import { runDueCheckIns } from "./check-ins.ts";
import { TURNS_PER_PERSON } from "./config.ts";
import { claimPendingMessages, postMessage, releaseClaim } from "./data/threads.ts";
import { randomString } from "./ids.ts";
import { activeTurns, answerMessage, computerAway } from "./responder.ts";
import { chaseStalledDelegations } from "./nudges.ts";
import { expireTeachingFrames } from "./data/teachings.ts";
import { isUpdating } from "./updater.ts";
import { subscribe } from "./events.ts";

type State = { timer: ReturnType<typeof setInterval> | null; owner: string; ticking: boolean; lastChase: number; woken: boolean };
const holder = globalThis as typeof globalThis & { __gondDispatcher?: State };

function state(): State {
  return (holder.__gondDispatcher ??= { timer: null, owner: randomString(8), ticking: false, lastChase: 0, woken: false });
}

export const TICK_MS = 2_000;

export function startDispatcher(options: { intervalMs?: number } = {}) {
  const current = state();
  if (current.timer) return;
  current.timer = setInterval(() => void tick(), options.intervalMs ?? TICK_MS);
  // A new message, or a bot coming free, is picked up at once; the interval is only the fallback.
  subscribe((event) => {
    if (event.topic === "thread" || (event.topic === "activity" && event.line === null)) wake();
  });
  console.info("[gond] Dispatcher started");
}

/** One tick on the next turn of the event loop, however many ask for it before then. */
export function wake() {
  const current = state();
  if (current.woken) return;
  current.woken = true;
  setTimeout(() => {
    current.woken = false;
    void tick();
  }, 0);
}

export function runDueRoutines(at = new Date()) {
  for (const routine of claimDueRoutines(at)) {
    const bot = getBot(routine.botId);
    if (!bot || bot.hidden) continue;
    const posted = postMessage({ threadId: bot.threadId, author: "routine", body: routinePrompt(routine) });
    recordRoutineRun(routine.id, posted.id);
  }
}

export function runDueFollowUps(at = new Date()) {
  for (const followUp of claimDueFollowUps(at)) {
    const bot = getBot(followUp.botId);
    if (!bot || bot.hidden) continue;
    postMessage({ threadId: followUp.threadId, author: "system", kind: "prompt", body: followUpPrompt(followUp.note, followUp.createdAt) });
  }
}

export function followUpPrompt(note: string, setAt: string): string {
  return `The follow-up you set at ${setAt} is due: ${note}\n\nSee where it stands (list_handoffs and read_conversation tell you what your teammates did) and carry the work on. If you still have to wait, set another follow_up; if it's finished, tell the person.`;
}

export async function tick() {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    runDueRoutines();
    runDueFollowUps();
    if (Date.now() - current.lastChase > 60_000) {
      current.lastChase = Date.now();
      chaseStalledDelegations();
      expireTeachingFrames();
      if (!isUpdating() && !computerAway()) runDueCheckIns();
    }

    if (isUpdating() || computerAway()) return;
    const busy = new Map<string, number>();
    for (const turn of activeTurns().values()) busy.set(turn.userId, (busy.get(turn.userId) ?? 0) + 1);
    const messages = claimPendingMessages(current.owner, (userId) => TURNS_PER_PERSON - (busy.get(userId) ?? 0));
    for (const message of messages) {
      void answerMessage(message).catch((error: unknown) => {
        console.error(`[gond] answering ${message.id} failed:`, error);
        releaseClaim(message.id);
      });
    }
  } catch (error) {
    console.error("[gond] dispatcher tick failed:", error);
  } finally {
    current.ticking = false;
  }
}
