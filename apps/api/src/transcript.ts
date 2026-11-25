import { isPaused, replyLine, type Bot, type Message, type Thread } from "@gond/shared";
import { getApproval } from "./data/approvals.ts";
import { recentMessages } from "./data/threads.ts";

export function transcript(thread: Thread, bots: Bot[], self: Bot, upTo: Message, count = 30, options: { after?: string | null } = {}): string {
  const after = options.after ?? null;
  const lines = recentMessages(thread.id, count).filter((m) => m.createdAt <= upTo.createdAt && (!after || (m.createdAt > after && m.author !== self.id && (!m.steered || m.id === upTo.id))));
  return transcriptLines(lines, bots, self);
}

const LINE_CHARS = 1500;

export function transcriptLines(lines: Message[], bots: Bot[], self: Pick<Bot, "id"> | null, clipAt = Infinity): string {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  return lines
    .map((m) => {
      const nameOf = (author: string) => authorName(author, m.threadId, names, self?.id);
      const via = m.fromThreadId && names.has(m.author) && m.author !== self?.id ? (m.note === "action" ? " (teammate, action for you)" : m.note === "info" ? " (teammate, for your information)" : " (teammate, by message)") : "";
      const files = m.attachments.length ? ` [attached: ${m.attachments.map((a) => (a.removed ? `${a.name} (removed since, to save space)` : a.name)).join(", ")}]` : "";
      const reactions = m.reactions.length ? ` [reactions: ${m.reactions.map((r) => `${nameOf(r.author)} ${r.emoji}`).join(", ")}]` : "";
      const body = m.body.length > clipAt ? `${m.body.slice(0, clipAt)}…` : m.body;
      return `${nameOf(m.author)}${via}: ${replyLine(m.replyTo, nameOf)}${m.kind === "approval" ? `(asked for approval: ${body}${approvalEnding(m)})` : m.kind === "signin" ? `(posted a sign-in card: ${body})` : m.kind === "teach" ? `(posted a Show me how card: ${body})` : m.kind === "control" ? "(posted a Take Control card)" : body}${files}${reactions}`;
    })
    .join("\n");
}

export function authorName(author: string, _threadId: string, names: Map<string, string>, selfId?: string): string {
  if (author === "you") return "Person";
  if (author === "routine") return "Routine";
  if (author === "system") return "Gond";
  return (names.get(author) ?? author) + (author === selfId ? " (you)" : "");
}

function approvalEnding(m: Message): string {
  const card = m.approvalId ? getApproval(m.approvalId) : null;
  const status = card?.status;
  if (isPaused(card)) return "; nobody answered in time, so that work is paused: if your person answers it, Gond tells you and you carry on";
  return status === "allowed" ? "; your person said yes" : status === "denied" ? "; your person said no" : status === "expired" ? "; nobody answered in time" : status === "pending" ? "; waiting for your person" : "";
}

/** For a summary, where a long table or log needs only its gist. */
export function clippedLines(lines: Message[], bots: Bot[], self: Bot): string {
  return transcriptLines(lines, bots, self, LINE_CHARS);
}

