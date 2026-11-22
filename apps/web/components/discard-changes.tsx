"use client";

import { useState } from "react";
import { Confirm } from "@/components/confirm-dialog";

export function useDiscardChanges(dirty: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => (dirty ? setAsking(true) : close());
  const prompt = (
    <Confirm open={asking} onOpenChange={setAsking} title="Discard your changes?" description="What you changed here isn't saved yet." action="Discard" cancel="Keep editing" onConfirm={close} />
  );
  return { requestClose, prompt };
}
