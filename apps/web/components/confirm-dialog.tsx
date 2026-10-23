"use client";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useHeld } from "@/hooks/use-held";

/** A destructive yes or no. `onConfirm` runs with the confirm still open: it closes once that's done, and stays with the reason if it fails. */
export function Confirm({ open, onOpenChange, title, description, action, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; action: string; onConfirm: () => Promise<unknown> }) {
  const shownTitle = useHeld(title, open);
  const shownDescription = useHeld(description, open);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{shownTitle}</AlertDialogTitle>
          <AlertDialogDescription>{shownDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onAction={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
