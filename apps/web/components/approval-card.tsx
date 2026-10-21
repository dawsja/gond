"use client";

import { bareToolName, emailDraftOf, ruleLabel, type Approval, type Bot, type Message } from "@gond/shared";
import { CornerUpLeft, CreditCard, FilePen, Forward, Globe, KeyRound, LogIn, Mail, Monitor, NotebookPen, Plug, Send, ShieldQuestion, SquareTerminal, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ActionCard, ActionCardDone, ActionCode, ActionRows } from "@/components/action-card";
import { EMAIL_WORDS, EmailLetter, emailGist } from "@/components/email-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type Decision = "allow" | "deny" | "always";

type Row = { label: string; value: string };

type Shape = { icon: ReactNode; title: string; by: string; body: ReactNode; allow: string; deny: string; always: boolean; note?: string; done?: { title: string; by: string; allowed: string; denied: string } };

const EMAIL_ICONS = { send: <Mail aria-hidden="true" />, reply: <CornerUpLeft aria-hidden="true" />, forward: <Forward aria-hidden="true" />, draft: <NotebookPen aria-hidden="true" /> };

const KIND_ICONS: Record<string, ReactNode> = {
  purchase: <CreditCard aria-hidden="true" />,
  send: <Send aria-hidden="true" />,
  delete: <Trash2 aria-hidden="true" />,
  publish: <Globe aria-hidden="true" />,
};

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function rowsOf(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => (row && typeof row === "object" && text((row as Row).label) ? [{ label: (row as Row).label, value: text((row as Row).value) ?? "" }] : []));
}

function sentence(line: string) {
  const trimmed = line.trim().replace(/[.?]$/, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}?`;
}

/** What the card says for each kind of tool: a question, where it happens, and what exactly. */
function shapeOf(message: Message, approval: Approval | null, name: string): Shape {
  const input = approval?.input ?? {};
  const tool = bareToolName(approval?.tool ?? "");
  const base = { allow: "Allow once", deny: "Deny", always: true };
  const email = emailDraftOf(tool, input);
  if (email) {
    const words = EMAIL_WORDS[email.mode];
    return {
      icon: EMAIL_ICONS[email.mode],
      title: words.title,
      by: `${name} · ${email.app}`,
      body: <EmailLetter draft={email} />,
      allow: words.allow,
      deny: words.deny,
      always: false,
      note: email.mode === "draft" ? `Nothing is saved until you tap Save draft. To change it, tell ${name} what to change.` : `Nothing goes out until you tap ${words.allow}. To change it, tell ${name} what to change.`,
      done: { title: words.done, by: emailGist(email), allowed: words.allowed, denied: words.denied },
    };
  }
  switch (tool) {
    case "ask_approval": {
      const rows = rowsOf(input.details);
      const total = rowsOf([input.total])[0];
      const why = text(input.why);
      return {
        icon: KIND_ICONS[String(input.kind)] ?? <ShieldQuestion aria-hidden="true" />,
        title: text(input.summary) ?? message.body,
        by: why ? `${name} · ${why}` : name,
        body: rows.length || total ? <ActionRows rows={rows} total={total} /> : null,
        allow: text(input.allow) ?? "Allow",
        deny: text(input.deny) ?? "Deny",
        always: false,
      };
    }
    case "Bash":
      return { ...base, icon: <SquareTerminal aria-hidden="true" />, title: "Run a command?", by: `${name} · on the computer`, body: <ActionCode>{text(input.command) ?? message.body}</ActionCode> };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Write":
      return { ...base, icon: <FilePen aria-hidden="true" />, title: tool === "Write" ? "Write a file?" : "Change a file?", by: `${name} · on the computer`, body: <ActionCode>{text(input.file_path) ?? text(input.path) ?? text(input.notebook_path) ?? message.body}</ActionCode> };
    case "computer":
    case "browser":
      return { ...base, icon: <Monitor aria-hidden="true" />, title: "Use the screen?", by: `${name} · for this reply`, body: <p className="text-[13.5px] text-muted-foreground">It will click and type on the computer&apos;s screen. You can watch, and take control at any time.</p> };
    case "type_secret":
      return { ...base, icon: <KeyRound aria-hidden="true" />, title: "Type a saved secret?", by: `${name} · into the screen`, body: <ActionCode>{text(input.name) ?? message.body}</ActionCode>, always: false };
    case "request_login":
      return { ...base, icon: <LogIn aria-hidden="true" />, title: "Use your saved sign-in?", by: text(input.site) ? `${name} · ${text(input.site)}` : name, body: null };
    case "add_mcp_server":
      return { ...base, icon: <Plug aria-hidden="true" />, title: "Add an MCP server?", by: `${name} · for all your bots`, body: <ActionCode>{text(input.url) ?? message.body}</ActionCode>, always: false };
    default:
      return { ...base, icon: /^[A-Z0-9]+_|^mcp__/.test(tool) ? <Plug aria-hidden="true" /> : <ShieldQuestion aria-hidden="true" />, title: sentence(message.body), by: name, body: null };
  }
}

export function ApprovalCard({ message, approval, bot, onDecide }: { message: Message; approval: Approval | null; bot: Bot | undefined; onDecide: (id: string, decision: Decision) => Promise<void> }) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const status = approval?.status ?? "pending";
  const shape = shapeOf(message, approval, bot?.name ?? "A bot");
  const decide = async (decision: Decision) => {
    if (!message.approvalId || busy) return;
    setBusy(decision);
    try {
      await onDecide(message.approvalId, decision);
    } finally {
      setBusy(null);
    }
  };
  if (status !== "pending") {
    const custom = approval?.tool === "ask_approval";
    const done =
      status === "allowed"
        ? { status: approval?.rule ? "Always" : (shape.done?.allowed ?? (custom ? shape.allow : "Allowed")), tone: "ok" as const }
        : status === "denied"
          ? { status: shape.done?.denied ?? (custom ? shape.deny : "Denied"), tone: "bad" as const }
          : { status: "Expired", tone: "neutral" as const };
    const title = status === "allowed" && shape.done ? shape.done.title : shape.title;
    const by = approval?.rule ? `From now on: ${ruleLabel(approval.rule)}` : (shape.done?.by ?? shape.by);
    return <ActionCardDone icon={shape.icon} title={title} by={by} status={done.status} tone={done.tone} />;
  }
  return (
    <ActionCard
      icon={shape.icon}
      title={shape.title}
      by={shape.by}
      note={shape.note}
      actions={
        <>
          <Button size="xl" className="w-full" disabled={Boolean(busy)} onClick={() => void decide("allow")}>
            {busy === "allow" ? <Spinner data-icon="inline-start" /> : null}
            {shape.allow}
          </Button>
          {shape.always ? (
            <Button size="xl" variant="outline" className="w-full" disabled={Boolean(busy)} onClick={() => void decide("always")}>
              {busy === "always" ? <Spinner data-icon="inline-start" /> : null}
              Always
            </Button>
          ) : null}
          <Button size="xl" variant="outline" className={cn("w-full", approval?.tool !== "ask_approval" && !shape.done && "text-destructive")} disabled={Boolean(busy)} onClick={() => void decide("deny")}>
            {busy === "deny" ? <Spinner data-icon="inline-start" /> : null}
            {shape.deny}
          </Button>
        </>
      }
    >
      {shape.body}
    </ActionCard>
  );
}
