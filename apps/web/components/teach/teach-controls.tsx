"use client";

import type { Bot, Teaching, TeachStep } from "@gond/shared";
import { Check, ChevronDown, ChevronUp, Lock, MessageSquarePlus, Mic, Pause, Play, SendHorizontal, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { Confirm } from "@/components/confirm-dialog";
import { failed } from "@/components/failed";
import { openShellDialog } from "@/components/shell";
import { clock, useOpenTeaching, usePutTeaching, useRecordingMs } from "@/components/teach/teaching-store";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVoiceInput, VoiceButton } from "@/components/voice-button";
import { patch, post } from "@/lib/api";
import { cn } from "@/lib/utils";

/** What the person can do to a recording, each answered with it as it now stands. */
export function useTeachActions(teaching: Teaching) {
  const put = usePutTeaching();
  const run = (path: string, fallback: string, body?: unknown) =>
    post<{ teaching: Teaching }>(`/api/teachings/${teaching.id}/${path}`, body)
      .then((data) => put(data.teaching))
      .catch((failure: unknown) => {
        failed(fallback)(failure);
        throw failure;
      });
  return {
    pause: () => run("pause", "Couldn't pause. Try again."),
    resume: () => run("resume", "Couldn't resume. Try again."),
    done: () => run("done", "Couldn't finish the recording. Try again."),
    discard: () => run("discard", "Couldn't discard it. Try again."),
    note: (text: string) => run("notes", "Couldn't add the note. Try again.", { text }),
    skip: (n: number, skipped: boolean) =>
      patch<{ teaching: Teaching }>(`/api/teachings/${teaching.id}/steps/${n}`, { skipped })
        .then((data) => put(data.teaching))
        .catch(failed("Couldn't change that step. Try again.")),
  };
}

/** "Recording · 2:14", or paused, with how long is left once the end is near. */
export function RecordingPill({ teaching, className }: { teaching: Teaching; className?: string }) {
  const ms = useRecordingMs(teaching);
  const left = teaching.maxMs - ms;
  const paused = teaching.status === "paused";
  return (
    <div className={cn("flex h-9 shrink-0 items-center gap-2 rounded-full border border-primary-edge bg-primary px-3.5 text-[13px] font-semibold tabular-nums", paused ? "text-tone-warn" : "text-tone-bad", className)}>
      <span className={cn("size-2 shrink-0 rounded-full bg-current", paused ? "" : "animate-pulse motion-reduce:animate-none")} aria-hidden="true" />
      <span>
        {paused ? (teaching.pausedFor === "away" ? "Paused while you were away" : "Paused") : "Recording"} · {clock(ms)}
        {!paused && left < 60_000 ? ` · ${Math.max(0, Math.ceil(left / 1000))}s left` : ""}
      </span>
    </div>
  );
}

/** Adding a note while showing: typed, or said through the mic like the composer. */
function NoteField({ teaching, onDone }: { teaching: Teaching; onDone: () => void }) {
  const { note } = useTeachActions(teaching);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const voice = useVoiceInput(teaching.threadId, (heard) => setText((current) => (current ? `${current} ${heard}` : heard)));
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await note(text);
      setText("");
      onDone();
    } catch {
      // Already said in a toast.
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} className="flex flex-col gap-2">
      <span className="px-1 text-[13px] text-muted-foreground">Why you did that, or what to watch for. It goes with the last step.</span>
      <InputGroup>
        <InputGroupInput value={text} onChange={(event) => setText(event.target.value)} placeholder="The newest bill is always on top" aria-label="Note" />
        <InputGroupAddon align="inline-end">
          <VoiceButton input={voice} />
          <InputGroupButton type="submit" size="icon-sm" variant="tint" aria-label="Add the note" disabled={!text.trim() || busy}>
            <SendHorizontal />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

export function NoteButton({ teaching, size = "lg", className }: { teaching: Teaching; size?: "lg" | "xl"; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size={size} className={className} />}>
        <MessageSquarePlus data-icon="inline-start" aria-hidden="true" />
        Note
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-80">
        <NoteField teaching={teaching} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Discard asks first: what was shown so far goes with it. */
export function DiscardButton({ teaching, bot, className }: { teaching: Teaching; bot: Bot | undefined; className?: string }) {
  const { discard } = useTeachActions(teaching);
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button size="icon-lg" aria-label="Discard the recording" onClick={() => setAsking(true)} className={cn("pointer-coarse:size-11", className)}>
        <X aria-hidden="true" />
      </Button>
      <Confirm open={asking} onOpenChange={setAsking} title="Discard what you showed?" description={`${bot?.name ?? "The bot"} won't learn anything from it, and the recording is deleted.`} action="Discard" onConfirm={discard} />
    </>
  );
}

