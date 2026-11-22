import type { Approval } from "@gond/shared";

export const WAITING_FOR_YOU = "Waiting for you";

export function notReadYet({ isRoom, botName, working }: { isRoom: boolean; botName: string | null; working: boolean }): string {
  return !isRoom && botName && working ? `Not read yet · ${botName} gets it after this job` : "Not read yet";
}

export function botsWaitingOnYou(approvals: readonly Pick<Approval, "botId" | "threadId" | "status">[], threadId: string): Set<string> {
  return new Set(approvals.filter((a) => a.threadId === threadId && a.status === "pending").map((a) => a.botId));
}
