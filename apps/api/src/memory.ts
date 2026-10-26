export function botHome(botId: string) {
  return `.bots/${botId}`;
}

export function memoryPath(botId: string) {
  return `${botHome(botId)}/MEMORY.md`;
}

export function soulPath(botId: string) {
  return `${botHome(botId)}/SOUL.md`;
}

export function teamDir(userId: string) {
  return `.team/${userId}`;
}

export function teamMemoryPath(userId: string) {
  return `${teamDir(userId)}/MEMORY.md`;
}

export const LEGACY_TEAM_MEMORY_PATH = ".team/MEMORY.md";

/** How much of a bot's MEMORY.md loads into each turn, and the most memory_update writes. */
export const MAX_MEMORY_BYTES = 24 * 1024;
/** The same for the team memory, which every bot of the person's carries. */
export const MAX_TEAM_MEMORY_BYTES = 12 * 1024;
/** From this share of its limit on, a memory's heading tells the bot to move notes out. */
export const NEARLY_FULL = 0.8;

/** A memory file that is there but couldn't be read this turn, told apart from none so a bot doesn't write over it. */
export const UNREADABLE = Symbol("unreadable memory");
export type LoadedMemory = string | null | typeof UNREADABLE;

export type FittedMemory = { text: string; bytes: number; limit: number; cut: number };

export function kb(bytes: number): string {
  return `${Math.max(bytes ? 0.1 : 0, Math.round((bytes / 1024) * 10) / 10)} KB`;
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Whole lines from the start (or, with `fromEnd`, the end) of `lines` that fit in `budget` bytes. */
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
