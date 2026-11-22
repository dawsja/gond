import { BoxError, boxConfig, deleteBoxFile, peekBoxFile, peekBoxFileBytes, uploadBoxFile, type BoxConfig } from "./box.ts";
import { getBot } from "./data/bots.ts";
import { MAIN_TOPIC, memoriesOnComputer, memoryOnComputer, moveMemoryFiles, readMemory, type MemoryOwner } from "./data/memories.ts";
import { botHome, fileTopic, LEGACY_TEAM_MEMORY_PATH, teamDir, UNREADABLE, type LoadedMemory } from "./memory.ts";
import { ownerIsAdmin } from "./toolkits.ts";
import { isUpdating } from "./updater.ts";

// Memory used to be files on the computer: a bot's MEMORY.md and memory/<topic>.md, the team's
// .team/<id>/MEMORY.md and its topics beside it. It lives in the database now. What a bot or profile
// had then is moved in once, and anything a bot still writes there with its file tools afterwards
// (a habit, an older engine) is moved in at its next turn. Nothing is removed from the computer until
// the database holds it, and the first move keeps a copy of each file in .memory-moved/.

const MAX_FILES = 500;
const MAX_DEPTH = 6;
// A file this big isn't notes; it stays where it is, as do files that aren't text.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MOVED_DIR = ".memory-moved";
// A memory that waits on the computer is worth waiting for; one already here only looks for strays.
const WAITING_MS = 60_000;
const STRAY_MS = 5_000;
const SWEEP_MS = 5 * 60_000;

type Found = {
  path: string;
  /** Where its copy goes on the first move, relative to `base`; null for a file that stays. */
  copyAs: string | null;
  topic: string;
  content: string;
  bytes: Uint8Array;
};

type Listing = { name: string; dir: boolean; size: number }[];

/**
 * Whether a failure means the computer couldn't answer (it is down, updating, timed out), as opposed to
 * refusing one path, which is then left where it is: one odd file mustn't hold a whole memory back.
 */
function away(error: unknown): boolean {
  if (error instanceof DOMException) return true;
  if (!(error instanceof BoxError)) return false;
  return error.status === 0 || error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500;
}

function unlessAway<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (away(error) || !(error instanceof BoxError)) throw error;
    return fallback;
  };
}

async function listing(box: BoxConfig, path: string, signal: AbortSignal): Promise<Listing> {
  return ((await peekBoxFile(box, path, signal).catch(unlessAway(null)))?.entries ?? []) as Listing;
}

function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The files under a bot's memory/ folder, by path relative to it; a link, a hidden file and an empty one are left out. */
async function memoryFiles(box: BoxConfig, dir: string, signal: AbortSignal, relative = "", depth = 1, out: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH) return out;
  for (const entry of await listing(box, `${dir}${relative ? `/${relative}` : ""}`, signal)) {
    if (out.length >= MAX_FILES) break;
    if (entry.name.startsWith(".")) continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.dir) await memoryFiles(box, dir, signal, path, depth + 1, out);
    else if (entry.size > 0 && entry.size <= MAX_FILE_BYTES) out.push(path);
  }
  return out;
}

type Place = { base: string; files: { path: string; copyAs: string | null; topic: string }[] };

async function botPlace(box: BoxConfig, botId: string, signal: AbortSignal): Promise<Place> {
  const base = botHome(botId);
  const entries = await listing(box, base, signal);
  const files: Place["files"] = [];
  if (entries.some((e) => e.name === "MEMORY.md" && !e.dir && e.size > 0 && e.size <= MAX_FILE_BYTES)) files.push({ path: `${base}/MEMORY.md`, copyAs: "MEMORY.md", topic: MAIN_TOPIC });
  if (entries.some((e) => e.name === "memory" && e.dir)) {
    for (const relative of await memoryFiles(box, `${base}/memory`, signal)) files.push({ path: `${base}/memory/${relative}`, copyAs: `memory/${relative}`, topic: fileTopic(relative) });
  }
  return { base, files };
}

/**
 * The team folder also holds the team's shared files, so only its MEMORY.md is moved out of it. On the
 * first move its other notes (the <topic>.md the house rules put beside MEMORY.md) are copied in and left
 * where they are, and the admin's team memory from before profiles comes in from .team/MEMORY.md.
 */
async function teamPlace(box: BoxConfig, userId: string, first: boolean, signal: AbortSignal): Promise<Place> {
  const base = teamDir(userId);
  const entries = await listing(box, base, signal);
  const files: Place["files"] = [];
  const main = entries.find((e) => e.name === "MEMORY.md" && !e.dir);
  if (main && main.size > 0 && main.size <= MAX_FILE_BYTES) files.push({ path: `${base}/MEMORY.md`, copyAs: "MEMORY.md", topic: MAIN_TOPIC });
  if (!first) return { base, files };
  for (const entry of entries) {
    if (entry.dir || entry.name === "MEMORY.md" || entry.name.startsWith(".") || !/\.md$/i.test(entry.name) || entry.size === 0 || entry.size > MAX_FILE_BYTES) continue;
    files.push({ path: `${base}/${entry.name}`, copyAs: null, topic: fileTopic(entry.name) });
  }
  if (!main && ownerIsAdmin(userId)) files.push({ path: LEGACY_TEAM_MEMORY_PATH, copyAs: null, topic: MAIN_TOPIC });
  return { base, files };
}

