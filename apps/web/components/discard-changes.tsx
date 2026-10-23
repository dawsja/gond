"use client";

import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

/**
 * For a dialog someone types a lot into: closing it with changes asks first, so a stray tap outside
 * or Escape doesn't throw the work away. `requestClose` goes where the dialog closes; render `prompt`.
 */
export function useDiscardChanges(dirty: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => (dirty ? setAsking(true) : close());
  const prompt = (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
          <AlertDialogDescription>What you changed here isn&apos;t saved yet.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={close}>
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { requestClose, prompt };
}
