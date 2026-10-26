type Line = { author: string; kind: string; body: string };

/** What the person sent in a conversation, newest first and each once in a row: what Up and Down in the composer go through. */
export function sentHistory(messages: Line[]): string[] {
  const history: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    const body = m.body.trim();
    if (m.author !== "you" || m.kind !== "message" || !body || history.at(-1) === body) continue;
    history.push(body);
  }
  return history;
}

export type HistoryKey = {
  key: string;
  text: string;
  start: number;
  end: number;
  /** The entry the field shows, or null when it shows something else. */
  at: number | null;
  count: number;
};

/**
 * Where an arrow key takes the composer: an entry's index, -1 for the empty field it started from, or null to leave
 * the key to the field. Browsing starts only from an empty field and only moves while the caret sits on the first line
 * (Up) or the last (Down), so moving through a long message and typing never change.
 */
export function historyStep({ key, text, start, end, at, count }: HistoryKey): number | null {
  if (start !== end) return null;
  if (key === "ArrowUp") {
    if (at === null && text.trim()) return null;
    if (text.slice(0, start).includes("\n")) return null;
    const next = at === null ? 0 : at + 1;
    return next < count ? next : null;
  }
  if (key === "ArrowDown") {
    if (at === null || text.slice(end).includes("\n")) return null;
    return at - 1;
  }
  return null;
}
