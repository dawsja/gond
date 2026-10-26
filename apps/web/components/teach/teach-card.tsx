"use client";

import type { Bot, Message, Teaching, TeachDraft } from "@gond/shared";
import { ChevronLeft, ChevronRight, Eye, GraduationCap, Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ActionCard, ActionCardDone, ActionRows, cheerOnFold, NOBODY_ANSWERED } from "@/components/action-card";
import { Confirm } from "@/components/confirm-dialog";
import { useDiscardChanges } from "@/components/discard-changes";
import { failed } from "@/components/failed";
import { openShellDialog } from "@/components/shell";
import { RecordingPill, useTeachActions } from "@/components/teach/teach-controls";
import { clock, usePutTeaching, useTeaching } from "@/components/teach/teaching-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { api, post } from "@/lib/api";
import { cn } from "@/lib/utils";

const frameUrl = (id: string, n: number) => `/api/teachings/${id}/frames/${n}`;
const NEVER_KEPT = "Passwords and sign-in codes are never kept, and only you and your bots see the recording.";

/**
 * "Show me how" in a conversation: one card that follows it from the offer to the skill. It asks
 * to start, says it is recording, asks the person to hide what they typed outside the browser,
 * waits while the bot looks, then shows the bot's draft to try, save or send back.
 */
