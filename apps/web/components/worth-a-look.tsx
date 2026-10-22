"use client";

import { plainMarkdown, type Approval, type Bot, type Message } from "@gond/shared";
import { ChevronDown, ChevronRight, Eye } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ApprovalCard, type Decision } from "@/components/approval-card";
import { BotAvatar } from "@/components/bot-avatar";
import { shortTime } from "@/components/sidebar";
import { useStore, type ThreadRow } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

// The card in the conversation is drawn from its message; here the approval stands in for it.
const messageOf = (approval: Approval): Message => ({
  id: approval.id,
  threadId: approval.threadId,
  author: approval.botId,
  kind: "approval",
  body: approval.summary,
  attachments: [],
  depth: 0,
  approvalId: approval.id,
  fromThreadId: null,
  steered: false,
  reactions: [],
  createdAt: approval.createdAt,
});

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function useWorthALook() {
  const { approvals, threads, botById } = useStore();
  const pathname = usePathname();
  const noticed = threads.filter((t) => t.noticed && pathname !== `/app/t/${t.id}`);
  const faces: Bot[] = [];
  for (const id of [...approvals.map((a) => a.botId), ...noticed.map((t) => t.botId)]) {
    const bot = id ? botById(id) : undefined;
    if (bot && !faces.includes(bot) && faces.length < 3) faces.push(bot);
  }
  return { approvals, noticed, faces, botById };
}

function Faces({ bots }: { bots: Bot[] }) {
  return (
    <span className="flex shrink-0 pr-2.5">
      {bots.map((bot) => (
        <span key={bot.id} className="-mr-2.5 grid size-9 place-items-center rounded-full border-2 border-tint-wash bg-card">
          <BotAvatar bot={{ ...bot, primary: false }} size={26} />
        </span>
      ))}
    </span>
  );
}

function Noticed({ thread, bot, onOpen }: { thread: ThreadRow; bot: Bot | undefined; onOpen: () => void }) {
  const noticed = thread.noticed!;
  return (
    <Link href={`/app/t/${thread.id}`} onClick={onOpen} className="flex items-center gap-3 rounded-3xl border border-tint-edge bg-tint-wash px-3 py-2.5 outline-none hover:border-primary-edge-focus focus-visible:ring-3 focus-visible:ring-ring/50">
      {bot ? <BotAvatar bot={{ ...bot, primary: false }} size={34} /> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1 text-[11.5px] leading-4 font-semibold text-tint-ink">
          <Eye className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {bot?.name ?? thread.name} noticed · {shortTime(noticed.at)}
          </span>
        </span>
        <span className="line-clamp-2 text-[14px] leading-5 font-semibold">{plainMarkdown(noticed.body)}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-tint-ink" aria-hidden="true" />
    </Link>
  );
}

function List({ close, className }: { close: () => void; className?: string }) {
  const { approvals, noticed, botById } = useWorthALook();
  const { refresh } = useStore();

  async function decide(id: string, decision: Decision) {
    try {
      await post(`/api/approvals/${id}`, { decision });
      await refresh();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't send your answer." });
    }
  }

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} message={messageOf(approval)} approval={approval} bot={botById(approval.botId)} onDecide={decide} />
      ))}
      {noticed.map((thread) => (
        <Noticed key={thread.id} thread={thread} bot={thread.botId ? botById(thread.botId) : undefined} onOpen={close} />
      ))}
    </div>
  );
}

function useMarkSeen(close: () => void) {
  const { noticed } = useWorthALook();
  const { refresh } = useStore();
  return async () => {
    close();
    try {
      await Promise.all(noticed.map((t) => post(`/api/threads/${t.id}/read`)));
      await refresh();
    } catch {
      toast.add({ type: "error", title: "Couldn't mark them seen." });
    }
  };
}

/**
 * What needs the person and what the bots noticed, as one pill above the list: on a phone it opens
 * a sheet, in the sidebar a popover.
 */
export function WorthALook({ as, className }: { as: "sheet" | "popover"; className?: string }) {
  const { approvals, noticed, faces } = useWorthALook();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const markSeen = useMarkSeen(close);
  const total = approvals.length + noticed.length;
  if (total === 0) return null;

  const trigger: ReactNode = (
    <>
      <Faces bots={as === "popover" ? faces.slice(0, 2) : faces} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-[14px] leading-[18px] font-semibold">{count(total, "thing", "things")} worth a look</span>
        <span className="truncate text-[12px] leading-4 font-medium text-tint-ink">
          {[approvals.length ? `${approvals.length} needs you` : null, noticed.length ? `${noticed.length} noticed` : null].filter(Boolean).join(" · ")}
        </span>
      </span>
      <ChevronDown className={cn("size-4 shrink-0 text-tint-ink transition-transform", open && "rotate-180")} aria-hidden="true" />
    </>
  );
  const pill = cn("flex min-h-12 w-full items-center gap-2 rounded-full border border-tint-edge bg-tint-wash py-1.5 pr-3.5 pl-1.5 text-foreground outline-none hover:border-primary-edge-focus focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-14", className);
  const seen = noticed.length ? (
    <Button variant="outline" size="lg" onClick={() => void markSeen()}>
      Mark all seen
    </Button>
  ) : null;

  if (as === "popover") {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className={pill}>{trigger}</PopoverTrigger>
        <PopoverContent align="start" className="max-h-[min(72dvh,620px)] w-[400px] gap-3 overflow-y-auto rounded-3xl p-3.5">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <PopoverTitle className="text-[16px] font-semibold">Worth a look</PopoverTitle>
            {noticed.length ? (
              <button type="button" onClick={() => void markSeen()} className="rounded-full px-1 text-[12.5px] font-semibold text-tint-ink outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                Mark all seen
              </button>
            ) : null}
          </div>
          <List close={close} />
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <>
      <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)} className={pill}>
        {trigger}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Worth a look</DialogTitle>
          </DialogHeader>
          <List close={close} className="pt-4" />
          {seen ? <DialogFooter>{seen}</DialogFooter> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
