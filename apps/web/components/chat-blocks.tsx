"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { ArrowUp, Check, ChevronLeft, Info, PencilLine, TriangleAlert, X } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { answerLine, answerOf, namedIn, pickedIn, questionAnswers, type ChoiceAnswer } from "@/lib/choices";
import type { Badge as BadgeRecord, ChoiceRow, Meter as MeterRecord, Tone } from "@/lib/markdown";
import { cn } from "@/lib/utils";

const ICONS: Record<Tone, ReactNode> = {
  ok: <Check aria-hidden="true" />,
  warn: <TriangleAlert aria-hidden="true" />,
  bad: <X aria-hidden="true" />,
  info: <Info aria-hidden="true" />,
  neutral: null,
};

const TEXT: Record<Tone, string> = {
  ok: "text-tone-ok",
  warn: "text-tone-warn",
  bad: "text-tone-bad",
  info: "text-tone-info",
  neutral: "text-foreground",
};

export function StatusBadge({ badge, children }: { badge: BadgeRecord; children: ReactNode }) {
  return (
    <Badge tone={badge.tone} wrap>
      {ICONS[badge.tone]}
      <span className="min-w-0 break-words">{children}</span>
    </Badge>
  );
}

export function Meter({ meter, children }: { meter: MeterRecord; children: ReactNode }) {
  const caption = meter.left || meter.right;
  return (
    <ProgressPrimitive.Root value={meter.percent} data-slot="meter" className="flex flex-col gap-1.5 py-0.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <ProgressPrimitive.Label className="min-w-0 font-medium [overflow-wrap:anywhere]">{children}</ProgressPrimitive.Label>
        <span className={cn("min-w-0 text-[13px] font-medium tabular-nums", TEXT[meter.tone])}>{meter.text}</span>
      </div>
      <ProgressTrack className="h-1.5 rounded-full">
        <ProgressIndicator tone={meter.tone} className="rounded-full" />
      </ProgressTrack>
      {caption ? (
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[12px] leading-4 text-muted-foreground tabular-nums">
          {meter.left ? <span className="min-w-0">{meter.left}</span> : null}
          {meter.right ? <span className={cn("min-w-0", !meter.left && "ml-auto")}>{meter.right}</span> : null}
        </div>
      ) : null}
    </ProgressPrimitive.Root>
  );
}

export const ChoicesContext = createContext<{ pick?: (option: string) => Promise<void>; answer?: ChoiceAnswer }>({});

const PILL = "h-auto min-h-9 max-w-full py-1.5 text-left leading-5 whitespace-normal [overflow-wrap:anywhere]";
const OWN_MAX = 500;

function OptionPills({ row, chosen, open, label, onTap, onOther }: { row: ChoiceRow; chosen: readonly string[]; open: boolean; label: string; onTap: (option: string) => void; onOther: (() => void) | null }) {
  return (
    <div data-slot="choices" role="group" aria-label={label} className="flex flex-wrap gap-2 pt-1 select-none">
      {row.options.map((option) => {
        const on = chosen.includes(option);
        return (
          <Button key={option} type="button" size="lg" variant={on ? "control" : open ? "default" : "outline"} disabled={!open} aria-pressed={on} className={cn(PILL, on && "disabled:opacity-100")} onClick={() => onTap(option)}>
            {option}
          </Button>
        );
      })}
      {open && onOther ? (
        <Button type="button" size="lg" variant="outline" className={PILL} onClick={onOther}>
          <PencilLine aria-hidden="true" />
          Something else
        </Button>
      ) : null}
    </div>
  );
}

/**
 * "Something else": a field for an answer in their own words, opened by a tap, so it takes focus then.
 * Enter does what `done` names; it has a button of its own only where nothing else under it does that.
 */
function OwnAnswer({ value, onChange, onDone, onClose, done, disabled }: { value: string; onChange: (value: string) => void; onDone: () => void; onClose: () => void; done: string | null; disabled: boolean }) {
  return (
    <InputGroup variant="pill" className="min-h-11 rounded-full">
      <InputGroupInput
        autoFocus
        value={value}
        maxLength={OWN_MAX}
        enterKeyHint="send"
        placeholder="Your own answer"
        aria-label="Your own answer"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (value.trim()) onDone();
        }}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-sm" aria-label="Close" className="rounded-full" disabled={disabled} onClick={onClose}>
          <X aria-hidden="true" />
        </InputGroupButton>
        {done ? (
          <InputGroupButton variant="tint" size="icon-sm" aria-label={done} className="rounded-full" disabled={disabled || !value.trim()} onClick={onDone}>
            <ArrowUp aria-hidden="true" />
          </InputGroupButton>
        ) : null}
      </InputGroupAddon>
    </InputGroup>
  );
}