async function pruneEmpty(box: BoxConfig, dir: string, signal: AbortSignal): Promise<boolean> {
  let left = 0;
  for (const entry of await listing(box, dir, signal)) {
    if (entry.dir && !entry.name.startsWith(".") && (await pruneEmpty(box, `${dir}/${entry.name}`, signal))) continue;
    left += 1;
  }
  if (left === 0) await deleteBoxFile(box, dir, signal);
  return left === 0;
}

function ownerKey(owner: MemoryOwner): string {
  return "bot" in owner ? `bot:${owner.bot}` : `team:${owner.team}`;
}

const moving = new Map<string, Promise<"moved" | "away">>();

/**
 * Moves what memory of this owner's is on the computer into the database: "away" when the computer
 * couldn't hand all of it over, and then nothing has changed on either side.
 */
export function moveMemoryIn(box: BoxConfig, owner: MemoryOwner, waitMs = WAITING_MS): Promise<"moved" | "away"> {
  const key = ownerKey(owner);
  const running = moving.get(key);
  if (running) return running;
  const move = moveOnce(box, owner, AbortSignal.timeout(waitMs)).finally(() => moving.delete(key));
  moving.set(key, move);
  return move;
}

async function moveOnce(box: BoxConfig, owner: MemoryOwner, signal: AbortSignal): Promise<"moved" | "away"> {
  const first = memoryOnComputer(owner);
  const found: Found[] = [];
  let place: Place;
  try {
    place = "bot" in owner ? await botPlace(box, owner.bot, signal) : await teamPlace(box, owner.team, first, signal);
    for (const file of place.files) {
      const bytes = await peekBoxFileBytes(box, file.path, signal).catch(unlessAway(null));
      const content = bytes && textOf(bytes);
      if (!bytes || content === null) continue;
      found.push({ ...file, content, bytes });
    }
  } catch (error) {
    if (!away(error)) throw error;
    return "away";
  }
  moveMemoryFiles(owner, found.map(({ topic, content }) => ({ topic, content })), first);
  // The database holds all of it now; what is left is tidying the computer, which can wait for the next turn.
  try {
    for (const file of found) {
      if (file.copyAs === null) continue;
      if (first) await uploadBoxFile(box, `${place.base}/${MOVED_DIR}/${file.copyAs}`, file.bytes, signal);
      await deleteBoxFile(box, file.path, signal).catch((error: unknown) => {
        if (!(error instanceof BoxError && error.status === 404)) throw error;
      });
    }
    if ("bot" in owner && found.some((file) => file.copyAs?.startsWith("memory/"))) await pruneEmpty(box, `${place.base}/memory`, signal);
  } catch (error) {
    console.warn(`[gond] moved ${ownerKey(owner)}'s memory in, but couldn't tidy the computer yet: ${error instanceof Error ? error.message : error}`);
  }
  return "moved";
}

/**
 * The memory a turn loads. One still waiting on a computer that can't be reached, or on one this Gond
 * no longer has, is UNREADABLE, so the bot neither works without it nor writes over it.
 */
export async function memoryForTurn(box: BoxConfig | null, owner: MemoryOwner): Promise<LoadedMemory> {
  const waiting = memoryOnComputer(owner);
  if (box) {
    const moved = await moveMemoryIn(box, owner, waiting ? WAITING_MS : STRAY_MS);
    if (waiting && moved === "away") return UNREADABLE;
  } else if (waiting) {
    return UNREADABLE;
  }
  return readMemory(owner);
}

let sweeping = false;

/**
 * Moves in every memory still waiting on the computer, one at a time, until it stops answering. A reset
 * asks `beforeWipe`, as it holds the computer for itself.
 */
export async function moveWaitingMemory(beforeWipe = false): Promise<void> {
  if (sweeping && !beforeWipe) return;
  sweeping = true;
  try {
    for (const owner of memoriesOnComputer()) {
      if (isUpdating() && !beforeWipe) return;
      const userId = "bot" in owner ? getBot(owner.bot)?.userId : owner.team;
      if (userId === undefined) continue;
      const box = boxConfig(userId);
      if (!box) return;
      if ((await moveMemoryIn(box, owner)) === "away") return;
    }
  } finally {
    sweeping = false;
  }
}

export function startMemoryMoves(): void {
  const sweep = () => {
    if (!memoriesOnComputer().length) {
      clearInterval(timer);
      return;
    }
    void moveWaitingMemory().catch((error: unknown) => console.error("[gond] moving memory in from the computer failed:", error));
  };
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref?.();
  sweep();
}
