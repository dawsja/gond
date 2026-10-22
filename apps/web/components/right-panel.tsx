"use client";

import { APPROVAL_LEVEL_LABELS, type Bot, type Routine, type Thread } from "@gond/shared";
import { Clock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { BotFiles } from "@/components/bot-files";
import { useLiveEvents } from "@/components/hq/live-events";
import { RoutineDetails, setRoutineEnabled } from "@/components/routine-dialog";
import { SCREEN_PREVIEW_MS, ScreenPanel, SleepingScreen, useScreenAwake, wakeScreen } from "@/components/screen-panel";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { describeSchedule } from "@/lib/schedule";
import { cn } from "@/lib/utils";

/** The bot's screen in the panel: live while a bot or the person uses it and for a while after, asleep otherwise. */
function ComputerSlot({ thread, bot, screen }: { thread: Thread; bot: Bot; screen?: ScreenProps }) {
  const { desktop } = useStore();
  const driving = Boolean(desktop?.drivers.some((driver) => driver.threadId === thread.id));
  const awake = useScreenAwake(bot.id);
  const live = driving || desktop?.control === "person" || awake;
  const wasDriving = useRef(driving);

  useEffect(() => {
    if (wasDriving.current && !driving) wakeScreen(bot.id, SCREEN_PREVIEW_MS);
    wasDriving.current = driving;
  }, [driving, bot.id]);

  const open = () => (screen ? screen.onExpand() : openShellDialog({ kind: "computer", botId: bot.id }));

  if (screen?.expanded) {
    return <div className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border bg-muted text-[12px] text-muted-foreground">Showing on screen</div>;
  }
  if (live && screen) return <ScreenPanel threadId={thread.id} botId={bot.id} expanded={false} onExpand={screen.onExpand} onCollapse={screen.onCollapse} />;
  return <SleepingScreen bot={bot} onWake={open} />;
}

function RoutineRow({ routine, onOpen, onChange }: { routine: Routine; onOpen: () => void; onChange: () => Promise<void> }) {
  return (
    <li className="flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-card">
      <Clock className={cn("mt-0.5 size-3.5 shrink-0", routine.enabled ? "text-muted-foreground" : "text-ash")} aria-hidden="true" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
        <span className={cn("block truncate text-[13px] font-medium", !routine.enabled && "text-muted-foreground")}>{routine.name}</span>
        <span className="block text-[12px] text-muted-foreground">{routine.enabled ? describeSchedule(routine.cron) : "Paused"}</span>
      </button>
      <Switch size="sm" checked={routine.enabled} onCheckedChange={(on) => void setRoutineEnabled(routine, on).then(onChange)} aria-label={`${routine.name} on or off`} className="ml-1 shrink-0" />
    </li>
  );
}

export type ScreenProps = { expanded: boolean; onExpand: () => void; onCollapse: () => void };

export function RightPanelContent({ thread, bot, screen }: { thread: Thread; bot: Bot | null; working: boolean; screen?: ScreenProps }) {
  const { bots } = useStore();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [viewing, setViewing] = useState<Routine | null>(null);

  const load = useCallback(async () => {
    if (!bot) return;
    const data = await api<{ routines: Routine[] }>(`/api/routines?bot=${bot.id}`).catch(() => null);
    if (data) setRoutines(data.routines);
  }, [bot]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  if (!bot) {
    const members = thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b));
    return (
      <>
        <section>
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">In this room</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {members.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-[13px]">
                <BotAvatar bot={b} size={24} />
                <span className="font-medium">{b.name}</span>
                <span className="truncate text-muted-foreground">{b.title}</span>
              </li>
            ))}
          </ul>
          <Button variant="outline" size="sm" onClick={() => openShellDialog({ kind: "edit-room", threadId: thread.id })} className="mt-3 w-full">
            Edit group
          </Button>
        </section>
      </>
    );
  }

  return (
    <>
      <section>
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{bot.name}&apos;s computer</h2>
        <div className="mt-2">
          <ComputerSlot thread={thread} bot={bot} screen={screen} />
        </div>
      </section>

      <section>
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Routines</h2>
        {routines.length === 0 ? (
          <Empty className="mt-2 border px-3 py-5">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock />
              </EmptyMedia>
              <EmptyTitle>Nothing scheduled</EmptyTitle>
              <EmptyDescription className="text-xs">Ask {bot.name} to run something on a schedule, like a morning briefing.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {routines.map((r) => (
              <RoutineRow key={r.id} routine={r} onOpen={() => setViewing(r)} onChange={load} />
            ))}
          </ul>
        )}
      </section>

      <BotFiles bot={bot} />

      <section>
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Profile</h2>
        <dl className="mt-2 flex flex-col gap-1.5 text-[12.5px]">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Approvals</dt>
            <dd>{APPROVAL_LEVEL_LABELS[bot.approval].title}</dd>
          </div>
        </dl>
        <Button variant="outline" size="sm" onClick={() => openShellDialog({ kind: "edit-bot", botId: bot.id })} className="mt-3 w-full">
          Edit profile
        </Button>
      </section>

      {viewing ? <RoutineDetails bot={bot} routine={routines.find((r) => r.id === viewing.id) ?? viewing} onClose={() => setViewing(null)} onChange={load} /> : null}
    </>
  );
}

export function RightPanel(props: { thread: Thread; bot: Bot | null; working: boolean; screen?: ScreenProps }) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l bg-background p-4 xwide:flex">
      <RightPanelContent {...props} />
    </aside>
  );
}

export function DetailsSheet({ open, onOpenChange, ...props }: { open: boolean; onOpenChange: (open: boolean) => void; thread: Thread; bot: Bot | null; working: boolean; screen?: ScreenProps }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] gap-0 rounded-t-2xl pb-[var(--safe-bottom)] xwide:hidden">
        <SheetHeader className="pb-2">
          <SheetTitle>{props.bot ? props.bot.name : props.thread.name}</SheetTitle>
          <SheetDescription>{props.bot ? props.bot.title || "Teammate" : `${props.thread.members.length} bots`}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">{open ? <RightPanelContent {...props} /> : null}</div>
      </SheetContent>
    </Sheet>
  );
}