/** A wide screen's pills while the person shows a bot how, in place of the screen's own. */
export function TeachBar({ teaching, bot, className }: { teaching: Teaching; bot: Bot | undefined; className?: string }) {
  const { pause, resume, done } = useTeachActions(teaching);
  const paused = teaching.status === "paused";
  const [finishing, setFinishing] = useState(false);
  const finish = () => {
    setFinishing(true);
    void done()
      .catch(() => undefined)
      .finally(() => setFinishing(false));
  };
  return (
    <div className={cn("relative flex items-center gap-2", className)}>
      <div className="flex h-9 min-w-0 shrink items-center gap-2 rounded-full border border-primary-edge bg-primary pr-3.5 pl-1 text-[13px] font-medium text-primary-foreground">
        {bot ? <BotAvatar bot={bot} size={28} /> : null}
        <span className="truncate">{bot?.name ?? "The bot"} is watching</span>
      </div>
      <RecordingPill teaching={teaching} />
      <span className="flex-1" />
      <NoteButton teaching={teaching} />
      <Button size="lg" onClick={() => void (paused ? resume() : pause()).catch(() => undefined)}>
        {paused ? <Play data-icon="inline-start" aria-hidden="true" /> : <Pause data-icon="inline-start" aria-hidden="true" />}
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button size="lg" variant="tint" onClick={finish} disabled={finishing}>
        <Check data-icon="inline-start" aria-hidden="true" />
        Done
      </Button>
      <DiscardButton teaching={teaching} bot={bot} />
    </div>
  );
}

function StepRow({ step, last, recording, onSkip }: { step: TeachStep; last: boolean; recording: boolean; onSkip: (skip: boolean) => void }) {
  return (
    <li className={cn("group relative flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-muted pointer-coarse:pr-[4.75rem]", step.skipped && "pr-[4.75rem] text-muted-foreground")}>
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums", last && recording ? "animate-pulse bg-tone-bad text-white motion-reduce:animate-none" : "bg-muted")}>{step.n}</span>
      <span className={cn("min-w-0 flex-1 text-[13.5px] [overflow-wrap:anywhere]", step.skipped && "line-through")}>{step.label}</span>
      {step.sensitive ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-tone-ok">
          <Lock className="size-3" aria-hidden="true" />
          Not kept
        </span>
      ) : null}
      {/* Shown on hover over the row, so it takes no room from the words until then; always on a touch screen. */}
      <Button size="xs" variant="outline" aria-pressed={Boolean(step.skipped)} onClick={() => onSkip(!step.skipped)} className="absolute top-1/2 right-1.5 -translate-y-1/2 bg-card opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 aria-pressed:opacity-100">
        {step.skipped ? "Keep" : "Skip"}
      </Button>
    </li>
  );
}

/** What the bot has seen so far, newest last, kept scrolled to the end as steps arrive. */
export function TeachSteps({ teaching, className, onCollapse }: { teaching: Teaching; className?: string; onCollapse?: () => void }) {
  const { skip } = useTeachActions(teaching);
  const list = useRef<HTMLOListElement>(null);
  const count = teaching.steps.length;
  useEffect(() => {
    const node = list.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [count, teaching.notes.length]);
  const shown = teaching.steps;
  const notesAfter = (n: number) => teaching.notes.filter((note) => note.after === n);
  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-3xl border border-primary-edge bg-card", className)}>
      <div className="flex items-baseline justify-between gap-3 border-b px-4 pt-3.5 pb-2.5">
        <span className="text-[15px] font-semibold">What I&apos;ve seen</span>
        <span className="flex items-center gap-2 text-[12px] text-muted-foreground tabular-nums">
          {count === 1 ? "1 step" : `${count} steps`}
          {teaching.notes.length ? ` · ${teaching.notes.length === 1 ? "1 note" : `${teaching.notes.length} notes`}` : ""}
          {onCollapse ? (
            <Button size="icon-sm" variant="ghost" aria-label="Show only the last step" onClick={onCollapse} className="-my-1 pointer-coarse:size-11">
              <ChevronDown aria-hidden="true" />
            </Button>
          ) : null}
        </span>
      </div>
      {count === 0 && !teaching.notes.length ? (
        <p className="px-4 py-3.5 text-[13.5px] text-muted-foreground">Do the task as you normally would. Each step shows up here as you go.</p>
      ) : (
        <ol ref={list} className="flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto overscroll-contain p-2">
          {notesAfter(0).map((note) => (
            <NoteRow key={`0-${note.at}`} text={note.text} />
          ))}
          {shown.map((step, index) => (
            <Fragment key={step.n}>
              <StepRow step={step} last={index === shown.length - 1} recording={teaching.status === "recording"} onSkip={(skipped) => void skip(step.n, skipped)} />
              {notesAfter(step.n).map((note) => (
                <NoteRow key={`${step.n}-${note.at}-${note.text}`} text={note.text} />
              ))}
            </Fragment>
          ))}
        </ol>
      )}
      {teaching.full ? <p className="border-t px-4 py-2.5 text-[12px] text-muted-foreground">That&apos;s as much as one recording holds. Finish here, and show the rest another time.</p> : null}
    </div>
  );
}

