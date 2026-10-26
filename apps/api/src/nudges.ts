import { env } from "./config.ts";
import { getBot } from "./data/bots.ts";
import { listOpenDelegations, markEscalated, markNudged, openChildren } from "./data/delegations.ts";
import { getThread, postMessage } from "./data/threads.ts";
import { isBusy } from "./responder.ts";

export function nudgeAfterMs(): number {
  return Math.max(5, Number(env("NUDGE_MINUTES") ?? 120) || 120) * 60_000;
}

export function chaseStalledDelegations(at = Date.now()): { nudged: number; escalated: number } {
  let nudged = 0;
  let escalated = 0;
  const wait = nudgeAfterMs();
  for (const delegation of listOpenDelegations()) {
    const from = getBot(delegation.fromBotId);
    const to = getBot(delegation.toBotId);
    if (!from || !to || to.hidden) continue;

    if (isBusy(to.id, delegation.toThreadId)) continue;

    if (openChildren(delegation.id) > 0) continue;
    const age = at - Date.parse(delegation.createdAt);
    if (!delegation.nudgedAt && age >= wait) {
      postMessage({
        threadId: delegation.toThreadId,
        author: from.id,
        body: `Checking in on the task I handed you ${Math.round(age / 3_600_000)}h ago: "${delegation.brief.slice(0, 240)}". Where does it stand? If something blocks you, say what you need.`,
        fromThreadId: delegation.fromThreadId,
        depth: 1,
      });
      markNudged(delegation.id);
      nudged += 1;
      continue;
    }
    if (delegation.nudgedAt && !delegation.escalatedAt && at - Date.parse(delegation.nudgedAt) >= wait) {
      const home = getThread(delegation.fromThreadId);
      if (home) {
        postMessage({
          threadId: home.id,
          author: "system",
          kind: "event",
          body: `${to.name} hasn't answered the task ${from.name} handed over (${delegation.brief.slice(0, 120)}…) after a nudge. It may need a clearer brief, or the person's help.`,
          answered: true,
        });
      }
      markEscalated(delegation.id);
      escalated += 1;
    }
  }
  return { nudged, escalated };
}
