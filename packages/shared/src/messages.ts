import type { ThreadSpace } from "./spaces.ts";

export const THREAD_KINDS = ["bot", "room"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export type Thread = {
  id: string;

  userId: string;
  kind: ThreadKind;

  botId: string | null;
  name: string;

  members: string[];
  /** A room pinned to the top of the list; a bot's conversation follows its bot's own `pinned`. */
  pinned: boolean;

  /** The latest line between the person and the bot or room; what bots said to each other here never counts. */
  lastMessage: { author: string; body: string; at: string } | null;
  /** Unread lines for the person. */
  unread: number;
  /** Bots wrote to each other here since the person last looked, and nothing new is for them. */
  unreadTeam: boolean;
  /** What a watch's latest run said, while the person hasn't read it yet. */
  noticed: { watch: string; body: string; at: string } | null;
  /** A room shared with people on other Gonds: who is there from where. Null for any other conversation. */
  space: ThreadSpace | null;
  createdAt: string;
  updatedAt: string;
};

export type MessageAuthor = "you" | "system" | "routine" | string;

/**
 * What one bot tells another with message_bot: an `action` wakes it to act on the note and answer with
 * what it did; `info` only lets it know ("my part is done") and wakes nobody, unless it reports to the
 * bot that asked for the action.
 */
export const NOTE_KINDS = ["action", "info"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === "string" && (NOTE_KINDS as readonly string[]).includes(value);
}

export const MESSAGE_KINDS = ["message", "event", "activity", "approval", "secret", "prompt", "signin", "teach", "control"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** What a person or a bot can put on a message, one each: the chat's own tapbacks. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];

export function isReaction(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTIONS as readonly string[]).includes(value);
}

/** One reaction on a message: `author` is "you" or a bot's id, like a message's. */
export type Reaction = { author: MessageAuthor; emoji: ReactionEmoji };

export type ChatAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /** Removed by the server's retention (Settings → Data & backups): only its name and size are left. */
  removed?: true;
};

export type Message = {
  commerceId?: string | null;
  id: string;
  threadId: string;
  author: MessageAuthor;
  kind: MessageKind;
  body: string;
  attachments: ChatAttachment[];

  depth: number;

  approvalId: string | null;

  fromThreadId: string | null;

  steered: boolean;
  /** Said out loud on a call: the person's words as heard, or what the bot's voice said. Kept for the bot, never shown. */
  spoken: boolean;
  /** A note between bots: an action the bot it reaches must act on, or information that needs nothing. */
  note: NoteKind | null;
  /** In a room, the bots Gond's router judged a person's unnamed line was for; null when the line named them or nothing was routed. */
  sentTo: string[] | null;

  reactions: Reaction[];
  /** The message this one answers, quoted: who wrote it and its first words, or its first file's name. */
  replyTo: Quote | null;
  /** For a bot's line, the message it answered, which in a space may be someone's on another Gond. */
  answering?: string | null;
  /**
   * A person's line no bot has read yet (not claimed, answered or steered into a turn): it can still be
   * taken back or edited. Always filled by the API; optional only so cards drawn from other things needn't say.
   */
  waiting?: boolean;
  /** What the primary bot said on a check-in of its own, not in answer to anything. */
  checkIn?: boolean;
  createdAt: string;
};

export type Quote = { id: string; author: MessageAuthor; text: string };

export const QUOTE_CHARS = 280;

/** How a bot reads a reply: `(replying to Patch: "…") ` ahead of the person's words. */
export function replyLine(quote: Quote | null, nameOf: (author: MessageAuthor) => string): string {
  return quote ? `(replying to ${nameOf(quote.author)}: "${quote.text.slice(0, 200)}${quote.text.length > 200 ? "…" : ""}") ` : "";
}

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const MAX_SENT_FILE_BYTES = 100 * 1024 * 1024;

export function mediaTypeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return FILE_TYPES[ext] ?? "application/octet-stream";
}

const FILE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", xml: "application/xml",
  zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg", mp4: "video/mp4", wav: "audio/wav",
};

export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json", "image/svg+xml"] as const;
