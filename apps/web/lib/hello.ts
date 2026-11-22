import { AI_SETUP_CARD, type Message } from "@gond/shared";

export const HELLO = "Hi! What can you do?";

export function helloOutcome(messages: Message[], sent: Pick<Message, "id" | "createdAt">, botId: string): { replies: Message[]; failure: Message | null } {
  const at = messages.findIndex((m) => m.id === sent.id);
  const after = at >= 0 ? messages.slice(at + 1) : messages.filter((m) => m.id !== sent.id && m.createdAt >= sent.createdAt);
  const replies = after.filter((m) => m.kind === "message" && m.author === botId && !m.fromThreadId);
  const failure = replies.length ? null : (after.findLast((m) => (m.kind === "signin" && m.approvalId === AI_SETUP_CARD) || (m.kind === "event" && m.answering === sent.id)) ?? null);
  return { replies, failure };
}
