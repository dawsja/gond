"use client";

import { BOX_UPDATE_PHASE_LABELS, screenOf } from "@gond/shared";
import { screenUrl } from "@/components/hq/box-desktop";
import { BoxDesktop } from "@/components/hq/desktop-screen";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";

export function changeDesktopControl(botId: string, holder: "person" | "free") {
  void post(`${screenUrl(botId)}/control`, { holder }).catch((failure: unknown) => {
    toast.add({ type: "error", title: failure instanceof Error && failure.message ? failure.message : "Couldn't change who has control." });
  });
}

/** A bot's computer, the primary bot's when none is named. */
export function ComputerPanel({ botId, onClose }: { botId: string | null; onClose: () => void }) {
  const { boxUpdating, boxUpdate, desktop, bots, botById } = useStore();
  const bot = (botId ? botById(botId) : null) ?? bots.find((b) => b.primary && !b.hidden) ?? null;

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

  if (!bot) return null;
  return (
    <div className="fixed inset-0 z-[70]">
      <BoxDesktop bot={bot} onClose={onClose} control={screenOf(desktop, bot.id).control} onControlChange={(holder) => changeDesktopControl(bot.id, holder)} />
    </div>
  );
}
