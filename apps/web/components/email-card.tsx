"use client";

import { emailAddress, emailDraftOf, emailEditable, emailName, sendDraftAction, wordDiff, type Approval, type ApprovalAnswer, type Bot, type EmailDraft, type EmailEdit, type Message } from "@gond/shared";
import { ArrowUp, ChevronDown, ChevronUp, CornerUpLeft, Forward, Mail, NotebookPen, Paperclip, Pencil, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ActionCard, ActionCardDone, cheerOnFold, NOBODY_ANSWERED, SET_ASIDE } from "@/components/action-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const BODY_LINES = 6;

export const EMAIL_WORDS: Record<EmailDraft["mode"], { title: string; allow: string; deny: string; done: string; allowed: string; denied: string }> = {
  send: { title: "Send this email?", allow: "Send", deny: "Don't send", done: "Email sent", allowed: "Sent", denied: "Not sent" },
  reply: { title: "Send this reply?", allow: "Send", deny: "Don't send", done: "Reply sent", allowed: "Sent", denied: "Not sent" },
  forward: { title: "Forward this email?", allow: "Forward", deny: "Don't forward", done: "Email forwarded", allowed: "Forwarded", denied: "Not forwarded" },
  draft: { title: "Save this draft?", allow: "Save draft", deny: "Don't save", done: "Draft saved", allowed: "Saved", denied: "Not saved" },
};

const EMAIL_ICONS: Record<EmailDraft["mode"], ReactNode> = { send: <Mail aria-hidden="true" />, reply: <CornerUpLeft aria-hidden="true" />, forward: <Forward aria-hidden="true" />, draft: <NotebookPen aria-hidden="true" /> };

/** "To Dana Ruiz and 2 more · Launch plan", for the line a card folds to. */
export function emailGist(draft: EmailDraft): string {
  const people = [...draft.to, ...draft.cc, ...draft.bcc];
  const who = people.length ? `To ${emailName(people[0])}${people.length > 1 ? ` and ${people.length - 1} more` : ""}` : draft.app;
  return draft.subject ? `${who} · ${draft.subject}` : who;
}

