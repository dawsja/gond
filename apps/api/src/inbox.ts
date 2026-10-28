import type { Bot, ChatAttachment, Message } from "@gond/shared";
import { previewBoxImage, uploadBoxFile, type BoxConfig } from "./box.ts";
import { getAttachment } from "./data/threads.ts";
import { botHome } from "./memory.ts";

// Big enough for a report, small enough that a turn's request to the box stays well under its limit.
const INLINE_PDF_BYTES = 8 * 1024 * 1024;
// Under every vision API's per-image limit, for when no smaller copy could be made.
const INLINE_IMAGE_BYTES = 3.5 * 1024 * 1024;
const PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"]);

type InlineFile = { name: string; mediaType: string; data: string };
export type Delivered = { path: string; meta: ChatAttachment; shown: boolean };

/** A file name that is one plain path segment, whatever the phone called it. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(-120);
  return clean || "file";
}

/** Where an attachment lands, relative to the bot's own folder (its working directory). */
export function inboxPath(meta: Pick<ChatAttachment, "id" | "name">): string {
  return `inbox/${meta.id.replace(/^f-/, "").slice(0, 8)}-${safeFileName(meta.name)}`;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The lines that tell the bot what came with the message and where it is, so it never has to look. */
export function attachmentNote(files: Delivered[]): string {
  if (!files.length) return "";
  const lines = files.map(({ path, meta, shown }) => {
    const kind = `${meta.mediaType}, ${sizeLabel(meta.size)}`;
    if (!path) return `- ${meta.name} (${kind}): ${shown ? "shown to you with this message; it couldn't be saved to your folder" : "it couldn't be saved to your folder or shown to you; say so"}`;
    if (shown) return `- ${path} (${kind}): ${meta.mediaType.startsWith("image/") ? "the picture is" : "it is"} shown to you with this message`;
    return `- ${path} (${kind}): open it with your tools`;
  });
  return [
    `The message came with ${files.length === 1 ? "a file" : `${files.length} files`}, saved in your own folder (paths relative to it):`,
    ...lines,
    "If something shown to you isn't in front of you, open it from that path. Don't search the computer for it.",
  ].join("\n");
}

/**
 * Saves every file the person sent into the bot's inbox on the box, and makes
 * what the model is shown with the message: a model-sized copy of a picture
 * and a PDF small enough to send. Nothing here throws; a file that can't be
 * saved or shown is said so in the note.
 */
export async function deliverAttachments(box: BoxConfig, bot: Pick<Bot, "id" | "name">, message: Message, signal?: AbortSignal, options: { pdf?: boolean } = {}): Promise<{ files: Delivered[]; inline: InlineFile[] }> {
  const files: Delivered[] = [];
  const inline: InlineFile[] = [];
  for (const meta of message.attachments) {
    const file = getAttachment(meta.id);
    if (!file) continue;
    const relative = inboxPath(meta);
    const full = `${botHome(bot.id)}/${relative}`;
    let saved = true;
    try {
      await uploadBoxFile(box, full, file.data, signal);
    } catch (error) {
      saved = false;
      console.warn(`[gond] could not save ${meta.name} for ${bot.name}: ${error instanceof Error ? error.message : error}`);
    }
    let shown: InlineFile | null = null;
    if (saved && PREVIEW_TYPES.has(meta.mediaType)) {
      try {
        const preview = await previewBoxImage(box, full, meta.mediaType, signal);
        shown = { name: meta.name, mediaType: preview.mediaType, data: preview.data };
      } catch (error) {
        console.warn(`[gond] no preview of ${meta.name} for ${bot.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (!shown && PREVIEW_TYPES.has(meta.mediaType) && meta.mediaType !== "image/bmp" && file.data.byteLength <= INLINE_IMAGE_BYTES) {
      shown = { name: meta.name, mediaType: meta.mediaType, data: Buffer.from(file.data).toString("base64") };
    } else if (meta.mediaType === "application/pdf" && options.pdf !== false && file.data.byteLength <= INLINE_PDF_BYTES) {
      shown = { name: meta.name, mediaType: meta.mediaType, data: Buffer.from(file.data).toString("base64") };
    }
    if (shown) inline.push(shown);
    files.push({ path: saved ? relative : "", meta, shown: shown !== null });
  }
  return { files, inline };
}
