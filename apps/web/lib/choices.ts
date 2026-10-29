import type { Message } from "@gond/shared";

/** How the person answered a bot's message: the options they picked by replying to it, and the line that closed its questions, if one did. */
export type ChoiceAnswer = { picks: string[]; closedBy: string | null };

// A pick in a room names the bot it answers ("@patch Run a sweep"); the option is what's left.
const ADDRESSED = /^(?:\s*@[\w-]+[\s,]*)+/;

function optionsIn(body: string): Set<string> {
  return new Set([...body.matchAll(/::choices\[([^\]]*)\]/g)].flatMap((row) => row[1]!.split("|").map((option) => option.trim().toLowerCase())));
}

/**
 * What the person answered each bot message's choices with. A tap is sent as a reply to the message
 * that asked, and a reply answers only the message it quotes, so two questions open at once are
 * answered one at a time. Anything else they say closes every question above it, and so does a reply
 * that is none of the options.
 */
export function choiceAnswers(messages: readonly Pick<Message, "id" | "author" | "kind" | "body" | "replyTo">[]): Map<string, ChoiceAnswer> {
  const answers = new Map<string, ChoiceAnswer>();
  const options = new Map<string, Set<string>>();
  let open: ChoiceAnswer[] = [];
  for (const m of messages) {
    if (m.author !== "you" || m.kind !== "message") {
      const answer: ChoiceAnswer = { picks: [], closedBy: null };
      answers.set(m.id, answer);
      if (m.body.includes("::choices")) options.set(m.id, optionsIn(m.body));
      open.push(answer);
      continue;
    }
    const said = m.body.replace(ADDRESSED, "").trim();
    const quoted = m.replyTo ? answers.get(m.replyTo.id) : undefined;
    if (quoted && m.replyTo) {
      if (options.get(m.replyTo.id)?.has(said.toLowerCase())) quoted.picks.push(said);
      else if (quoted.closedBy === null) quoted.closedBy = said;
      continue;
    }
    for (const answer of open) if (answer.closedBy === null) answer.closedBy = said;
    open = [];
  }
  return answers;
}

// A line is memoized, so its answer crosses as strings that compare equal while nothing changed.
export const joinPicks = (answer: ChoiceAnswer | undefined) => answer?.picks.join("\n") ?? "";
export const splitPicks = (picks: string) => (picks ? picks.split("\n") : []);
