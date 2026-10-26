import type { Approval } from "@gond/shared";

export const WAITING_FOR_YOU = "Waiting for you";

/** Under the person's line no bot has read yet: that it isn't, and in a bot's chat, when it will be. */
export function notReadYet({ isRoom, botName, working }: { isRoom: boolean; botName: string | null; working: boolean }): string {
  return !isRoom && botName && working ? `Not read yet · ${botName} gets it after this job` : "Not read yet";
}

/** The bots in a conversation holding a card the person hasn't answered: their work line waits on the person, not on a step. */
export function botsWaitingOnYou(approvals: readonly Pick<Approval, "botId" | "threadId" | "status">[], threadId: string): Set<string> {
  return new Set(approvals.filter((a) => a.threadId === threadId && a.status === "pending").map((a) => a.botId));
}
