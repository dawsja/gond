import { EXPORT_RANGES, isWatchRun, routineName, type Approval, type ApprovalStatus, type ExportRange, type Message, type MessageAuthor } from "@gond/shared";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { getApproval } from "./data/approvals.ts";
import { listBots } from "./data/bots.ts";
import { exportProgress, exportWanted, failExport, finishExport, type ExportJob } from "./data/exports.ts";
import { userTimezone } from "./data/prefs.ts";
import { allSecretValues } from "./data/secrets.ts";
import { getAttachment, getThread, messagesInOrder, threadRefs, type ThreadRef } from "./data/threads.ts";
import { sendPush } from "./push.ts";
import { createRedactor } from "./redact.ts";

/** SQLite holds a blob of at most a billion bytes; an export stops short of that and says so. */
export const MAX_EXPORT_BYTES = 900 * 1024 * 1024;

const FORMAT = "gond-chat/1";

export function exportLabel(chat: string | null, range: ExportRange): string {
  const reach = EXPORT_RANGES.find((r) => r.id === range)!.label;
  return `${chat ?? "All chats"}, ${reach.charAt(0).toLowerCase()}${reach.slice(1)}`;
}

export function exportSince(range: ExportRange, from = new Date()): string | null {
  const days = EXPORT_RANGES.find((r) => r.id === range)!.days;
  return days === null ? null : new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A name that is safe as one part of a path in a zip on any system, its extension kept. */
export function safeName(name: string, fallback = "file"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!cleaned) return fallback;
  if (cleaned.length <= 100) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, 100 - ext.length).trimEnd()}${ext}`;
}

/** `name`, or "name (2).ext" and on, so no two entries in one folder share a name (case aside, for Windows and macOS). */
export function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

const CARD_STATUS: Record<ApprovalStatus, string> = { pending: "waiting", allowed: "allowed", denied: "turned down", expired: "expired" };
const CARD_OUTCOME: Record<NonNullable<Approval["outcome"]>, string> = { sent: "sent", saved: "saved as a draft", changes: "changes asked" };

export type ExportChat = { id: string; kind: "bot" | "room"; name: string; members: { id: string; name: string }[] };

/** What a chat's lines need from outside them: names, where each file went in the zip, and how a card ended. */
export type ExportContext = {
  nameOf: (author: MessageAuthor) => string;
  chatName: (threadId: string) => string | null;
  fileOf: (attachmentId: string) => string | null;
  cardOf: (message: Message) => Approval | null;
  redact: (text: string) => string;
  timeZone: string;
};

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
}

const PICTURE = /^image\/(?:png|jpe?g|gif|webp|avif)$/;

function cardLine(message: Message, context: ExportContext): string {
  const card = context.cardOf(message);
  const how = card ? [CARD_STATUS[card.status], card.outcome ? CARD_OUTCOME[card.outcome] : null, card.edited ? "edited" : null].filter(Boolean).join(", ") : null;
  const note = card?.note ? `, "${context.redact(card.note)}"` : "";
  return `_Card: ${context.redact(message.body)}${how ? ` (${how}${note})` : ""}_`;
}

/** A chat as Markdown that reads the way it does in Gond: a heading per day, who spoke and when, and what they said. */
export function chatMarkdown(chat: ExportChat, messages: Message[], context: ExportContext): string {
  const day = formatter(context.timeZone, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = formatter(context.timeZone, { hour: "numeric", minute: "2-digit" });
  const out: string[] = [`# ${chat.name}`, ""];
  if (chat.kind === "room") out.push(`A room with ${chat.members.map((m) => m.name).join(", ") || "no bots"}.`, "");
  let lastDay = "";
  for (const message of messages) {
    const at = new Date(message.createdAt);
    const thisDay = day.format(at);
    if (thisDay !== lastDay) {
      out.push(`## ${thisDay}`, "");
      lastDay = thisDay;
    }
    const when = time.format(at);
    if (message.author === "routine") {
      const name = routineName(message.body) ?? "a routine";
      out.push(`_${isWatchRun(message.body) ? "Watch" : "Routine"}: ${name} · ${when}_`, "");
      continue;
    }
    if (message.kind === "event") {
      out.push(`_${context.redact(message.body)} · ${when}_`, "");
      continue;
    }
    const between = message.fromThreadId ? `, to ${chat.name} · between bots` : "";
    const steered = message.steered ? " · sent while working" : "";
    out.push(`**${context.nameOf(message.author)}**${between} · ${when}${steered}`, "");
    if (message.replyTo) out.push(`> ${context.nameOf(message.replyTo.author)}: "${context.redact(message.replyTo.text).replace(/\s+/g, " ")}"`, "");
    if (message.kind === "message") {
      if (message.body.trim()) out.push(context.redact(message.body).trim(), "");
    } else out.push(cardLine(message, context), "");
    for (const file of message.attachments) {
      const path = context.fileOf(file.id);
      if (!path) out.push(`_${file.name} (no longer kept)_`, "");
      else out.push(`${PICTURE.test(file.mediaType) ? "!" : ""}[${file.name.replace(/[[\]]/g, "")}](${encodeURI(path)})`, "");
    }
    if (message.reactions.length) out.push(`_${message.reactions.map((r) => `${r.emoji} ${context.nameOf(r.author)}`).join(" · ")}_`, "");
  }
  if (!messages.length) out.push("_Nothing was said in this stretch._", "");
  return `${out.join("\n").trimEnd()}\n`;
}

