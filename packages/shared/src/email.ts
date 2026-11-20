import type { EmailEdit } from "./approvals.ts";
import { appAction, bareToolName } from "./tools.ts";

/** An email a connected app is about to send, read from the action's own input. */
export type EmailDraft = {
  mode: "send" | "reply" | "forward" | "draft";
  app: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  body: string | null;
  files: string[];
};

const EMAIL_APPS: Record<string, string> = { GMAIL: "Gmail", OUTLOOK: "Outlook" };
// Composio's mail actions name the same thing several ways across apps and versions.
const EMAIL_FIELDS = {
  to: ["recipient_email", "to_email", "to", "recipient", "recipients", "to_recipients", "extra_recipients", "to_emails"],
  cc: ["cc", "cc_emails", "cc_recipients"],
  bcc: ["bcc", "bcc_emails", "bcc_recipients"],
  subject: ["subject"],
  body: ["body", "message_body", "comment", "content", "html_body", "text", "additional_text", "message"],
  files: ["attachment", "attachments"],
} as const;

function emailList(input: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") for (const part of value.split(/[,;]/)) part.trim() && out.push(part.trim());
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") {
      const entry = value as { email?: unknown; address?: unknown; name?: unknown; emailAddress?: unknown };
      if (entry.emailAddress) return add(entry.emailAddress);
      const address = typeof entry.email === "string" ? entry.email : typeof entry.address === "string" ? entry.address : null;
      if (address) out.push(typeof entry.name === "string" && entry.name.trim() ? `${entry.name.trim()} <${address}>` : address);
    }
  };
  for (const key of keys) add(input[key]);
  return [...new Set(out)];
}

function emailFiles(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim().split(/[\\/]/).pop() ?? value.trim());
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") {
      const file = value as { name?: unknown; filename?: unknown; path?: unknown };
      add(typeof file.name === "string" ? file.name : typeof file.filename === "string" ? file.filename : file.path);
    }
  };
  for (const key of EMAIL_FIELDS.files) add(input[key]);
  return out;
}

