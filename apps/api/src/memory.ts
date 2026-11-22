import { posix } from "node:path";

export function botHome(botId: string) {
  return `.bots/${botId}`;
}

export function soulPath(botId: string) {
  return `${botHome(botId)}/SOUL.md`;
}

export function teamDir(userId: string) {
  return `.team/${userId}`;
}

export const LEGACY_TEAM_MEMORY_PATH = ".team/MEMORY.md";

/** How much of a bot's MEMORY.md loads into each turn, and the most memory_update writes. */
export const MAX_MEMORY_BYTES = 24 * 1024;
/** The same for the team memory, which every bot of the person's carries. */
export const MAX_TEAM_MEMORY_BYTES = 12 * 1024;
/** From this share of its limit on, a memory's heading tells the bot to move notes out. */
export const NEARLY_FULL = 0.8;

/** The most a bot writes into one topic; one moved in from the computer may be larger, and is read in parts. */
export const MAX_TOPIC_BYTES = 64 * 1024;

/** A memory that is there but couldn't be read this turn, told apart from none so a bot doesn't write over it. */
export const UNREADABLE = Symbol("unreadable memory");
export type LoadedMemory = string | null | typeof UNREADABLE;

const MAIN_NAME = /^memory$/i;

/**
 * A memory topic's name, however a bot writes it: `backups`, `backups.md`, `memory/backups.md`, a path in
 * its home (`~/.bots/<id>/memory/backups.md`) or the team's (`~/.team/<id>/backups.md`). MEMORY.md is the
 * main memory, "". Null for a name that is nothing, hidden, or climbs out with `..`.
 */
export function topicName(given: string): string | null {
  let path = given.trim().replaceAll("\\", "/");
  const home = /(?:^|\/)\.(?:bots|team)\/[^/]+\/(.*)$/.exec(path);
  if (home) path = home[1]!;
  path = path.replace(/^~?\/+/, "").replace(/^memory\//i, "");
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.startsWith(".") || /[\u0000-\u001f\u007f]/.test(part))) return null;
  const name = parts.join("/").replace(/\.md$/i, "");
  if (MAIN_NAME.test(name)) return "";
  return name && name.length <= 120 ? name : null;
}

const MEMORY_FILE = /^\.bots\/[^/]+\/(?:MEMORY\.md|memory(?:\/.+)?)$|^\.team\/(?:[^/]+\/)?MEMORY\.md$/;

/**
 * Whether a path a bot's file tool names is where its memory or the team's used to be kept as files (a
 * bot's MEMORY.md or memory/ folder, a team's MEMORY.md): absolute, from the home, or from the bot's own
 * folder, where its session runs.
 */
export function isMemoryFile(given: string, botId: string): boolean {
  const raw = given.trim();
  if (!raw) return false;
  const from = /^(?:[~/]|\.(?:bots|team)\/)/.test(raw) ? raw : `.bots/${botId}/${raw}`;
  const inHome = /(?:^|\/)(\.(?:bots|team)\/.*)$/.exec(from);
  return Boolean(inHome) && MEMORY_FILE.test(posix.normalize(inHome![1]!));
}

export const MEMORY_FILES_TEXT =
  "Not done: memory lives in Gond now, not in files on the computer. Read a topic with memory_read, change MEMORY.md with memory_update (team_memory_update for the team's) and a topic with memory_write.";

export function fileTopic(relative: string): string {
  const name = relative.replace(/\.md$/i, "");
  return MAIN_NAME.test(name) ? `${name}-notes` : name;
}

export function mergeMemory(existing: string | null, incoming: string): string {
  const have = existing?.trim() ?? "";
  const add = incoming.trim();
  if (!have) return incoming;
  if (!add || have.includes(add)) return existing!;
  if (add.includes(have)) return incoming;
  return `${have}\n\n## Notes found on the computer\n${add}\n`;
}

type FittedMemory = { text: string; bytes: number; limit: number; cut: number };

export function kb(bytes: number): string {
  return `${Math.max(bytes ? 0.1 : 0, Math.round((bytes / 1024) * 10) / 10)} KB`;
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function linesWithin(lines: string[], budget: number, fromEnd = false): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of fromEnd ? [...lines].reverse() : lines) {
    used += bytesOf(line) + 1;
    if (used > budget) break;
    kept.push(line);
  }
  return fromEnd ? kept.reverse() : kept;
}

/**
 * A memory file as it loads into a turn. Over its limit, the middle is what drops: the top holds what was
 * set down first and is usually the most settled, and the bottom what was learned last, which a cut from
 * the end would lose first.
 */
export function fitMemory(raw: string, limit: number): FittedMemory {
  const text = raw.trim();
  const bytes = bytesOf(text);
  if (bytes <= limit) return { text, bytes, limit, cut: 0 };
  const lines = text.split("\n");
  const head = linesWithin(lines, limit / 2);
  const tail = linesWithin(lines.slice(head.length), limit / 2, true);
  const kept = head.length || tail.length ? [head.join("\n"), tail.join("\n")] : [Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/\uFFFD$/, ""), ""];
  const cut = bytes - bytesOf(kept.join(""));
  return { text: `${kept[0]}\n\n[… ${kb(cut)} here didn't load …]\n\n${kept[1]}`.trim(), bytes, limit, cut };
}
