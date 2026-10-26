// Messages a turn was answering when it was cut off (Gond restarting, the computer going away or
// updating) or when it failed, and what that turn had already done, so the turn that answers them
// again is told.
type Interrupted = { done: string[]; failed: boolean };
const holder = globalThis as typeof globalThis & { __gondInterrupted?: Map<string, Interrupted> };

// A failed turn's steps wait for a Try again that may never come, so only the latest are kept.
const KEPT = 500;

function interrupted(): Map<string, Interrupted> {
  return (holder.__gondInterrupted ??= new Map());
}

/** `failed`: the turn ended with a problem, and the person may ask for it again (Try again). */
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

/** What a re-run hears ahead of its prompt, once; null for a message nothing cut off. */
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
