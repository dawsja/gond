"use client";

import type { Approval, Bot } from "@gond/shared";
import { Mic, MicOff, Monitor, Phone, PhoneOff, Volume2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { callClock, useCall, type CallView } from "@/components/call/call-provider";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVoice } from "@/hooks/use-voice";
import { cn } from "@/lib/utils";

const BARS = [0.5, 0.8, 1, 0.8, 0.5];

/** "1:31" for the call, ticking each second. */
export function useCallClock(call: CallView | null): string {
  const [now, setNow] = useState<number | null>(null);
  const startedAt = call?.info.startedAt;
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [startedAt]);
  return startedAt && now ? callClock(startedAt, now) : "0:00";
}

/**
 * The call's one moving thing: five bars that follow whoever is talking, in the person's color while
 * they do and the bot's while it does. Still under reduced motion.
 */
export function CallWave({ call, bot, className }: { call: CallView; bot: Pick<Bot, "color"> | undefined; className?: string }) {
  const { levels } = useCall();
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const botTalking = call.speaking;
  const quiet = call.muted && !botTalking;
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const draw = () => {
      const level = quiet ? 0 : botTalking ? levels.bot() : levels.you();
      bars.current.forEach((bar, i) => {
        if (bar) bar.style.transform = `scaleY(${Math.max(0.18, Math.min(1, level * BARS[i]! * 1.6))})`;
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levels, botTalking, quiet]);
  return (
    <span aria-hidden="true" className={cn("flex h-5 shrink-0 items-center gap-[3px]", className)}>
      {BARS.map((height, i) => (
        <span
          key={i}
          ref={(node) => {
            bars.current[i] = node;
          }}
          className={cn("h-full w-[3px] rounded-full transition-colors motion-safe:transition-[transform,background-color] motion-safe:duration-75", quiet ? "bg-muted-foreground/50" : botTalking ? "" : "bg-tint-solid")}
          style={{ transform: `scaleY(${height * 0.5})`, ...(botTalking && !quiet ? { background: bot?.color ?? "var(--foreground)" } : {}) }}
        />
      ))}
    </span>
  );
}

function callLabel(call: CallView, bot: Pick<Bot, "name"> | undefined): string {
  if (call.phase === "connecting") return `Calling ${bot?.name ?? "the bot"}`;
  if (call.muted) return "Muted";
  return call.speaking ? `${bot?.name ?? "The bot"} is talking` : "Listening";
}

/** The card a call's bot is waiting on, if any: the pill and the sidebar say so. */
function waitingCard(approvals: Approval[], threadId: string): Approval | null {
  return approvals.find((a) => a.threadId === threadId && a.status === "pending") ?? null;
}

/** Calling: the phone circle in a bot's header. One call at a time, so a second asks first. */
export function CallButton({ threadId, bot, className }: { threadId: string; bot: Bot; className?: string }) {
  const { call, start } = useCall();
  const { voice } = useVoice();
  const { bots } = useStore();
  const [confirm, setConfirm] = useState(false);
  if (call?.info.threadId === threadId) return null;
  const other = call ? bots.find((b) => b.id === call.info.botId) : undefined;

  function dial() {
    if (!voice?.using) {
      toast.add({ title: "A call needs an xAI or OpenAI key.", description: "Add one in Settings → AI. The call is billed by the minute on that key." });
      return;
    }
    if (call) setConfirm(true);
    else void start(threadId);
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button size="icon-xl" aria-label={`Call ${bot.name}`} onClick={dial} className={cn("pointer-events-auto", !voice?.using && "text-muted-foreground", className)} />}>
          <Phone aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Call {bot.name}</TooltipContent>
      </Tooltip>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>End the call with {other?.name ?? "your bot"}?</AlertDialogTitle>
            <AlertDialogDescription>You can be on one call at a time. What {other?.name ?? "it"} is working on carries on.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep talking</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(false);
                void start(threadId);
              }}
            >
              Call {bot.name}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** In the call's own chat the composer is the call: mute, what is happening, and hang up. */
