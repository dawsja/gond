export type Draft = { text: string; rev: number };

export type DraftChange = { by: "app"; text: string } | { by: "page"; text: string | ((text: string) => string) };

export const EMPTY_DRAFT: Draft = { text: "", rev: 0 };

export function changeDraft(draft: Draft, change: DraftChange): Draft {
  if (change.by === "app") return { text: change.text, rev: draft.rev };
  const text = typeof change.text === "function" ? change.text(draft.text) : change.text;
  return { text, rev: draft.rev + 1 };
}

export function unsentBack(current: string, unsent: string): string {
  return current.trim() ? `${unsent}\n${current}` : unsent;
}
