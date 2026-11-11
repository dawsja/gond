import { useCallback, useRef, useState } from "react";
import { changeDraft, EMPTY_DRAFT, type DraftChange } from "@/lib/composer-draft";

/**
 * The composer's draft (`changeDraft`). `latest()` is the text as of the last change, which a handler
 * running before React draws that change (the app's "send" right behind its last "text") must read.
 */
export function useComposerDraft() {
  const latest = useRef(EMPTY_DRAFT);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const change = useCallback((next: DraftChange) => {
    latest.current = changeDraft(latest.current, next);
    setDraft(latest.current);
  }, []);
  const typed = useCallback((text: string) => change({ by: "app", text }), [change]);
  const set = useCallback((text: string | ((text: string) => string)) => change({ by: "page", text }), [change]);
  const current = useCallback(() => latest.current.text, []);
  return { text: draft.text, rev: draft.rev, latest: current, typed, set };
}
