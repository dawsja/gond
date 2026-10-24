"use client";

import { useState } from "react";
import { Confirm } from "@/components/confirm-dialog";

/**
 * For a dialog someone types a lot into: closing it with changes asks first, so a stray tap outside
 * or Escape doesn't throw the work away. `requestClose` goes where the dialog closes; render `prompt`.
 */
export function useDiscardChanges(dirty: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => (dirty ? setAsking(true) : close());
  const prompt = (
    <Confirm open={asking} onOpenChange={setAsking} title="Discard your changes?" description="What you changed here isn't saved yet." action="Discard" cancel="Keep editing" onConfirm={close} />
  );
  return { requestClose, prompt };
}
