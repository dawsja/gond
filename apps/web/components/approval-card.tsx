"use client";

import { bareToolName, emailDraftOf, ruleLabel, type Approval, type ApprovalAnswer, type Bot, type Message } from "@gond/shared";
import { CreditCard, FilePen, Globe, KeyRound, LogIn, Monitor, Plug, Send, ShieldQuestion, SquareTerminal, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ActionCard, ActionCardDone, ActionCode, ActionRows, cheerOnFold, type ActionItem, type ActionRow, NOBODY_ANSWERED } from "@/components/action-card";
import { EmailApprovalCard } from "@/components/email-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type Decision = ApprovalAnswer["decision"];

type Shape = { icon: ReactNode; title: string; by: string; body: ReactNode; allow: string; deny: string; always: boolean; note?: string; allowed?: string; denied?: string };

const KIND_ICONS: Record<string, ReactNode> = {
  purchase: <CreditCard aria-hidden="true" />,
  send: <Send aria-hidden="true" />,
  delete: <Trash2 aria-hidden="true" />,
  publish: <Globe aria-hidden="true" />,
};

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function itemsOf(value: unknown): ActionItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const label = item && typeof item === "object" ? text((item as ActionItem).label) : null;
    return label ? [{ label, value: text((item as ActionItem).value) ?? "", note: text((item as ActionItem).note) ?? undefined }] : [];
  });
}

function rowsOf(value: unknown): ActionRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const label = text((row as ActionRow).label);
    if (!label) return [];
    const items = itemsOf((row as ActionRow).items);
    return [{ label, value: text((row as ActionRow).value) ?? "", ...(items.length ? { items } : {}) }];
  });
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
    case "forget_secret":
      return { ...base, icon: <KeyRound aria-hidden="true" />, title: "Delete a saved secret?", by: text(input.reason) ? `${name} · ${text(input.reason)}` : name, body: <ActionCode>{text(input.name) ?? message.body}</ActionCode>, allow: "Delete", deny: "Keep it", always: false, allowed: "Deleted", denied: "Kept" };
    case "request_login":
      return { ...base, icon: <LogIn aria-hidden="true" />, title: "Use your saved sign-in?", by: text(input.site) ? `${name} · ${text(input.site)}` : name, body: null };
    case "add_mcp_server":
      return { ...base, icon: <Plug aria-hidden="true" />, title: "Add an MCP server?", by: `${name} · for all your bots`, body: <ActionCode>{text(input.url) ?? message.body}</ActionCode>, always: false };
    default:
      return { ...base, icon: /^[A-Z0-9]+_|^mcp__/.test(tool) ? <Plug aria-hidden="true" /> : <ShieldQuestion aria-hidden="true" />, title: sentence(message.body), by: name, body: null };
  }
}

export function ApprovalCard({ message, approval, bot, noticed = false, onDecide }: { message: Message; approval: Approval | null; bot: Bot | undefined; noticed?: boolean; onDecide: (id: string, answer: ApprovalAnswer) => Promise<void> }) {
  const email = approval ? emailDraftOf(approval.tool, approval.input) : null;
  if (approval && email) return <EmailApprovalCard message={message} approval={approval} email={email} bot={bot} noticed={noticed} onDecide={onDecide} />;
  return <ToolApprovalCard message={message} approval={approval} bot={bot} noticed={noticed} onDecide={onDecide} />;
}

function ToolApprovalCard({ message, approval, bot, noticed, onDecide }: { message: Message; approval: Approval | null; bot: Bot | undefined; noticed: boolean; onDecide: (id: string, answer: ApprovalAnswer) => Promise<void> }) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const status = approval?.status ?? "pending";
  const shape = shapeOf(message, approval, bot?.name ?? "A bot");
  const decide = async (decision: Decision) => {
    if (!message.approvalId || busy) return;
    setBusy(decision);
    if (decision !== "deny") cheerOnFold(message.id);
    try {
      await onDecide(message.approvalId, { decision });
    } finally {
      setBusy(null);
    }
  };
  if (status !== "pending") {
    const custom = approval?.tool === "ask_approval";
    const done =
      status === "allowed"
        ? { status: approval?.rule ? "Always" : (shape.allowed ?? (custom ? shape.allow : "Allowed")), tone: "ok" as const }
        : status === "denied"
          ? { status: shape.denied ?? (custom ? shape.deny : "Denied"), tone: shape.denied ? ("neutral" as const) : ("bad" as const) }
          : { status: "Expired", tone: "neutral" as const };
    const title = shape.title;
    const by = approval?.rule ? `From now on: ${ruleLabel(approval.rule)}` : status === "expired" ? NOBODY_ANSWERED : shape.by;
    return <ActionCardDone id={message.id} bot={bot} icon={shape.icon} title={title} by={by} status={done.status} tone={done.tone} />;
  }
  return (
    <ActionCard
      noticed={noticed}
      icon={shape.icon}
      title={shape.title}
      by={shape.by}
      note={shape.note}
      actions={
        <>
          <Button size="xl" variant="tint" className="w-full" disabled={Boolean(busy)} onClick={() => void decide("allow")}>
            {busy === "allow" ? <Spinner data-icon="inline-start" /> : null}
            {shape.allow}
          </Button>
          {shape.always ? (
            <Button size="xl" variant="outline" className="w-full" disabled={Boolean(busy)} onClick={() => void decide("always")}>
              {busy === "always" ? <Spinner data-icon="inline-start" /> : null}
              Always allow
            </Button>
          ) : null}
          <Button size="xl" variant="outline" className={cn("w-full", approval?.tool !== "ask_approval" && !shape.denied && "text-destructive")} disabled={Boolean(busy)} onClick={() => void decide("deny")}>
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
