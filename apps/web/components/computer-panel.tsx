"use client";

import { BOX_UPDATE_PHASE_LABELS } from "@gond/shared";
import { BoxDesktop } from "@/components/hq/desktop-screen";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";

export function changeDesktopControl(holder: "person" | "free") {
  void post("/api/box/desktop/control", { holder }).catch((failure: unknown) => {
    toast.add({ type: "error", title: failure instanceof Error && failure.message ? failure.message : "Couldn't change who has control." });
  });
}

export function ComputerPanel({ onClose }: { onClose: () => void }) {
  const { boxUpdating, boxUpdate, desktop } = useStore();

  if (boxUpdating) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>The computer is updating</DialogTitle>
            <DialogDescription>{boxUpdate ? BOX_UPDATE_PHASE_LABELS[boxUpdate.phase] : "Please wait"}. The desktop opens again when it&apos;s back; follow along under Settings.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="fixed inset-0 z-[70]">
      <BoxDesktop onClose={onClose} control={desktop?.control ?? "free"} onControlChange={changeDesktopControl} />
    </div>
  );
}
