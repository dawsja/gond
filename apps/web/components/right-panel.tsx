"use client";

import { failed } from "@/components/failed";
import { LoadFailed } from "@/components/load-failed";
import { APPROVAL_LEVEL_LABELS, screenOf, type Bot, type Routine, type Thread } from "@gond/shared";
import { Clock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { BotFiles } from "@/components/bot-files";
import { useLiveEvents } from "@/components/hq/live-events";
import { RoutineDetails, setRoutineEnabled } from "@/components/routine-dialog";
import { SCREEN_PREVIEW_MS, ScreenPanel, SleepingScreen, useScreenAwake, useScreenDrivers, wakeScreen } from "@/components/screen-panel";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SpaceSection } from "@/components/spaces/space-section";
import { spaceSubtitle } from "@/lib/spaces";
import { api } from "@/lib/api";
import { describeRoutine } from "@/lib/schedule";
import { cn } from "@/lib/utils";

/** The bot's screen in the panel: live while a bot or the person uses it and for a while after, asleep otherwise. */
function ComputerSlot({ thread, bot, screen }: { thread: Thread; bot: Bot; screen?: ScreenProps }) {
  const { desktop } = useStore();
  const driving = Boolean(desktop?.drivers.some((driver) => driver.threadId === thread.id && driver.botId === bot.id));
  const awake = useScreenAwake(bot.id);
  const live = driving || screenOf(desktop, bot.id).control === "person" || awake;
  const wasDriving = useRef(driving);

  useEffect(() => {
    if (wasDriving.current && !driving) wakeScreen(bot.id, SCREEN_PREVIEW_MS);
    wasDriving.current = driving;
  }, [driving, bot.id]);

  const open = () => (screen ? screen.onExpand(bot.id) : openShellDialog({ kind: "computer", botId: bot.id }));

  if (screen?.open === bot.id) {
    return <div className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border bg-muted text-[12px] text-muted-foreground">Showing on screen</div>;
  }
  if (live && screen) return <ScreenPanel threadId={thread.id} botId={bot.id} expanded={false} onExpand={() => screen.onExpand(bot.id)} onCollapse={screen.onCollapse} />;
  return <SleepingScreen bot={bot} onWake={open} />;
}

function RoutineRow({ routine, onOpen, onChange }: { routine: Routine; onOpen: () => void; onChange: () => Promise<void> }) {
  return (
    <li className="flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-card">
      <Clock className={cn("mt-0.5 size-3.5 shrink-0", routine.enabled ? "text-muted-foreground" : "text-ash")} aria-hidden="true" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
        <span className={cn("block truncate text-[13px] font-medium", !routine.enabled && "text-muted-foreground")}>{routine.name}</span>
        <span className="block text-[12px] text-muted-foreground">{routine.enabled ? describeRoutine(routine) : "Paused"}</span>
      </button>
      <Switch size="sm" checked={routine.enabled} onCheckedChange={(on) => void setRoutineEnabled(routine, on).then(onChange).catch(failed(on ? "Couldn't switch the routine on." : "Couldn't switch the routine off."))} aria-label={`${routine.name} on or off`} className="ml-1 shrink-0" />
    </li>
  );
}

/** Which bot's screen the conversation shows full size, if any. */
type ScreenProps = { open: string | null; onExpand: (botId: string) => void; onCollapse: () => void };

function RightPanelContent({ thread, bot, screen }: { thread: Thread; bot: Bot | null; working: boolean; screen?: ScreenProps }) {
  const { bots } = useStore();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [routinesFailed, setRoutinesFailed] = useState(false);
  const [viewing, setViewing] = useState<Routine | null>(null);
  const drivers = useScreenDrivers(thread.id);

  const botId = bot?.id;
  const load = useCallback(async () => {
    if (!botId) return;
    const data = await api<{ routines: Routine[] }>(`/api/routines?bot=${botId}`).catch(() => null);
    setRoutinesFailed(!data);
    if (data) setRoutines(data.routines);
  }, [botId]);

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
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{thread.space ? "Your bots in this space" : "In this room"}</h2>
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
            {thread.space ? "Edit your bots here" : "Edit room"}
          </Button>
        </section>
        <SpaceSection thread={thread} />
        {drivers.map((driver) => (
          <section key={driver.id}>
            <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{driver.name}&apos;s computer</h2>
            <div className="mt-2">
              <ComputerSlot thread={thread} bot={driver} screen={screen} />
            </div>
          </section>
        ))}
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
        {routines === null ? (
          routinesFailed ? <LoadFailed what="the routines" onRetry={() => void load()} className="mt-2" /> : <Skeleton className="mt-2 h-14 rounded-xl" />
        ) : routines.length === 0 ? (
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

      {viewing ? <RoutineDetails bot={bot} routine={routines?.find((r) => r.id === viewing.id) ?? viewing} onClose={() => setViewing(null)} onChange={load} /> : null}
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
      <SheetContent side="bottom" className="gap-0 xwide:hidden">
        <SheetHeader className="pb-3">
          <SheetTitle>{props.bot ? props.bot.name : props.thread.name}</SheetTitle>
          <SheetDescription>{props.bot ? props.bot.title || "Your bot" : props.thread.space ? spaceSubtitle(props.thread.space) : `${props.thread.members.length} ${props.thread.members.length === 1 ? "bot" : "bots"}`}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pb-6">{open ? <RightPanelContent {...props} /> : null}</div>
      </SheetContent>
    </Sheet>
  );
}