function redactDeep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]));
  return value;
}

/** A chat in full, for another app: every line with who wrote it, its reactions, its quote, its files and how a card ended. */
export function chatJson(chat: ExportChat, messages: Message[], context: ExportContext, exportedAt: string): string {
  const doc = {
    format: FORMAT,
    exportedAt,
    timeZone: context.timeZone,
    chat,
    messages: messages.map((m) => {
      const card = context.cardOf(m);
      return {
        id: m.id,
        createdAt: m.createdAt,
        kind: m.kind,
        author: m.author,
        authorName: context.nameOf(m.author),
        body: context.redact(m.body),
        betweenBots: m.fromThreadId ? { fromChatId: m.fromThreadId, fromChat: context.chatName(m.fromThreadId) } : null,
        sentWhileWorking: m.steered,
        replyTo: m.replyTo ? { id: m.replyTo.id, author: m.replyTo.author, authorName: context.nameOf(m.replyTo.author), text: context.redact(m.replyTo.text) } : null,
        reactions: m.reactions.map((r) => ({ emoji: r.emoji, author: r.author, authorName: context.nameOf(r.author) })),
        attachments: m.attachments.map((f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, size: f.size, path: context.fileOf(f.id) })),
        card: card ? redactDeep({ tool: card.tool, summary: card.summary, status: card.status, outcome: card.outcome, edited: card.edited, note: card.note, input: card.input, resolvedAt: card.resolvedAt }, context.redact) : null,
      };
    }),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function readme(input: { label: string; exportedAt: string; timeZone: string; chats: { folder: string; name: string; kind: "bot" | "room"; count: number }[] }): string {
  const when = formatter(input.timeZone, { dateStyle: "long", timeStyle: "short" }).format(new Date(input.exportedAt));
  const rows = input.chats.map((c) => `| ${c.name.replace(/\|/g, "\\|")} | ${c.kind === "room" ? "Room" : "Bot"} | ${c.count} | \`${c.folder}/\` |`);
  return [
    "# Your Gond chats",
    "",
    `${input.label}, exported ${when}. Times are in ${input.timeZone}.`,
    "",
    "Each chat has a folder of its own:",
    "",
    "- `chat.md` reads like the conversation does in Gond.",
    "- `chat.json` has every line in full, with who wrote it, reactions, replies and how each card ended, for another app.",
    "- `files/` holds the files and pictures that were sent there.",
    "",
    "What your bots said to each other is in the chat it landed in, marked \"between bots\". The instructions Gond gives bots behind the scenes and the steps they worked through aren't included, and stored secrets never are.",
    "",
    "| Chat | Kind | Messages | Folder |",
    "| --- | --- | ---: | --- |",
    ...rows,
    "",
  ].join("\n");
}

class TooBig extends Error {}

/** Collects a zip as it is written, a file at a time, so a long history never sits in memory twice. */
function zipWriter() {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let failure: Error | null = null;
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => (finished = resolve));
  const zip = new Zip((error, data, final) => {
    if (error) failure = error;
    else {
      chunks.push(data);
      size += data.byteLength;
    }
    if (error || final) finished();
  });
  return {
    add(name: string, data: Uint8Array, stored = false) {
      if (failure) throw failure;
      if (size + data.byteLength > MAX_EXPORT_BYTES) throw new TooBig();
      const file = stored ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
      zip.add(file);
      file.push(data, true);
    },
    async close(): Promise<Uint8Array> {
      zip.end();
      await done;
      if (failure) throw failure;
      const out = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
      }
      return out;
    },
  };
}