/** HTML a bot wrote as an email body, as the words and line breaks a person reads; never markup. */
export function emailText(body: string): string {
  if (!/<[a-z][\s\S]*>/i.test(body)) return body.trim();
  return body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6])>/gi, "\n\n")
    .replace(/<\/(div|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function emailMode(tool: string): { app: string; mode: EmailDraft["mode"] } | null {
  const { action, server } = appAction(tool);
  const name = action.toUpperCase();
  // An MCP server's tool may name the app (gmail_send) or leave it to the server (a "gmail" server's send_email).
  const app = EMAIL_APPS[name.split("_")[0] ?? ""] ?? (server ? EMAIL_APPS[server.split("_")[0] ?? ""] : undefined);
  if (!app) return null;
  const word = (w: string) => new RegExp(`(^|_)${w}(_|$)`).test(name);
  // A draft reply (Outlook's CREATE_DRAFT_REPLY) only saves; sending a saved draft names nothing to show.
  const mode = word("DRAFT") && !word("SEND") ? "draft" : word("REPLY") ? "reply" : word("FORWARD") ? "forward" : word("SEND") ? "send" : null;
  return mode ? { app, mode } : null;
}

export function emailDraftOf(tool: string, input: Record<string, unknown>): EmailDraft | null {
  const { app, mode } = emailMode(tool) ?? {};
  if (!app || !mode) return null;
  const to = emailList(input, EMAIL_FIELDS.to);
  const rawBody = EMAIL_FIELDS.body.map((key) => input[key]).find((value): value is string => typeof value === "string" && value.trim() !== "");
  const subject = typeof input.subject === "string" && input.subject.trim() ? input.subject.trim() : null;
  // A send that only names a saved draft carries nothing to show; the plain card says what it is.
  if (!to.length && !rawBody && !subject) return null;
  return { mode, app, to, cc: emailList(input, EMAIL_FIELDS.cc), bcc: emailList(input, EMAIL_FIELDS.bcc), subject, body: rawBody ? emailText(rawBody) : null, files: emailFiles(input) };
}

/** Only a connected app's own action (a Composio slug) can be edited or sent from its card; Gond runs it. */
export function emailEditable(tool: string): boolean {
  return !tool.startsWith("mcp__") && emailMode(tool) !== null;
}

/** The app's action that sends a saved draft, and the input naming it, for a draft card's Send. */
export function sendDraftAction(tool: string): { slug: string; idKey: string } | null {
  if (!emailEditable(tool) || emailMode(tool)?.mode !== "draft") return null;
  const name = tool.toUpperCase();
  if (name.startsWith("GMAIL_")) return { slug: "GMAIL_SEND_DRAFT", idKey: "draft_id" };
  if (name.startsWith("OUTLOOK_")) return { slug: "OUTLOOK_SEND_DRAFT", idKey: "message_id" };
  return null;
}

/**
 * The id of the draft an app just saved, from what its action answered: Gmail answers the draft
 * (`id`, its message under it), Outlook the draft message (`id`), either sometimes wrapped.
 */
export function draftIdOf(result: unknown): string | null {
  const seen: unknown[] = [result];
  for (let depth = 0; depth < 3 && seen.length; depth += 1) {
    const level = seen.splice(0);
    for (const value of level) {
      if (typeof value === "string") {
        try {
          seen.push(JSON.parse(value));
        } catch {
          /* not JSON */
        }
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      for (const key of ["draft_id", "draftId", "id"]) if (typeof entry[key] === "string" && (entry[key] as string).trim()) return (entry[key] as string).trim();
      for (const key of ["data", "response_data", "draft", "result"]) if (entry[key] !== undefined) seen.push(entry[key]);
    }
  }
  return null;
}

/** The address in "Dana Ruiz <dana@ruizdesign.co>", or the text as it is. */
export function emailAddress(recipient: string): string {
  return /<([^<>\s]+@[^<>\s]+)>/.exec(recipient)?.[1] ?? recipient.trim();
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The action's input with the person's edits written back where the letter came from: a field
 * keeps its key and its shape (a string, a list, Gmail's first address apart from the rest,
 * Graph's `{ emailAddress }`), and a field they didn't change is left exactly as it was.
 */
export function editedEmailInput(tool: string, input: Record<string, unknown>, edit: EmailEdit): Record<string, unknown> {
  const draft = emailDraftOf(tool, input);
  const out: Record<string, unknown> = { ...input };
  const name = bareToolName(tool).toUpperCase();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => emailAddress(value) === emailAddress(b[i]!));
  const writeList = (keys: readonly string[], shown: string[], next: string[], fallback: string) => {
    if (same(shown, next)) return;
    const present = keys.filter((key) => input[key] !== undefined && input[key] !== null && input[key] !== "");
    for (const key of present) delete out[key];
    const addresses = next.map(emailAddress);
    if (present.includes("recipient_email") || (!present.length && fallback === "recipient_email")) {
      if (addresses[0]) out.recipient_email = addresses[0];
      if (addresses.length > 1) out.extra_recipients = addresses.slice(1);
      return;
    }
    const key = present[0] ?? fallback;
    const was = input[key];
    const sample = Array.isArray(was) ? was[0] : was;
    if (typeof was === "string") out[key] = addresses.join(", ");
    else if (sample && typeof sample === "object" && "emailAddress" in sample) out[key] = addresses.map((address) => ({ emailAddress: { address } }));
    else if (sample && typeof sample === "object") out[key] = addresses.map((email) => ({ email }));
    else out[key] = addresses;
  };
  const gmail = name.startsWith("GMAIL_");
  writeList(EMAIL_FIELDS.to, draft?.to ?? [], edit.to, gmail ? "recipient_email" : /SEND_EMAIL/.test(name) ? "to" : "to_recipients");
  writeList(EMAIL_FIELDS.cc, draft?.cc ?? [], edit.cc, gmail ? "cc" : /DRAFT$/.test(name) ? "cc_recipients" : "cc_emails");
  writeList(EMAIL_FIELDS.bcc, draft?.bcc ?? [], edit.bcc, gmail ? "bcc" : /DRAFT$/.test(name) ? "bcc_recipients" : "bcc_emails");
  if (edit.subject.trim() !== (draft?.subject ?? "")) out.subject = edit.subject.trim();
  if (edit.body.trim() !== (draft?.body ?? "").trim()) {
    const key = EMAIL_FIELDS.body.find((k) => typeof input[k] === "string" && (input[k] as string).trim() !== "") ?? (/REPLY_TO_THREAD/.test(name) ? "message_body" : /DRAFT_REPLY|REPLY_EMAIL/.test(name) ? "comment" : "body");
    // The person edited words, not markup: HTML in, HTML out, their line breaks kept.
    out[key] = input.is_html === true ? escapeHtml(edit.body.trim()).replace(/\r?\n/g, "<br>") : edit.body.trim();
  }
  return out;
}

export type DiffPart = { text: string; change: "same" | "added" | "removed" };

/** A word-by-word diff of two drafts, for a redraft's marks: spaces go with the word before them, line breaks stand alone. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const split = (text: string) => text.match(/\S+[^\S\n]*|\s+/g) ?? [];
  const a = split(before);
  const b = split(after);
  // Past this a redraft is a new letter; marking every word says nothing.
  if (a.length * b.length > 250_000) return [{ text: after, change: "same" }];
  const key = (word: string) => word.trim();
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) lcs[i]![j] = key(a[i]!) === key(b[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const parts: DiffPart[] = [];
  const push = (text: string, change: DiffPart["change"]) => {
    const last = parts.at(-1);
    if (last?.change === change) last.text += text;
    else parts.push({ text, change });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]!) === key(b[j]!)) {
      push(b[j]!, "same");
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) push(a[i++]!, "removed");
    else push(b[j++]!, "added");
  }
  return parts;
}

/** "Dana Ruiz <dana@ruizdesign.co>" is Dana Ruiz to a person; a bare address stays an address. */
export function emailName(recipient: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(recipient);
  return match?.[1]?.trim() || recipient.trim();
}
