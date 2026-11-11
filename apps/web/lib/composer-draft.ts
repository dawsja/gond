/**
 * The composer's text and how many times the page changed it itself. In the iPhone app the field is
 * the app's own: what the person types there arrives as an `app` change and never raises `rev`; every
 * change the page makes (a send, a mention, a dictation, a recalled or restored draft) raises it, and
 * that is the only signal the app takes the page's text on. Nothing compares texts to guess which side
 * made a change: an app echo and a page change can be the same string (an empty field most of all).
 */
export type Draft = { text: string; rev: number };

export type DraftChange = { by: "app"; text: string } | { by: "page"; text: string | ((text: string) => string) };

export const EMPTY_DRAFT: Draft = { text: "", rev: 0 };

export function changeDraft(draft: Draft, change: DraftChange): Draft {
  if (change.by === "app") return { text: change.text, rev: draft.rev };
  const text = typeof change.text === "function" ? change.text(draft.text) : change.text;
  return { text, rev: draft.rev + 1 };
}

/** What a failed send puts back: the unsent text, ahead of anything typed while it was on its way. */
export function unsentBack(current: string, unsent: string): string {
  return current.trim() ? `${unsent}\n${current}` : unsent;
}