export function CallComposer({ call, bot }: { call: CallView; bot: Bot | undefined }) {
  const { end, toggleMute } = useCall();
  const clock = useCallClock(call);
  return (
    <div className="flex items-center gap-2.5">
      <Tooltip>
        <TooltipTrigger render={<Button type="button" size="icon-xl" variant={call.muted ? "control" : "default"} aria-pressed={call.muted} aria-label={call.muted ? "Unmute" : "Mute"} onClick={toggleMute} />}>
          {call.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
        </TooltipTrigger>
        <TooltipContent>{call.muted ? "Unmute" : "Mute"}</TooltipContent>
      </Tooltip>
      <div role="status" aria-live="polite" className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full border border-primary-edge bg-primary pr-4 pl-4.5 text-primary-foreground">
        <span className={cn("truncate text-[14px] font-medium", call.phase === "connecting" && "shimmer")}>{callLabel(call, bot)}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{clock}</span>
        <CallWave call={call} bot={bot} className="ml-auto" />
      </div>
      <Tooltip>
        <TooltipTrigger render={<Button type="button" size="icon-xl" variant="hangup" aria-label="End the call" onClick={end} />}>
          <PhoneOff aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>End the call</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** A line said on a call carries a small mark: a mic for the person's, a speaker for the bot's. */
export function SpokenMark({ mine }: { mine: boolean }) {
  const Icon = mine ? Mic : Volume2;
  return <Icon aria-label={mine ? "Said on a call" : "Said aloud on a call"} className="float-left mt-[5px] mr-1.5 size-3.5 text-muted-foreground" />;
}

/** On a phone, away from the call's chat: the call as a pill under the header, a tap back to it. */
export function CallPill() {
  const { call, end, toggleMute } = useCall();
  const { bots, approvals } = useStore();
  const pathname = usePathname();
  const router = useRouter();
  const clock = useCallClock(call);
  const shown = Boolean(call) && pathname !== `/app/t/${call?.info.threadId}`;
  useEffect(() => {
    const root = document.documentElement;
    if (shown) root.dataset.callPill = "";
    else delete root.dataset.callPill;
    return () => {
      delete root.dataset.callPill;
    };
  }, [shown]);
  if (!call || !shown) return null;
  const bot = bots.find((b) => b.id === call.info.botId);
  const card = waitingCard(approvals, call.info.threadId);
  const open = () => router.push(`/app/t/${call.info.threadId}`);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(var(--safe-top)+64px)] z-40 flex justify-center px-3 wide:hidden">
      {card ? (
        <div className="pointer-events-auto flex h-11 max-w-full min-w-0 items-center gap-2 rounded-full border border-primary-edge bg-card pr-1.5 pl-1.5 shadow-subtle-3 [--surface:var(--card)]">
          <button type="button" onClick={open} className="flex min-w-0 items-center gap-2 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {bot ? <BotAvatar bot={bot} size={32} /> : null}
            <span className="truncate text-[13.5px] font-semibold">{card.summary || "A card needs you"}</span>
            <Badge tone="warn" className="shrink-0">
              Needs you
            </Badge>
          </button>
          <Button size="icon" variant="hangup" aria-label="End the call" onClick={end} className="shrink-0 rounded-full">
            <PhoneOff aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <div className="pointer-events-auto flex h-11 max-w-full min-w-0 items-center gap-2 rounded-full bg-foreground pr-1.5 pl-1.5 text-background shadow-subtle-3 [--surface:var(--foreground)]">
          <button type="button" onClick={open} aria-label={`Back to the call with ${bot?.name ?? "your bot"}`} className="flex min-w-0 items-center gap-2 rounded-full pr-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {bot ? <BotAvatar bot={bot} size={32} /> : null}
            <span className="truncate text-[13.5px] font-semibold">{bot?.name ?? "Call"}</span>
            <CallWave call={call} bot={bot} className="h-4" />
            <span className="text-xs tabular-nums opacity-70">{clock}</span>
          </button>
          <button type="button" onClick={toggleMute} aria-pressed={call.muted} aria-label={call.muted ? "Unmute" : "Mute"} className={cn("grid size-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50", call.muted ? "bg-background text-foreground" : "bg-background/15")}>
            {call.muted ? <MicOff className="size-4" aria-hidden="true" /> : <Mic className="size-4" aria-hidden="true" />}
          </button>
          <Button size="icon" variant="hangup" aria-label="End the call" onClick={end} className="shrink-0 rounded-full">
            <PhoneOff aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** On a wide screen, away from the call's chat: the call sits in the sidebar, above your profile. */
export function CallBar() {
  const { call, end, toggleMute } = useCall();
  const { bots, approvals } = useStore();
  const pathname = usePathname();
  const clock = useCallClock(call);
  if (!call || pathname === `/app/t/${call.info.threadId}`) return null;
  const bot = bots.find((b) => b.id === call.info.botId);
  const card = waitingCard(approvals, call.info.threadId);
  return (
    <div className="mb-1 hidden flex-col gap-2 rounded-2xl border border-primary-edge bg-card p-2 [--surface:var(--card)] wide:flex">
      <Link href={`/app/t/${call.info.threadId}`} className="flex min-w-0 items-center gap-2.5 rounded-xl p-0.5 outline-none hover:bg-primary-hover focus-visible:ring-3 focus-visible:ring-ring/50">
        {bot ? <BotAvatar bot={bot} size={32} /> : null}
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13.5px] font-semibold">{bot?.name ?? "Call"}</span>
          <span className="truncate text-[11.5px] font-medium text-tint-ink tabular-nums">
            {call.phase === "connecting" ? "Calling" : `On a call · ${clock}`}
          </span>
        </span>
        <CallWave call={call} bot={bot} className="mr-1 h-4" />
      </Link>
      {card ? (
        <Link href={`/app/t/${call.info.threadId}`} className="flex min-w-0 items-center gap-2 rounded-xl px-1 text-[12.5px] outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
          <Badge tone="warn" className="shrink-0">
            Needs you
          </Badge>
          <span className="truncate">{card.summary}</span>
        </Link>
      ) : null}
      <div className="flex gap-1.5">
        <Button size="lg" variant={call.muted ? "control" : "outline"} aria-pressed={call.muted} aria-label={call.muted ? "Unmute" : "Mute"} onClick={toggleMute} className="flex-1">
          {call.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
        </Button>
        <Button size="lg" variant="outline" aria-label={`${bot?.name ?? "The bot"}'s screen`} onClick={() => openShellDialog({ kind: "computer", botId: call.info.botId })} className="flex-1">
          <Monitor aria-hidden="true" />
        </Button>
        <Button size="lg" variant="hangup" aria-label="End the call" onClick={end} className="flex-1">
          <PhoneOff aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/** The chat list's line for a bot you're on a call with. */
export function useCallLine(threadId: string): string | null {
  const { call } = useCall();
  const clock = useCallClock(call?.info.threadId === threadId ? call : null);
  if (call?.info.threadId !== threadId) return null;
  return call.phase === "connecting" ? "Calling" : `On a call · ${clock}`;
}
