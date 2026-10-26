import { AI_SETUP_CARD, type Message } from "@gond/shared";

/** What onboarding sends the primary bot, to see the AI answer before the person leaves. */
export const HELLO = "Hi! What can you do?";

/** How the hello went, read from the conversation: the bot's answer, the line saying it couldn't, or neither yet. */
export function helloOutcome(messages: Message[], sent: Pick<Message, "id" | "createdAt">, botId: string): { replies: Message[]; failure: Message | null } {
  const at = messages.findIndex((m) => m.id === sent.id);
  const after = at >= 0 ? messages.slice(at + 1) : messages.filter((m) => m.id !== sent.id && m.createdAt >= sent.createdAt);
  const replies = after.filter((m) => m.kind === "message" && m.author === botId && !m.fromThreadId);
  const failure = replies.length ? null : (after.findLast((m) => (m.kind === "signin" && m.approvalId === AI_SETUP_CARD) || (m.kind === "event" && m.answering === sent.id)) ?? null);
  return { replies, failure };
}