/** A redraft's words, what it added on a green wash and what it took out struck through. */
function Marked({ before, after }: { before: string | null; after: string }) {
  if (before === null || before === after) return <>{after}</>;
  const parts = wordDiff(before, after);
  return (
    <>
      {parts.map((part, i) =>
        part.change === "removed" && parts[i + 1]?.change === "added" && !/\s$/.test(part.text) ? (
          // What it took out and what it put in its place read as two words, not one.
          <span key={i}>
            <del className="rounded-[4px] bg-diff-removed text-muted-foreground decoration-tone-bad">{part.text}</del>{" "}
          </span>
        ) : part.change === "added" ? (
          <ins key={i} className="rounded-[4px] bg-diff-added no-underline">
            {part.text}
          </ins>
        ) : part.change === "removed" ? (
          <del key={i} className="rounded-[4px] bg-diff-removed text-muted-foreground decoration-tone-bad">
            {part.text}
          </del>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** The draft as a letter: who it goes to, the subject, the body and its files, exactly as it will go; a redraft marks what changed since `before`. */
export function EmailLetter({ draft, before = null }: { draft: EmailDraft; before?: EmailDraft | null }) {
  const [addresses, setAddresses] = useState(false);
  const [open, setOpen] = useState(false);
  const body = draft.body ?? "";
  const long = body.split("\n").length > BODY_LINES + 2 || body.length > 360;
  const line = (label: string, people: string[]) =>
    people.length ? (
      <div className="flex gap-2 text-[12.5px] leading-5">
        <span className="w-8 shrink-0 text-muted-foreground">{label}</span>
        <span className="min-w-0 wrap-anywhere">{(addresses ? people : people.map(emailName)).join(", ")}</span>
      </div>
    ) : null;
  return (
    <div className="overflow-hidden rounded-2xl border border-primary-edge bg-primary">
      <div className="flex flex-col gap-0.5 border-b border-primary-edge/70 px-3.5 py-2.5">
        {draft.to.length || draft.cc.length || draft.bcc.length ? (
          <button type="button" aria-pressed={addresses} onClick={() => setAddresses((a) => !a)} title={addresses ? "Show names" : "Show the addresses"} className="-mx-1 flex flex-col gap-0.5 rounded-lg px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {line("To", draft.to)}
            {line("Cc", draft.cc)}
            {line("Bcc", draft.bcc)}
          </button>
        ) : null}
        {draft.subject ? (
          <p className="mt-1 text-[14px] leading-5 font-semibold wrap-anywhere">
            <Marked before={before ? (before.subject ?? "") : null} after={draft.subject} />
          </p>
        ) : draft.mode === "reply" ? (
          <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">In the same thread</p>
        ) : null}
      </div>
      {body || draft.files.length ? (
        <div className="flex flex-col gap-3 px-3.5 py-3">
          {body ? (
            <div className="flex flex-col gap-1">
              <p className={cn("text-[13.5px] leading-5 wrap-anywhere whitespace-pre-wrap", long && !open && "line-clamp-6")}>
                <Marked before={before ? (before.body ?? "") : null} after={body} />
              </p>
              {long ? (
                <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex w-fit items-center gap-1 rounded-md text-[12.5px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11">
                  {open ? "Show less" : "Show all"}
                  {open ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
                </button>
              ) : null}
            </div>
          ) : null}
          {draft.files.length ? (
            <div className="flex flex-wrap gap-1.5">
              {draft.files.map((file, i) => (
                <span key={`${file}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary-edge bg-card px-2.5 py-1 text-[12px]">
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{file}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type Fields = { to: string; cc: string; bcc: string; subject: string; body: string };

const fieldsOf = (draft: EmailDraft): Fields => ({ to: draft.to.join(", "), cc: draft.cc.join(", "), bcc: draft.bcc.join(", "), subject: draft.subject ?? "", body: draft.body ?? "" });

const people = (text: string) =>
  text
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const wrongIn = (text: string) => people(text).some((who) => !ADDRESS.test(emailAddress(who)));

function editOf(fields: Fields): EmailEdit {
  return { to: people(fields.to), cc: people(fields.cc), bcc: people(fields.bcc), subject: fields.subject, body: fields.body };
}

/** The letter as fields, for the person to change before it goes. */
function EmailFields({ fields, onChange }: { fields: Fields; onChange: (fields: Fields) => void }) {
  const [copies, setCopies] = useState(Boolean(fields.cc || fields.bcc));
  const set = (key: keyof Fields) => (event: { target: { value: string } }) => onChange({ ...fields, [key]: event.target.value });
  const row = (key: "to" | "cc" | "bcc", label: string, end?: ReactNode) => (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText className="w-7">{label}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput value={fields[key]} onChange={set(key)} aria-label={label} aria-invalid={wrongIn(fields[key]) || undefined} inputMode="email" autoComplete="off" spellCheck={false} />
      {end}
    </InputGroup>
  );
  return (
    <div className="flex flex-col gap-2">
      {row(
        "to",
        "To",
        copies ? null : (
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={() => setCopies(true)}>Cc Bcc</InputGroupButton>
          </InputGroupAddon>
        ),
      )}
      {copies ? row("cc", "Cc") : null}
      {copies ? row("bcc", "Bcc") : null}
      <Input value={fields.subject} onChange={set("subject")} placeholder="Subject" aria-label="Subject" />
      <Textarea value={fields.body} onChange={set("body")} aria-label="Message" className="max-h-96 min-h-40 text-[13.5px] leading-5" />
    </div>
  );
}

/**
 * An email a connected app is about to send or save, as its letter. The person can send it as it
 * is, change it in place first, or send it back with what to change; a draft can go straight out.
 */
export function EmailApprovalCard({ message, approval, email, bot, noticed, onDecide }: { message: Pick<Message, "id">; approval: Approval; email: EmailDraft; bot: Bot | undefined; noticed: boolean; onDecide: (id: string, answer: ApprovalAnswer) => Promise<void> }) {
  const name = bot?.name ?? "A bot";
  const editable = emailEditable(approval.tool);
  const sendsDraft = Boolean(sendDraftAction(approval.tool));
  const words = EMAIL_WORDS[email.mode];
  const before = approval.revises ? emailDraftOf(approval.revises.tool, approval.revises.input) : null;
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<Fields>(() => fieldsOf(email));
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<"send" | "save" | "deny" | "ask" | null>(null);
  const icon = EMAIL_ICONS[email.mode];

  if (approval.status !== "pending") {
    const by = `${emailGist(email)}${approval.edited ? " · Edited by you" : ""}`;
    if (approval.outcome === "changes") return <ActionCardDone id={message.id} bot={bot} icon={icon} title="Changes asked" by={approval.note ?? undefined} status="Sent back" tone="neutral" />;
    if (approval.outcome === "sent") return <ActionCardDone id={message.id} bot={bot} icon={icon} title="Email sent" by={by} status="Sent" tone="ok" />;
    if (approval.status === "allowed") return <ActionCardDone id={message.id} bot={bot} icon={icon} title={words.done} by={by} status={words.allowed} tone="ok" />;
    if (approval.status === "denied") return <ActionCardDone id={message.id} bot={bot} icon={icon} title={words.title} by={emailGist(email)} status={words.denied} tone="bad" />;
    if (approval.outcome === "aside") return <ActionCardDone id={message.id} bot={bot} icon={icon} title={words.title} by={SET_ASIDE.by} status={SET_ASIDE.status} tone="neutral" />;
    return <ActionCardDone id={message.id} bot={bot} icon={icon} title={words.title} by={NOBODY_ANSWERED} status="Expired" tone="neutral" />;
  }

  const changed = editing && JSON.stringify(fields) !== JSON.stringify(fieldsOf(email));
  const wrong = editing && (wrongIn(fields.to) || wrongIn(fields.cc) || wrongIn(fields.bcc));
  const answer = async (kind: NonNullable<typeof busy>, given: ApprovalAnswer) => {
    if (busy) return;
    setBusy(kind);
    if (given.decision === "allow") cheerOnFold(message.id);
    try {
      await onDecide(approval.id, changed ? { ...given, edit: editOf(fields) } : given);
    } finally {
      setBusy(null);
    }
  };
  const button = (kind: NonNullable<typeof busy>, label: string, given: ApprovalAnswer, variant: "tint" | "outline") => (
    <Button size="xl" variant={variant} className="w-full" disabled={Boolean(busy) || (given.decision === "allow" && wrong)} onClick={() => void answer(kind, given)}>
      {busy === kind ? <Spinner data-icon="inline-start" /> : null}
      {label}
    </Button>
  );
  const sendBack = () => {
    const note = ask.trim();
    if (note) void answer("ask", { decision: "deny", note });
  };

  return (
    <ActionCard
      noticed={noticed}
      icon={icon}
      title={words.title}
      by={`${name} · ${email.app}${before ? " · New draft" : ""}`}
      note={sendsDraft ? "It waits in your drafts once you tap Save draft. Send now sends it instead." : email.mode === "draft" ? "Nothing is saved until you tap Save draft." : `Nothing goes out until you tap ${words.allow}.`}
      actions={
        sendsDraft ? (
          // A draft was asked for, so saving it is the main button; sending is the step aside.
          <>
            {button("save", words.allow, { decision: "allow" }, "tint")}
            {button("send", "Send now", { decision: "allow", send: true }, "outline")}
            {button("deny", "Not now", { decision: "deny" }, "outline")}
          </>
        ) : (
          <>
            {button("send", words.allow, { decision: "allow" }, "tint")}
            {button("deny", words.deny, { decision: "deny" }, "outline")}
          </>
        )
      }
    >
      {editing ? <EmailFields fields={fields} onChange={setFields} /> : <EmailLetter draft={email} before={before} />}
      {editable ? (
        <div className="flex items-center gap-2">
          {editing ? (
            <p className="min-w-0 flex-1 text-[12.5px] leading-4 text-muted-foreground">{wrong ? "Check the addresses." : changed ? (email.mode === "draft" ? "What you see is what's saved." : "What you see is what goes.") : email.mode === "draft" ? "Change anything, then save it." : "Change anything, then send it."}</p>
          ) : (
            <form
              className="min-w-0 flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                sendBack();
              }}
            >
              <InputGroup>
                <InputGroupInput value={ask} onChange={(event) => setAsk(event.target.value)} placeholder="Ask for changes" aria-label={`Ask ${name} for changes`} maxLength={2000} disabled={Boolean(busy)} />
                {ask.trim() ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="submit" variant="tint" size="icon-sm" aria-label={`Send to ${name}`} disabled={Boolean(busy)} className="rounded-full">
                      {busy === "ask" ? <Spinner /> : <ArrowUp aria-hidden="true" />}
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            </form>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-lg"
                  variant="outline"
                  aria-label={editing ? "Undo my edits" : "Edit the email"}
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (editing) setFields(fieldsOf(email));
                    setEditing((e) => !e);
                  }}
                  className="pointer-coarse:size-11"
                />
              }
            >
              {editing ? <Undo2 aria-hidden="true" /> : <Pencil aria-hidden="true" />}
            </TooltipTrigger>
            <TooltipContent>{editing ? "Undo my edits" : "Edit the email"}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </ActionCard>
  );
}