// Already squeezed: deflating them again costs time and saves nothing.
const STORED = /^(?:image\/(?:png|jpe?g|gif|webp|avif)|video\/|audio\/|application\/(?:zip|gzip|pdf|x-7z-compressed))/;

const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function exportChats(userId: string, threadId: string | null): ThreadRef[] {
  const refs = threadRefs(userId);
  return threadId ? refs.filter((ref) => ref.id === threadId) : refs;
}

function exportFolder(at: string, timeZone: string): string {
  const parts = formatter(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `gond-chats-${get("year")}-${get("month")}-${get("day")}`;
}

export function exportFileName(createdAt: string, userId: string): string {
  return `${exportFolder(createdAt, userTimezone(userId))}.zip`;
}

/** Gathers the chats into a zip; null when the person deleted the export before it was done. */
async function buildExport(job: ExportJob, label: string): Promise<Uint8Array | null> {
  const timeZone = userTimezone(job.userId);
  const exportedAt = new Date().toISOString();
  const root = exportFolder(exportedAt, timeZone);
  const bots = new Map(listBots({ includeHidden: true, userId: job.userId }).map((b) => [b.id, b.name]));
  const refs = exportChats(job.userId, job.threadId);
  const chatNames = new Map(threadRefs(job.userId).map((ref) => [ref.id, ref.name]));
  const nameOf = (author: MessageAuthor) => (author === "you" ? "You" : author === "system" ? "Gond" : author === "routine" ? "Routine" : (bots.get(author) ?? "A bot that was removed"));
  const redact = createRedactor(allSecretValues(), Number.POSITIVE_INFINITY);
  const zip = zipWriter();
  const folders = new Set<string>();
  const listed: { folder: string; name: string; kind: "bot" | "room"; count: number }[] = [];

  for (const [index, ref] of refs.entries()) {
    if (!exportWanted(job.id)) return null;
    const thread = getThread(ref.id);
    if (thread) {
      const chat: ExportChat = { id: thread.id, kind: thread.kind, name: thread.name, members: thread.members.map((id) => ({ id, name: bots.get(id) ?? "A bot that was removed" })) };
      const folder = uniqueName(safeName(thread.name, "Chat"), folders);
      const messages: Message[] = [];
      for (let after = 0; ; ) {
        const page = messagesInOrder(thread.id, { afterRowid: after, since: job.since });
        messages.push(...page.messages);
        if (page.messages.length < 500) break;
        after = page.last;
        await breathe();
      }
      const files = new Map<string, string>();
      const taken = new Set<string>();
      for (const file of messages.flatMap((m) => m.attachments)) {
        if (files.has(file.id)) continue;
        const stored = getAttachment(file.id);
        if (!stored) continue;
        const path = `files/${uniqueName(safeName(stored.meta.name), taken)}`;
        zip.add(`${root}/${folder}/${path}`, stored.data, STORED.test(stored.meta.mediaType));
        files.set(file.id, path);
        await breathe();
      }
      const context: ExportContext = {
        nameOf,
        chatName: (id) => chatNames.get(id) ?? null,
        fileOf: (id) => files.get(id) ?? null,
        cardOf: (m) => (m.kind === "approval" && m.approvalId ? getApproval(m.approvalId) : null),
        redact,
        timeZone,
      };
      const encoder = new TextEncoder();
      zip.add(`${root}/${folder}/chat.md`, encoder.encode(chatMarkdown(chat, messages, context)));
      zip.add(`${root}/${folder}/chat.json`, encoder.encode(chatJson(chat, messages, context, exportedAt)));
      listed.push({ folder, name: thread.name, kind: thread.kind, count: messages.length });
    }
    exportProgress(job, index + 1);
    await breathe();
  }
  zip.add(`${root}/README.md`, new TextEncoder().encode(readme({ label, exportedAt, timeZone, chats: listed })));
  return zip.close();
}

/** Runs an export to the end in the background: the zip kept to download, or a line saying why not. */
export async function runExport(job: ExportJob, label: string): Promise<void> {
  try {
    const data = await buildExport(job, label);
    if (!data || !finishExport(job, data)) return;
    await sendPush({ title: "Your chats are ready", body: `${label}. Download them from Settings, Account.`, url: "/app/settings/account", tag: `export-${job.id}`, threadId: "" }, job.userId).catch(() => 0);
  } catch (error) {
    if (!(error instanceof TooBig)) console.error("[gond] export failed", error);
    failExport(job, error instanceof TooBig ? "These chats come to more than 900 MB. Export one chat at a time, or a shorter stretch." : "Couldn't prepare your chats. Try again.");
  }
}