function NoteRow({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 rounded-xl bg-tint-wash px-2.5 py-2 text-[13px] text-tint-ink">
      <Mic className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="[overflow-wrap:anywhere]">Your note: &ldquo;{text}&rdquo;</span>
    </li>
  );
}

/** The recording's state as words, for the phone's header in place of who has the screen. */
export function RecordingText({ teaching }: { teaching: Teaching }) {
  const ms = useRecordingMs(teaching);
  const paused = teaching.status === "paused";
  return (
    <span className={cn("flex items-center gap-1.5 font-medium tabular-nums", paused ? "text-tone-warn" : "text-tone-bad")}>
      <span className={cn("size-1.5 shrink-0 rounded-full bg-current", !paused && "animate-pulse motion-reduce:animate-none")} aria-hidden="true" />
      {paused ? (teaching.pausedFor === "away" ? "Paused while you were away" : "Paused") : "Recording"} · {clock(ms)}
    </span>
  );
}

/**
 * A phone's controls while showing a bot how: the latest step in one line over the bottom row
 * (tap it for them all), and Note, Pause and Done in place of taking control.
 */
export function TeachPhone({ teaching, bot }: { teaching: Teaching; bot: Bot | undefined }) {
  const { pause, resume, done } = useTeachActions(teaching);
  const [open, setOpen] = useState(false);
  const paused = teaching.status === "paused";
  const last = teaching.steps.at(-1);
  return (
    <div className="pointer-events-auto flex w-full flex-col gap-2">
      {open ? (
        <TeachSteps teaching={teaching} className="max-h-[45dvh]" onCollapse={() => setOpen(false)} />
      ) : (
        <button type="button" aria-expanded={false} onClick={() => setOpen(true)} className="flex h-12 w-full items-center gap-2.5 rounded-full border border-primary-edge bg-card pr-3 pl-2 text-left">
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums", teaching.status === "recording" && last ? "animate-pulse bg-tone-bad text-white motion-reduce:animate-none" : "bg-muted")}>{last?.n ?? 0}</span>
          <span className="min-w-0 flex-1 truncate text-[14px]">{last ? last.label : "Each step shows up here as you go"}</span>
          <ChevronUp className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Show every step</span>
        </button>
      )}
      <div className="flex items-center gap-2">
        <NoteButton teaching={teaching} size="xl" className="flex-1" />
        <Button size="xl" className="flex-1" onClick={() => void (paused ? resume() : pause()).catch(() => undefined)}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="xl" variant="tint" className="flex-1" onClick={() => void done().catch(() => undefined)}>
          Done
        </Button>
        <DiscardButton teaching={teaching} bot={bot} />
      </div>
    </div>
  );
}

/** Over a conversation's composer while its bot is being shown how: where to go back to, or how to finish. */
export function TeachPill({ teaching, onOpen }: { teaching: Teaching; onOpen: () => void }) {
  const { resume, done } = useTeachActions(teaching);
  const paused = teaching.status === "paused";
  return (
    <div className="mx-auto mb-2 flex w-fit items-center gap-1.5 rounded-full border border-primary-edge bg-primary py-1 pr-1 pl-1 shadow-subtle-1">
      <RecordingPill teaching={teaching} className="h-8 border-0 bg-transparent" />
      {paused ? (
        <Button size="sm" variant="tint" className="h-8 rounded-full px-3" onClick={() => void resume().catch(() => undefined)}>
          Resume
        </Button>
      ) : (
        <Button size="sm" variant="tint" className="h-8 rounded-full px-3" onClick={onOpen}>
          Open the screen
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-8 rounded-full px-3" onClick={() => void done().catch(() => undefined)}>
        Done
      </Button>
    </div>
  );
}

/** The pill for a conversation, reading the recording itself, so its steps redraw only this. */
export function TeachPillFor({ threadId }: { threadId: string }) {
  const open = useOpenTeaching();
  if (!open || open.threadId !== threadId || (open.status !== "recording" && open.status !== "paused")) return null;
  return <TeachPill teaching={open} onOpen={() => openShellDialog({ kind: "computer", botId: open.botId })} />;
}
