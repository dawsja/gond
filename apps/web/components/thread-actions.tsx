"use client";

import type { Bot } from "@gond/shared";
import { ArrowRightLeft, Pencil, Pin, PinOff, Trash2, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Confirm } from "@/components/confirm-dialog";
import type { ShellDialog } from "@/components/shell";
import { useStore, type ThreadRow } from "@/components/store";
import { TransferPrimaryDialog } from "@/components/transfer-primary";
import { toast } from "@/components/ui/toast";
import { del, patch } from "@/lib/api";

function failed(fallback: string) {
  return (failure: unknown) => {
    toast.add({ type: "error", title: failure instanceof Error && failure.message ? failure.message : fallback });
  };
}

export type Ask = { kind: "delete" | "transfer"; thread: ThreadRow };

export type ThreadAction = { id: string; label: string; icon: LucideIcon; run: () => void; destructive?: boolean };

export function threadActions({ thread, bot, bots, onOpen, onAsk, refresh }: { thread: ThreadRow; bot: Bot | undefined; bots: Bot[]; onOpen: (dialog: NonNullable<ShellDialog>) => void; onAsk: (ask: Ask) => void; refresh: () => Promise<void> }): ThreadAction[][] {
  const groups: ThreadAction[][] = [];
  if (bot) {
    groups.push([
      { id: "edit", label: "Edit profile", icon: Pencil, run: () => onOpen({ kind: "edit-bot", botId: bot.id }) },
      {
        id: "pin",
        label: bot.pinned ? "Unpin" : "Pin to the top",
        icon: bot.pinned ? PinOff : Pin,
        run: () =>
          void patch(`/api/bots/${bot.id}`, { pinned: !bot.pinned })
            .then(() => refresh())
            .catch(failed(bot.pinned ? "Couldn't unpin it." : "Couldn't pin it.")),
      },
    ]);
    if (bot.primary && bots.some((b) => b.id !== bot.id && !b.hidden)) {
      groups.push([{ id: "transfer", label: "Transfer primary bot", icon: ArrowRightLeft, run: () => onAsk({ kind: "transfer", thread }) }]);
    }
  }
  groups.push([
    { id: "delete", label: bot ? "Delete bot" : "Delete room", icon: Trash2, destructive: true, run: () => onAsk({ kind: "delete", thread }) },
  ]);
  return groups;
}

export function ThreadConfirms({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const { bots, refresh } = useStore();
  const pathname = usePathname();
  const router = useRouter();
  const askBot = ask?.thread.botId ? bots.find((b) => b.id === ask.thread.botId) : undefined;

  async function deleteAsked() {
    if (!ask) return;
    await (askBot ? del(`/api/bots/${askBot.id}`) : del(`/api/rooms/${ask.thread.id}`)).catch(() => undefined);
    await refresh();
    if (pathname === `/app/t/${ask.thread.id}`) router.replace("/app");
  }

  return (
    <>
      <Confirm
        open={ask?.kind === "delete"}
        onOpenChange={(open) => !open && onClose()}
        title={askBot ? `Delete ${askBot.name}?` : "Delete this room?"}
        description={askBot ? "Its conversation and its files on the computer go with it. This can't be undone." : "The room and its messages are removed. The bots stay."}
        action="Delete"
        onConfirm={() => void deleteAsked()}
      />
      <TransferPrimaryDialog bot={askBot} open={ask?.kind === "transfer"} onOpenChange={(open) => !open && onClose()} />
    </>
  );
}
