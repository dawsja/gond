"use client";

import { emailName, type EmailDraft } from "@gond/shared";
import { ChevronDown, ChevronUp, Paperclip } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const BODY_LINES = 6;

export const EMAIL_WORDS: Record<EmailDraft["mode"], { title: string; allow: string; deny: string; done: string; allowed: string; denied: string }> = {
  send: { title: "Send this email?", allow: "Send", deny: "Don't send", done: "Email sent", allowed: "Sent", denied: "Not sent" },
  reply: { title: "Send this reply?", allow: "Send", deny: "Don't send", done: "Reply sent", allowed: "Sent", denied: "Not sent" },
  forward: { title: "Forward this email?", allow: "Forward", deny: "Don't forward", done: "Email forwarded", allowed: "Forwarded", denied: "Not forwarded" },
  draft: { title: "Save this draft?", allow: "Save draft", deny: "Don't save", done: "Draft saved", allowed: "Saved", denied: "Not saved" },
};

/** "To Dana Ruiz and 2 more · Launch plan", for the line a card folds to. */
export function emailGist(draft: EmailDraft): string {
  const people = [...draft.to, ...draft.cc, ...draft.bcc];
  const who = people.length ? `To ${emailName(people[0])}${people.length > 1 ? ` and ${people.length - 1} more` : ""}` : draft.app;
  return draft.subject ? `${who} · ${draft.subject}` : who;
}

/** The draft as a letter: who it goes to, the subject, the body and its files, exactly as it will go. */
export function EmailLetter({ draft }: { draft: EmailDraft }) {
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
          <p className="mt-1 text-[14px] leading-5 font-semibold wrap-anywhere">{draft.subject}</p>
        ) : draft.mode === "reply" ? (
          <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">In the same thread</p>
        ) : null}
      </div>
      {body || draft.files.length ? (
        <div className="flex flex-col gap-3 px-3.5 py-3">
          {body ? (
            <div className="flex flex-col gap-1">
              <p className={cn("text-[13.5px] leading-5 wrap-anywhere whitespace-pre-wrap", long && !open && "line-clamp-6")}>{body}</p>
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
