import { replyLine, type Bot, type Message, type Thread } from "@gond/shared";
import { readBoxFile, type BoxConfig } from "./box.ts";
import { recentMessages } from "./data/threads.ts";
import { LEGACY_TEAM_MEMORY_PATH, memoryPath, teamMemoryPath } from "./memory.ts";
import { ownerIsAdmin } from "./toolkits.ts";

export async function loadMemory(box: BoxConfig, botId: string): Promise<string | null> {
  return readBoxFile(box, memoryPath(botId))
    .then((file) => file.content ?? null)
    .catch(() => null);
}

export async function loadTeamMemory(box: BoxConfig, userId: string): Promise<string | null> {
  const read = (path: string) =>
    readBoxFile(box, path)
      .then((file) => file.content ?? null)
      .catch(() => null);
  const own = await read(teamMemoryPath(userId));
  if (own !== null || !ownerIsAdmin(userId)) return own;
  return read(LEGACY_TEAM_MEMORY_PATH);
}

/**
 * The last `count` lines of a conversation up to `upTo`. With `after`, only
 * those newer than it and none of `self`'s own (what a resumed session
 * hasn't seen), and none a running turn already took as a steer.
 */
export function transcript(thread: Thread, bots: Bot[], self: Bot, upTo: Message, count = 30, options: { after?: string | null } = {}): string {
  const after = options.after ?? null;
  const lines = recentMessages(thread.id, count).filter((m) => m.createdAt <= upTo.createdAt && (!after || (m.createdAt > after && m.author !== self.id && (!m.steered || m.id === upTo.id))));
  return transcriptLines(lines, bots, self);
}

const LINE_CHARS = 1500;

export function transcriptLines(lines: Message[], bots: Bot[], self: Bot, clipAt = Infinity): string {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  return lines
    .map((m) => {
      const nameOf = (author: string) => (author === "you" ? "Person" : author === "routine" ? "Routine" : author === "system" ? "Gond" : (names.get(author) ?? author) + (author === self.id ? " (you)" : ""));
      const via = m.fromThreadId && names.has(m.author) && m.author !== self.id ? " (teammate, by message)" : "";
      const files = m.attachments.length ? ` [attached: ${m.attachments.map((a) => a.name).join(", ")}]` : "";
      const reactions = m.reactions.length ? ` [reactions: ${m.reactions.map((r) => `${nameOf(r.author)} ${r.emoji}`).join(", ")}]` : "";
      const body = m.body.length > clipAt ? `${m.body.slice(0, clipAt)}…` : m.body;
      return `${nameOf(m.author)}${via}: ${replyLine(m.replyTo, nameOf)}${m.kind === "approval" ? `(asked for approval: ${body})` : m.kind === "signin" ? `(posted a sign-in card: ${body})` : body}${files}${reactions}`;
    })
    .join("\n");
}

/** For a summary, where a long table or log needs only its gist. */
export function clippedLines(lines: Message[], bots: Bot[], self: Bot): string {
  return transcriptLines(lines, bots, self, LINE_CHARS);
}