export function TeachCard({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const { teaching, failed: loadFailed, reload } = useTeaching(message.approvalId);
  const name = bot?.name ?? "The bot";
  const icon = <GraduationCap aria-hidden="true" />;
  if (!teaching) {
    return (
      <ActionCard
        icon={icon}
        title={message.body || `Show ${name} how`}
        by={loadFailed ? "Couldn't load this." : <Spinner aria-label="Loading" />}
        needs={false}
        actions={
          loadFailed ? (
            <Button variant="outline" size="xl" onClick={reload}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }
  switch (teaching.status) {
    case "offered":
      return <Offered teaching={teaching} bot={bot} icon={icon} />;
    case "recording":
    case "paused":
      return <Recording teaching={teaching} bot={bot} icon={icon} />;
    case "review":
      return <Review teaching={teaching} bot={bot} icon={icon} />;
    case "looking":
      return (
        <ActionCard icon={icon} title={`${name} is looking at what you showed it`} by={`${teaching.steps.length} steps · ${clock(teaching.activeMs)}`} needs={false}>
          <Spinner aria-label="Looking" className="text-muted-foreground" />
        </ActionCard>
      );
    case "ready":
      return <Ready teaching={teaching} bot={bot} icon={icon} />;
    case "saved":
      return <ActionCardDone id={message.id} bot={bot} icon={icon} title={teaching.draft?.name ?? "What you showed"} by={teaching.skillSlug ? `Saved as the skill /${teaching.skillSlug}` : "Saved as a skill"} status="Saved" tone="ok" />;
    case "failed":
      return <ActionCardDone bot={bot} icon={icon} title={`Show ${name} how`} by={teaching.error ?? "The recording couldn't be kept."} status="Didn't work" tone="bad" />;
    default: {
      const why = teaching.endedWhy;
      const [status, by] = why === "expired" ? ["Expired", NOBODY_ANSWERED] : why === "empty" ? ["Nothing recorded", "Nothing happened on the screen while it recorded."] : why === "stopped" ? ["Stopped", "Stopped from the chat."] : why === "removed" ? ["Removed", "The bot was removed."] : ["Discarded", "Nothing was kept."];
      return <ActionCardDone bot={bot} icon={icon} title={`Show ${name} how`} by={by} status={status} tone="neutral" />;
    }
  }
}

type CardProps = { teaching: Teaching; bot: Bot | undefined; icon: React.ReactNode };

function openScreen(botId: string) {
  openShellDialog({ kind: "computer", botId });
}

function Offered({ teaching, bot, icon }: CardProps) {
  const put = usePutTeaching();
  const { discard } = useTeachActions(teaching);
  const [busy, setBusy] = useState(false);
  const name = bot?.name ?? "the bot";
  const start = async () => {
    setBusy(true);
    try {
      const data = await post<{ teaching: Teaching }>(`/api/teachings/${teaching.id}/start`);
      cheerOnFold(teaching.id);
      put(data.teaching);
      openScreen(teaching.botId);
    } catch (failure) {
      failed("Couldn't start recording. Try again.")(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ActionCard
      icon={icon}
      title={`Show ${name} how?`}
      by={`${name} · on its screen`}
      actions={
        <>
          <Button size="xl" variant="tint" onClick={() => void start()} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Start
          </Button>
          <Button size="xl" variant="outline" onClick={() => void discard().catch(() => undefined)} disabled={busy}>
            Not now
          </Button>
        </>
      }
      note={NEVER_KEPT}
    >
      <p className="text-[14px]">I&apos;ll watch while you do it once on my screen, then turn it into steps I can repeat. Up to {Math.round(teaching.maxMs / 60_000)} minutes.</p>
    </ActionCard>
  );
}

function Recording({ teaching, bot, icon }: CardProps) {
  const { done, resume } = useTeachActions(teaching);
  const last = teaching.steps.at(-1);
  return (
    <ActionCard
      icon={icon}
      title={`Showing ${bot?.name ?? "the bot"} how`}
      by={last ? `Last: ${last.label}` : "Waiting for the first step"}
      needs={false}
      actions={
        <>
          <Button size="xl" variant="tint" onClick={() => openScreen(teaching.botId)}>
            Open the screen
          </Button>
          {teaching.status === "paused" ? (
            <Button size="xl" variant="outline" onClick={() => void resume().catch(() => undefined)}>
              Resume
            </Button>
          ) : null}
          <Button size="xl" variant="outline" onClick={() => void done().catch(() => undefined)}>
            Done
          </Button>
        </>
      }
    >
      <RecordingPill teaching={teaching} className="self-start" />
    </ActionCard>
  );
}

/** What was typed outside the browser, where a password can't be told from a command: the person hides what's private first. */
function Review({ teaching, bot }: CardProps) {
  const put = usePutTeaching();
  const { discard } = useTeachActions(teaching);
  const outside = teaching.steps.filter((step) => step.outside);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const name = bot?.name ?? "the bot";
  const look = async () => {
    setBusy(true);
    try {
      const data = await post<{ teaching: Teaching }>(`/api/teachings/${teaching.id}/look`, { hidden: [...hidden] });
      put(data.teaching);
    } catch (failure) {
      failed("Couldn't hand it over. Try again.")(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ActionCard
      icon={<Eye aria-hidden="true" />}
      title={`Before ${name} looks`}
      by={`${teaching.steps.length} steps · ${clock(teaching.activeMs)}`}
      actions={
        <>
          <Button size="xl" variant="tint" onClick={() => void look()} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Let {name} look
          </Button>
          <Button size="xl" variant="outline" onClick={() => setAsking(true)} disabled={busy}>
            Discard
          </Button>
        </>
      }
      note={NEVER_KEPT}
    >
      <p className="text-[13.5px] text-muted-foreground">You typed these outside the browser, where I can&apos;t tell a password from a command. Hide anything private and {name} won&apos;t see it.</p>
      <ul className="flex flex-col gap-1.5">
        {outside.map((step) => {
          const isHidden = hidden.has(step.n);
          return (
            <li key={step.n} className="flex items-center gap-3 rounded-2xl bg-background px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-muted-foreground">{step.app || "An app"}</span>
                <span className={cn("block text-[13px] [overflow-wrap:anywhere]", isHidden ? "text-muted-foreground" : "font-mono")}>{isHidden ? `Hidden from ${name}` : (step.text ?? step.label)}</span>
              </span>
              <Toggle
                variant="pill"
                pressed={isHidden}
                onPressedChange={(pressed) =>
                  setHidden((current) => {
                    const next = new Set(current);
                    if (pressed) next.add(step.n);
                    else next.delete(step.n);
                    return next;
                  })
                }
                className="shrink-0 px-3.5"
              >
                {isHidden ? "Hidden" : "Hide"}
              </Toggle>
            </li>
          );
        })}
      </ul>
      <Confirm open={asking} onOpenChange={setAsking} title="Discard what you showed?" description={`${name} won't learn anything from it, and the recording is deleted.`} action="Discard" onConfirm={discard} />
    </ActionCard>
  );
}

function Ready({ teaching, bot, icon }: CardProps) {
  const put = usePutTeaching();
  const draft = teaching.draft!;
  const name = bot?.name ?? "the bot";
  const [busy, setBusy] = useState<"try" | "save" | "revise" | null>(null);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const frameOf = (n: number | null) => (n ? (teaching.steps.find((step) => step.n === n)?.frame ?? null) : null);
  const pictures = draft.steps.map((step) => frameOf(step.shows)).filter((n): n is number => n !== null);
  const act = async (kind: "try" | "save" | "revise", body?: unknown) => {
    setBusy(kind);
    try {
      const data = await post<{ teaching: Teaching }>(`/api/teachings/${teaching.id}/${kind}`, body);
      if (kind === "save") cheerOnFold(teaching.id);
      put(data.teaching);
      if (kind === "revise") {
        setRevising(false);
        setNote("");
      }
    } catch (failure) {
      failed(kind === "save" ? "Couldn't save the skill. Try again." : kind === "try" ? "Couldn't start the practice. Try again." : "Couldn't send that. Try again.")(failure);
    } finally {
      setBusy(null);
    }
  };
  const rows = [...(draft.changes.length ? [{ label: "Changes each time", value: draft.changes.join(", ") }] : []), ...(draft.needs.length ? [{ label: "Needs", value: draft.needs.join(", ") }] : [])];
  return (
    <ActionCard
      icon={icon}
      title={draft.name}
      by={`${name} · learned from what you showed it`}
      actions={
        revising ? undefined : (
          <>
            <Button size="xl" variant="tint" onClick={() => void act("try")} disabled={busy !== null}>
              {busy === "try" ? <Spinner data-icon="inline-start" /> : null}
              Try it now
            </Button>
            <Button size="xl" variant="outline" onClick={() => void act("save")} disabled={busy !== null}>
              {busy === "save" ? <Spinner data-icon="inline-start" /> : null}
              Save as skill
            </Button>
            <Button size="xl" variant="outline" onClick={() => setRevising(true)} disabled={busy !== null}>
              Not right
            </Button>
          </>
        )
      }
      note={NEVER_KEPT}
    >
      {teaching.error ? <p className="text-[13px] text-muted-foreground">{teaching.error}</p> : null}
      {draft.description ? <p className="text-[14px]">{draft.description}</p> : null}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-muted-foreground">Steps</span>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil data-icon="inline-start" aria-hidden="true" />
            Edit
          </Button>
        </div>
        <ol className="flex list-none flex-col gap-2 p-0">
          {draft.steps.map((step, index) => {
            const frame = frameOf(step.shows);
            return (
              <li key={`${index}-${step.text}`} className="flex items-center gap-3">
                {frame ? (
                  <button type="button" onClick={() => setViewing(frame)} aria-label={`See step ${index + 1}`} className="h-[45px] w-[72px] shrink-0 overflow-hidden rounded-lg border border-primary-edge bg-card">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a frame from the API, already sized */}
                    <img src={frameUrl(teaching.id, frame)} alt="" className="size-full object-cover" loading="lazy" />
                  </button>
                ) : (
                  <span className="h-[45px] w-[72px] shrink-0 rounded-lg bg-muted" aria-hidden="true" />
                )}
                <span className="w-5 shrink-0 text-[13px] font-semibold tabular-nums">{index + 1}</span>
                <span className="min-w-0 flex-1 text-[14px] [overflow-wrap:anywhere]">{step.text}</span>
              </li>
            );
          })}
        </ol>
      </div>
      {rows.length ? <ActionRows rows={rows} /> : null}
      {revising ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void act("revise", { note });
          }}
        >
          <Field>
            <FieldLabel htmlFor={`revise-${teaching.id}`}>What isn&apos;t right?</FieldLabel>
            <Textarea id={`revise-${teaching.id}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="It should always pick the newest bill" rows={2} />
          </Field>
          <div className="flex gap-2 max-sm:flex-col">
            <Button type="submit" size="xl" variant="tint" className="flex-1" disabled={!note.trim() || busy !== null}>
              {busy === "revise" ? <Spinner data-icon="inline-start" /> : null}
              Send to {name}
            </Button>
            <Button type="button" size="xl" variant="outline" className="flex-1" onClick={() => setRevising(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <FrameViewer teaching={teaching} frames={pictures} at={viewing} onAt={setViewing} />
      {editing ? <EditDraft teaching={teaching} draft={draft} onClose={() => setEditing(false)} /> : null}
    </ActionCard>
  );
}

/** A recording's pictures at full size, one at a time. */
function FrameViewer({ teaching, frames, at, onAt }: { teaching: Teaching; frames: number[]; at: number | null; onAt: (n: number | null) => void }) {
  const index = at === null ? -1 : frames.indexOf(at);
  const step = teaching.steps.find((s) => s.frame === at);
  return (
    <Dialog open={at !== null} onOpenChange={(open) => !open && onAt(null)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{step ? step.label : "What you showed"}</DialogTitle>
        </DialogHeader>
        {at !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- a frame from the API
          <img src={frameUrl(teaching.id, at)} alt={step?.label ?? "A moment of the recording"} className="w-full rounded-lg border border-primary-edge" />
        ) : null}
        {frames.length > 1 ? (
          <DialogFooter>
            <Button size="lg" variant="outline" disabled={index <= 0} onClick={() => onAt(frames[index - 1] ?? null)}>
              <ChevronLeft data-icon="inline-start" aria-hidden="true" />
              Before
            </Button>
            <Button size="lg" variant="outline" disabled={index >= frames.length - 1} onClick={() => onAt(frames[index + 1] ?? null)}>
              After
              <ChevronRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Changing the draft by hand: its name, its steps one per line, and its instructions. */
function EditDraft({ teaching, draft, onClose }: { teaching: Teaching; draft: TeachDraft; onClose: () => void }) {
  const put = usePutTeaching();
  const [name, setName] = useState(draft.name);
  const [steps, setSteps] = useState(draft.steps.map((step) => step.text).join("\n"));
  const [instructions, setInstructions] = useState(draft.instructions);
  const [busy, setBusy] = useState(false);
  const discard = useDiscardChanges(!busy && (name !== draft.name || steps !== draft.steps.map((step) => step.text).join("\n") || instructions !== draft.instructions), onClose);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const lines = steps.split("\n").map((line) => line.trim()).filter(Boolean);
      const kept = lines.map((text, index) => ({ text, shows: draft.steps.find((step) => step.text === text)?.shows ?? draft.steps[index]?.shows ?? null }));
      const data = await api<{ teaching: Teaching }>(`/api/teachings/${teaching.id}/draft`, { method: "PUT", body: JSON.stringify({ ...draft, name, steps: kept, instructions }) });
      put(data.teaching);
      onClose();
    } catch (failure) {
      failed("Couldn't save your changes. Try again.")(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && discard.requestClose()}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={save} className="contents">
          <DialogHeader>
            <DialogTitle>Edit the steps</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="teach-name">Name</FieldLabel>
              <Input id="teach-name" value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="teach-steps">Steps</FieldLabel>
              <Textarea id="teach-steps" value={steps} onChange={(event) => setSteps(event.target.value)} rows={6} />
              <FieldDescription>One step per line.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="teach-instructions">Instructions</FieldLabel>
              <Textarea id="teach-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={8} />
              <FieldDescription>What the skill tells a bot to do, in full.</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" size="lg" variant="outline" onClick={discard.requestClose}>
              Cancel
            </Button>
            <Button type="submit" size="lg" variant="tint" disabled={busy || !name.trim() || !steps.trim() || !instructions.trim()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </form>
        {discard.prompt}
      </DialogContent>
    </Dialog>
  );
}
