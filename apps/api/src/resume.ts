type Interrupted = { done: string[]; failed: boolean };
const holder = globalThis as typeof globalThis & { __gondInterrupted?: Map<string, Interrupted> };

// A failed turn's steps wait for a Try again that may never come, so only the latest are kept.
const KEPT = 500;

function interrupted(): Map<string, Interrupted> {
  return (holder.__gondInterrupted ??= new Map());
}

export function noteInterrupted(messageId: string, done: string[] = [], failed = false): void {
  const map = interrupted();
  const had = map.get(messageId);
  map.delete(messageId);
  map.set(messageId, { done: [...(had?.done ?? []), ...done].slice(-20), failed });
  while (map.size > KEPT) map.delete(map.keys().next().value!);
}

export function wasInterrupted(messageId: string): boolean {
  return interrupted().has(messageId);
}

export function takeInterrupted(messageId: string): string | null {
  const note = interrupted().get(messageId);
  if (!note) return null;
  interrupted().delete(messageId);
  const { done, failed } = note;
  const ran = failed ? "These steps ran before it went wrong" : "These steps ran before the cut";
  return [
    failed
      ? "Note from Gond: your last try at answering this ended with a problem, and the person asked you to try again."
      : "Note from Gond: you were already answering this when you were cut off (Gond or the computer restarted), so you are answering it again.",
    done.length ? `${ran}:\n${done.map((step) => `- ${step}`).join("\n")}` : failed ? "No steps had run." : "What ran before the cut isn't known.",
    "Check where it got to before you redo anything (the conversation, your files, the screen), and never repeat an action with an effect, like sending a message or an email, placing an order or changing a server, that already happened. Then carry on from there.",
  ].join("\n");
}

type LateAnswer = {
  card: string;
  tool: string;
  answer: "yes" | "always" | "send" | "no" | { changes: string };
  input: Record<string, unknown>;
  edited: boolean;
  working: string | null;
  done: readonly string[];
};

// The exact call goes in only while it is short enough to copy; a longer one the bot makes again itself.
const EXACT_CALL_CHARS = 4_000;
const EDITED_CALL_CHARS = 24_000;

export function lateAnswerText(late: LateAnswer): string {
  const { answer, tool } = late;
  const said = answer === "yes" ? "yes" : answer === "always" ? "yes, and yes from now on to this kind of action" : answer === "send" ? "yes, and to send it now instead of saving it as a draft" : answer === "no" ? "no" : "not like this: they want changes";
  const call = JSON.stringify(late.input);
  const exact = call.length <= (late.edited ? EDITED_CALL_CHARS : EXACT_CALL_CHARS) ? ` with exactly this input: ${call}` : " with the same input as before";
  const next =
    typeof answer === "object"
      ? `They want changes first: "${answer.changes}". Make them and call ${tool} again with the new version; its card shows them what you changed, so don't write it out in your answer.`
      : answer === "no"
        ? "They said no, so don't do it. Finish whatever part of the work doesn't need it; otherwise tell them in a line what you'd need instead."
        : tool === "ask_approval"
          ? "Then go ahead with what you asked, if it still makes sense now. If anything about it changed since (a price, who it goes to, what it would do), ask again with ask_approval for what is true now. Then finish the work and tell them how it went."
          : tool === "computer"
            ? "Then carry on with it on the screen, if it still makes sense now: take a screenshot first, since the screen may have changed. Your screen steps in this reply go through without a new card. Then finish the work and tell them how it went."
            : [
              late.edited ? `The person changed it on the card before saying yes, so their version is the one to use: call ${tool} again${exact}.` : `Then do what the card asked, if it still makes sense now: call ${tool} again${exact}.`,
              answer === "send" ? "Gond then sends it straight away, as they asked." : "",
              "That one call goes through without a new card. If anything about it changed since (a price, who it goes to, what it would do), call it with what is true now instead, and a new card goes up for the person. Then finish the work and tell them how it went.",
            ]
              .filter(Boolean)
              .join(" ");
  return [
    `Note from Gond: earlier you stopped at a card nobody answered in time, "${late.card}", while you were working on ${late.working ?? "something for the person"}. They have answered it now: ${said}.`,
    late.done.length ? `These steps ran before the card:\n${late.done.map((step) => `- ${step}`).join("\n")}` : "No steps had run before the card.",
    "Time has passed, so check where things stand before you do anything (the conversation, your files, the screen, the app), and never repeat a step with an effect that already happened, like sending a message or an email, placing an order or changing a server.",
    next,
  ].join("\n\n");
}