export function Choices({ row }: { row: ChoiceRow }) {
  const { pick, answer } = useContext(ChoicesContext);
  const [sending, setSending] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState<string | null>(null);
  const answered = answer?.picks.findLast((said) => pickedIn(said, row.options, row.multi)) ?? null;
  const open = Boolean(pick) && !answered && (answer?.closedBy ?? null) === null;
  const said = sending ?? answered ?? answer?.closedBy ?? null;
  const chosen = open && !sending ? picked : said ? (pickedIn(said, row.options, row.multi) ?? namedIn(said, row.options)) : [];
  const send = (text: string) => {
    if (!pick || sending || !text) return;
    setSending(text);
    void pick(text).finally(() => setSending(null));
  };
  const words = own ?? "";
  const ready = picked.length > 0 || Boolean(words.trim());
  return (
    <div className="flex flex-col gap-2">
      <OptionPills
        row={row}
        chosen={chosen}
        open={open && !sending}
        label={row.multi ? "Choices, pick any" : "Choices"}
        onTap={(option) => (row.multi ? setPicked((current) => (current.includes(option) ? current.filter((o) => o !== option) : [...current, option])) : send(option))}
        onOther={row.other && own === null ? () => setOwn("") : null}
      />
      {open && own !== null ? <OwnAnswer value={words} onChange={setOwn} onClose={() => setOwn(null)} onDone={() => send(answerOf(row.options, picked, words, row.multi))} done={row.multi ? null : "Send"} disabled={Boolean(sending)} /> : null}
      {open && row.multi ? (
        <Button type="button" size="lg" variant="tint" className="self-start" disabled={!ready || Boolean(sending)} onClick={() => send(answerOf(row.options, picked, words, true))}>
          {sending ? <Spinner /> : null}
          Send
        </Button>
      ) : null}
    </div>
  );
}

export type QuestionStep = { asks: ReactNode; text: string; row: ChoiceRow };
type Given = { picked: string[]; own: string | null };
const UNANSWERED: Given = { picked: [], own: null };

export function Questions({ questions }: { questions: QuestionStep[] }) {
  const { pick, answer } = useContext(ChoicesContext);
  const [step, setStep] = useState(0);
  const [given, setGiven] = useState<Given[]>([]);
  const [sending, setSending] = useState(false);
  const closedBy = answer?.closedBy ?? null;
  const open = Boolean(pick) && closedBy === null;
  const texts = questions.map((question) => question.text);

  if (closedBy !== null) {
    const answers = questionAnswers(texts, closedBy);
    return (
      <div data-slot="questions" className="flex flex-col gap-2.5">
        {questions.map((question, index) => (
          <div key={index} className="flex flex-col gap-0.5">
            <div className="text-[13px] leading-5 text-muted-foreground">{question.asks}</div>
            {answers[index] ? <p className="font-medium [overflow-wrap:anywhere]">{answers[index]}</p> : null}
          </div>
        ))}
      </div>
    );
  }

  // A message still being written can gain questions; each starts unanswered.
  const all = questions.map((_, index) => given[index] ?? UNANSWERED);
  const current = Math.min(step, questions.length - 1);
  const question = questions[current]!;
  const mine = all[current]!;
  const words = mine.own ?? "";
  const answerAt = (index: number) => answerOf(questions[index]!.row.options, all[index]!.picked, all[index]!.own ?? "", questions[index]!.row.multi);
  const complete = questions.every((_, index) => answerAt(index));
  const last = current === questions.length - 1;
  const change = (next: Given) => setGiven(all.map((entry, index) => (index === current ? next : entry)));
  const forward = () => {
    if (!last) return setStep(current + 1);
    if (!pick || sending || !complete) return;
    setSending(true);
    void pick(questions.map((q, index) => answerLine(q.text, answerAt(index))).join("\n")).finally(() => setSending(false));
  };
  const live = open && !sending;
  return (
    <div data-slot="questions" role="group" aria-label={`Question ${current + 1} of ${questions.length}`} className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 font-medium text-muted-foreground tabular-nums">
        {current + 1} of {questions.length}
      </p>
      <div className="flex flex-col gap-2">{question.asks}</div>
      <OptionPills
        row={question.row}
        chosen={mine.own?.trim() && !question.row.multi ? [] : mine.picked}
        open={live}
        label={question.row.multi ? "Choices, pick any" : "Choices"}
        onTap={(option) => {
          if (question.row.multi) return change({ ...mine, picked: mine.picked.includes(option) ? mine.picked.filter((o) => o !== option) : [...mine.picked, option] });
          change({ picked: [option], own: null });
          if (!last) setStep(current + 1);
        }}
        onOther={question.row.other && mine.own === null ? () => change({ ...mine, own: "" }) : null}
      />
      {live && mine.own !== null ? (
        <OwnAnswer
          key={current}
          value={words}
          onChange={(own) => change({ picked: question.row.multi ? mine.picked : [], own })}
          onClose={() => change({ ...mine, own: null })}
          onDone={forward}
          done={null}
          disabled={sending}
        />
      ) : null}
      {open ? (
        <div className="flex items-center gap-2 pt-1">
          {current > 0 ? (
            <Button type="button" size="lg" variant="ghost" disabled={sending} onClick={() => setStep(current - 1)}>
              <ChevronLeft aria-hidden="true" />
              Back
            </Button>
          ) : null}
          <Button type="button" size="lg" variant={last ? "tint" : "outline"} className="ml-auto" disabled={sending || !answerAt(current) || (last && !complete)} onClick={forward}>
            {sending ? <Spinner /> : null}
            {last ? "Send" : "Next"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
