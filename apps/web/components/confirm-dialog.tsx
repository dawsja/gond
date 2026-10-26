"use client";

import { useEffect, useRef } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/toast";
import { useHeld } from "@/hooks/use-held";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { askNative, useNativeUi } from "@/lib/native-ui";

type ConfirmProps = { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; action: string; cancel?: string; destructive?: boolean; onConfirm: () => unknown };

/** A yes or no, destructive unless said otherwise. `onConfirm` runs with the confirm still open: it closes once that's done, and stays with the reason if it fails. */
export function Confirm(props: ConfirmProps) {
  return useNativeUi() ? <NativeConfirm {...props} /> : <PageConfirm {...props} />;
}

function PageConfirm({ open, onOpenChange, title, description, action, cancel = "Cancel", destructive = true, onConfirm }: ConfirmProps) {
  const shownTitle = useHeld(title, open);
  const shownDescription = useHeld(description, open);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">{shownTitle}</AlertDialogTitle>
          <AlertDialogDescription>{shownDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onAction={async () => void (await onConfirm())}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The iPhone app's own alert; it closes on the tap, so the work runs after it and only a failure says so. */
function NativeConfirm({ open, onOpenChange, title, description, action, destructive = true, onConfirm }: ConfirmProps) {
  const asked = useRef(false);
  const close = useStableCallback(onOpenChange);
  const confirm = useStableCallback(onConfirm);
  useEffect(() => {
    if (!open) {
      asked.current = false;
      return;
    }
    if (asked.current) return;
    asked.current = true;
    void askNative({ kind: "confirm", title, message: description, action, destructive }).then(async (yes) => {
      if (yes) {
        try {
          await confirm();
        } catch (failure) {
          toast.add({ type: "error", title: failure instanceof Error && failure.message ? failure.message : "That didn't work. Try again." });
        }
      }
      close(false);
    });
  }, [open, title, description, action, destructive, close, confirm]);
  return null;
}
