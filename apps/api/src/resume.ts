// Messages a turn was answering when it was cut off (Gond restarting, the computer going away or
// updating), and what that turn had already done, so the turn that answers them again is told.
const holder = globalThis as typeof globalThis & { __gondInterrupted?: Map<string, string[]> };

function interrupted(): Map<string, string[]> {
  return (holder.__gondInterrupted ??= new Map());
}

export function noteInterrupted(messageId: string, done: string[] = []): void {
  interrupted().set(messageId, [...(interrupted().get(messageId) ?? []), ...done].slice(-20));
}

export function wasInterrupted(messageId: string): boolean {
  return interrupted().has(messageId);
}

/** What a re-run hears ahead of its prompt, once; null for a message nothing cut off. */
export function takeInterrupted(messageId: string): string | null {
  const done = interrupted().get(messageId);
  if (!done) return null;
  interrupted().delete(messageId);
  return [
    "Note from Gond: you were already answering this when you were cut off (Gond or the computer restarted), so you are answering it again.",
    done.length ? `These steps ran before the cut:\n${done.map((step) => `- ${step}`).join("\n")}` : "What ran before the cut isn't known.",
    "Check where it got to before you redo anything (the conversation, your files, the screen), and never repeat an action with an effect, like sending a message or an email, placing an order or changing a server, that already happened. Then carry on from there.",
  ].join("\n");
}
