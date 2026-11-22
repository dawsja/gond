import { joinNames, type Message } from "@gond/shared";

export type ChoiceAnswer = { picks: string[]; closedBy: string | null };

// A pick in a room names the bot it answers ("@patch Run a sweep"); the option is what's left.
const ADDRESSED = /^(?:\s*@[\w-]+[\s,]*)+/;
// A card of questions is answered as a whole, never by one of its rows.
const QUESTIONS = /^[ \t]*:::questions\b[\s\S]*?^[ \t]*:::[ \t]*$/gm;

type Row = { options: string[]; multi: boolean };

function rowsIn(body: string): Row[] {
  return [...body.replace(QUESTIONS, "").matchAll(/::choices\[([^\]]*)\](\{[^}\n]*\})?/g)].map((row) => ({
    options: row[1]!.split("|").map((option) => option.trim()).filter(Boolean),
    multi: /\bmulti\b/.test(row[2] ?? ""),
  }));
}

/**
 * The options a row's answer is made of, in the order they were said, or null when it is anything
 * else: one option, or for a row taking several, its options as `joinNames` lists them ("Eggs, Milk and Bread").
 */
export function pickedIn(said: string, options: readonly string[], multi: boolean): string[] | null {
  const text = said.trim().toLowerCase();
  const lowered = options.map((option) => option.toLowerCase());
  if (!multi) {
    const at = lowered.indexOf(text);
    return at >= 0 ? [options[at]!] : null;
  }
  const walk = (from: number, used: readonly number[]): number[] | null => {
    for (const [index, option] of lowered.entries()) {
      if (used.includes(index) || !text.startsWith(option, from)) continue;
      const end = from + option.length;
      if (end === text.length) return [index];
      for (const between of [", ", " and "]) {
        if (!text.startsWith(between, end)) continue;
        const rest = walk(end + between.length, [...used, index]);
        if (rest) return [index, ...rest];
      }
    }
    return null;
  };
  const found = text ? walk(0, []) : null;
  return found ? found.map((index) => options[index]!) : null;
}

/** The options a reply names among its own words, for showing which were picked when they added an answer of their own. */
export function namedIn(said: string, options: readonly string[]): string[] {
  const text = said.trim().toLowerCase();
  return options.filter((option) => {
    const word = option.toLowerCase();
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
      const before = text.slice(0, at);
      const after = text.slice(at + word.length);
      if ((at === 0 || before.endsWith(", ") || before.endsWith(" and ")) && (after === "" || after.startsWith(", ") || after.startsWith(" and "))) return true;
    }
    return false;
  });
}

export function answerOf(options: readonly string[], picked: readonly string[], own: string, multi: boolean): string {
  const words = own.trim();
  if (!multi) return words || picked[0] || "";
  return joinNames([...options.filter((option) => picked.includes(option)), ...(words ? [words] : [])]);
}

export function answerLine(question: string, answer: string): string {
  return /[?:.!]$/.test(question) ? `${question} ${answer}` : `${question}: ${answer}`;
}

export function questionAnswers(questions: readonly string[], said: string | null): (string | null)[] {
  const lines = (said ?? "").replace(ADDRESSED, "").split("\n").map((line) => line.trim());
  return questions.map((question) => {
    const line = lines.find((candidate) => candidate.toLowerCase().startsWith(question.toLowerCase()));
    return line?.slice(question.length).replace(/^[\s:]+/, "").trim() || null;
  });
}

/**
 * What the person answered each bot message's choices with. A tap is sent as a reply to the message
 * that asked, and a reply answers only the message it quotes, so two questions open at once are
 * answered one at a time. Anything else they say closes every question above it, and so does a reply
 * that is none of the options.
 */
export function choiceAnswers(messages: readonly Pick<Message, "id" | "author" | "kind" | "body" | "replyTo">[]): Map<string, ChoiceAnswer> {
  const answers = new Map<string, ChoiceAnswer>();
  const rows = new Map<string, Row[]>();
  let open: ChoiceAnswer[] = [];
  for (const m of messages) {
    if (m.author !== "you" || m.kind !== "message") {
      const answer: ChoiceAnswer = { picks: [], closedBy: null };
      answers.set(m.id, answer);
      if (m.body.includes("::choices")) rows.set(m.id, rowsIn(m.body));
      open.push(answer);
      continue;
    }
    const said = m.body.replace(ADDRESSED, "").trim();
    const quoted = m.replyTo ? answers.get(m.replyTo.id) : undefined;
    if (quoted && m.replyTo) {
      if (rows.get(m.replyTo.id)?.some((row) => pickedIn(said, row.options, row.multi))) quoted.picks.push(said);
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
