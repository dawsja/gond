import { handleOf, isRemoteAuthor, REMOTE_AUTHOR, type Message, type SpaceMember, type ThreadSpace } from "@gond/shared";
import type { Mentionable } from "@/components/slash-menu";

/** Who a line from another Gond is by, and which Gond: the API writes them as `remote:<key's first 12>:<member>`. */
export function remoteMember(space: ThreadSpace | null | undefined, author: string): (SpaceMember & { gondName: string }) | null {
  if (!space || !author.startsWith(REMOTE_AUTHOR)) return null;
  const [prefix, ...rest] = author.slice(REMOTE_AUTHOR.length).split(":");
  const memberId = rest.join(":");
  const member = space.members.find((m) => m.id === memberId && m.gond.startsWith(prefix ?? ""));
  const gond = space.gonds.find((g) => g.key.startsWith(prefix ?? ""));
  if (member) return { ...member, gondName: gond?.name ?? "Another Gond" };
  return gond ? { id: memberId, kind: "person", name: "Someone", color: null, gond: gond.key, gondName: gond.name } : null;
}

/**
 * The lines whose `::choices` are shown but can't be tapped: one from another Gond, whose choices are
 * for its own person, and a bot's answer to one, since a tap sends the option as the person's own line
 * and would wake a bot with every tool for a request a stranger shaped. In a space, an answer to a line
 * that isn't loaded counts as one.
 */
export function inertChoices(messages: Pick<Message, "id" | "author" | "answering">[], inSpace: boolean): Set<string> {
  const authors = new Map(messages.map((m) => [m.id, m.author]));
  const inert = new Set<string>();
  for (const m of messages) {
    if (isRemoteAuthor(m.author)) inert.add(m.id);
    else if (m.author !== "you" && m.answering) {
      const asked = authors.get(m.answering);
      if (asked === undefined ? inSpace : isRemoteAuthor(asked)) inert.add(m.id);
    }
  }
  return inert;
}

/** The people and bots on the other Gonds of an open space, for an @ to name; none while it isn't open. */
export function spaceMentionables(space: ThreadSpace | null | undefined): Mentionable[] {
  if (!space || space.status !== "active") return [];
  return space.members.map((m) => ({
    id: `${m.gond}:${m.id}`,
    name: m.name,
    handle: handleOf(m.name),
    detail: space.gonds.find((g) => g.key === m.gond)?.name ?? "Another Gond",
    face: m.kind === "bot" ? { name: m.name, title: "", color: m.color ?? "#8a8a8a", expression: "happy", primary: false } : null,
  }));
}

/** "Ada's Gond", "Ada's Gond and Cy's Gond", "Ada's Gond and 2 more". */
function gondNames(space: ThreadSpace): string {
  const list = space.gonds.map((g) => g.name);
  if (list.length <= 2) return list.join(" and ");
  return `${list[0]} and ${list.length - 1} more`;
}

/** The line under a space's name: where it stands, or who it's with. */
export function spaceSubtitle(space: ThreadSpace): string {
  if (space.status === "joining") return "Waiting to be let in";
  if (space.status === "left") return "You left";
  if (space.status === "closed") return "Closed";
  return space.gonds.length ? `With ${gondNames(space)}` : "Waiting for someone to join";
}
