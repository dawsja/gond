import type { DesktopDriver, DesktopState, ScreenTarget } from "@gond/shared";
import { boxConfig, desktopControl, desktopStatus, type DesktopStatus } from "./box.ts";
import { emit } from "./events.ts";

type Waiter = DesktopDriver & { wake: () => void };

type Turn = DesktopDriver & { at: number };
type InLine = DesktopDriver & { target: ScreenTarget };

const holder = globalThis as typeof globalThis & {
  __gondDesktopDrivers?: Map<string, DesktopDriver[]>;
  __gondDesktopTakenFrom?: Map<string, DesktopDriver[]>;
  __gondDesktopWaiters?: Map<string, Set<Waiter>>;
  __gondDesktopTurns?: Map<string, Turn>;
  __gondDesktopLines?: Map<string, InLine[]>;
  __gondDesktopTurnedAway?: Map<string, DesktopDriver[]>;
};

/** How long a reply keeps the desktop after its last batch there, while another waits for it. */
export const DESKTOP_LAPSE_MS = 2 * 60_000;
const WAIT_POLL_MS = 500;

function drivers(): Map<string, DesktopDriver[]> {
  return (holder.__gondDesktopDrivers ??= new Map());
}

// The bots the person took the screen from, or turned away while they held it: each hears when it comes back.
function takenFrom(): Map<string, DesktopDriver[]> {
  return (holder.__gondDesktopTakenFrom ??= new Map());
}

function waiters(): Map<string, Set<Waiter>> {
  return (holder.__gondDesktopWaiters ??= new Map());
}

const same = (a: DesktopDriver, b: DesktopDriver) => a.botId === b.botId && a.threadId === b.threadId;

function addTaken(userId: string, list: DesktopDriver[]) {
  const kept = takenFrom().get(userId) ?? [];
  const added = list.filter((driver) => !kept.some((k) => same(k, driver)));
  if (added.length) takenFrom().set(userId, [...kept, ...added]);
}

/** The person took the mouse: whoever was driving is told when they give it back. */
export function tookControl(userId: string): void {
  addTaken(userId, driversOf(userId));
}

/**
 * Waits until the person gives the screen back, the signal aborts or `ms`
 * passes; true only for the hand back. A bot that gives up waiting is still
 * told later, by `handedBack`.
 */
export function untilHandedBack(userId: string, driver: DesktopDriver, ms: number, signal?: AbortSignal): Promise<boolean> {
  addTaken(userId, [driver]);
  return new Promise((resolve) => {
    const set = waiters().get(userId) ?? new Set<Waiter>();
    waiters().set(userId, set);
    const finish = (back: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      set.delete(waiter);
      if (!set.size) waiters().delete(userId);
      resolve(back);
    };
    const waiter: Waiter = { ...driver, wake: () => finish(true) };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    set.add(waiter);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** The person gave the screen back: wakes the bots waiting for it and answers the ones that weren't, which still need telling. */
export function handedBack(userId: string): DesktopDriver[] {
  const list = takenFrom().get(userId) ?? [];
  takenFrom().delete(userId);
  const waiting = [...(waiters().get(userId) ?? [])];
  for (const waiter of waiting) waiter.wake();
  return list.filter((driver) => !waiting.some((waiter) => same(waiter, driver)));
}

/** A stopped conversation's bots are not told the screen came back, or that the desktop is free. */
export function forgetHandBack(userId: string, threadId: string): void {
  for (const map of [takenFrom(), turnedAway()]) {
    const list = (map.get(userId) ?? []).filter((driver) => driver.threadId !== threadId);
    if (list.length) map.set(userId, list);
    else map.delete(userId);
  }
}

/*
 * The desktop's mouse and keyboard go to one reply at a time, first come
 * first served, from its first batch with input until the reply ends or it
 * leaves the desktop alone for DESKTOP_LAPSE_MS while another waits. Each bot
 * browses in its own tab, but the browser is on that screen and brings its
 * tab forward, so a browser batch waits for a desktop held by another reply
 * too, without taking it.
 */
function turns(): Map<string, Turn> {
  return (holder.__gondDesktopTurns ??= new Map());
}

function lines(): Map<string, InLine[]> {
  return (holder.__gondDesktopLines ??= new Map());
}

function turnedAway(): Map<string, DesktopDriver[]> {
  return (holder.__gondDesktopTurnedAway ??= new Map());
}

export function desktopHolder(userId: string): DesktopDriver | null {
  const turn = turns().get(userId);
  return turn ? { botId: turn.botId, threadId: turn.threadId } : null;
}

function screenIsFree(userId: string, driver: DesktopDriver, target: ScreenTarget): boolean {
  const turn = turns().get(userId);
  if (turn && !same(turn, driver) && Date.now() - turn.at < DESKTOP_LAPSE_MS) return false;
  if (target === "browser") return true;
  const first = (lines().get(userId) ?? []).find((waiting) => waiting.target === "desktop");
  return !first || same(first, driver);
}

/**
 * Waits for the screen: null once this reply may go ahead (and, for the
 * desktop, holds it), else the reply that still had it after `ms` or a stop.
 * One turned away hears when the desktop is free (`releaseComputer`).
 */
export async function waitForScreen(userId: string, driver: DesktopDriver, target: ScreenTarget, ms: number, signal?: AbortSignal): Promise<DesktopDriver | null> {
  const deadline = Date.now() + ms;
  const me: InLine = { ...driver, target };
  let queued = false;
  try {
    for (;;) {
      if (screenIsFree(userId, driver, target)) {
        const turn = turns().get(userId);
        if (target === "desktop" || (turn && same(turn, driver))) turns().set(userId, { ...driver, at: Date.now() });
        return null;
      }
      if (signal?.aborted || Date.now() >= deadline) {
        const kept = turnedAway().get(userId) ?? [];
        if (!kept.some((k) => same(k, driver))) turnedAway().set(userId, [...kept, driver]);
        return desktopHolder(userId) ?? driver;
      }
      if (!queued) {
        lines().set(userId, [...(lines().get(userId) ?? []), me]);
        queued = true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, Math.max(deadline - Date.now(), 0))));
    }
  } finally {
    if (queued) {
      const rest = (lines().get(userId) ?? []).filter((waiting) => waiting !== me);
      if (rest.length) lines().set(userId, rest);
      else lines().delete(userId);
    }
  }
}

/** The reply that held the desktop is done: the ones turned away while it did, and not waiting now, are told it is free. */
function leaveDesktop(userId: string, threadId: string, botId?: string): DesktopDriver[] {
  const turn = turns().get(userId);
  if (!turn || turn.threadId !== threadId || (botId !== undefined && turn.botId !== botId)) return [];
  turns().delete(userId);
  const waiting = lines().get(userId) ?? [];
  const told = (turnedAway().get(userId) ?? []).filter((driver) => !same(driver, turn) && !waiting.some((w) => same(w, driver)));
  turnedAway().delete(userId);
  return told;
}

export function driversOf(userId: string): DesktopDriver[] {
  return drivers().get(userId) ?? [];
}

export function markDriving(userId: string, driver: DesktopDriver): boolean {
  const list = driversOf(userId);
  if (list.some((d) => d.botId === driver.botId && d.threadId === driver.threadId)) return false;
  drivers().set(userId, [...list, driver]);
  return true;
}

function offline(userId: string): DesktopState {
  return { running: false, ready: false, width: null, height: null, viewers: 0, control: "free", drivers: driversOf(userId) };
}

function merged(userId: string, status: DesktopStatus): DesktopState {
  return { running: status.running, ready: status.ready, width: status.width, height: status.height, viewers: status.viewers, control: status.control ?? "free", drivers: driversOf(userId) };
}

export async function desktopState(userId: string): Promise<DesktopState> {
  const box = boxConfig(userId);
  if (!box) return offline(userId);
  const status = await desktopStatus(box);
  // The box still holds the screen for bots this API no longer runs (it restarted mid-turn): the person gets it back.
  if (status.control === "bots" && !driversOf(userId).length) {
    const freed = await desktopControl(box, { holder: "free", from: "bots" }).catch(() => null);
    if (freed) return merged(userId, freed);
  }
  return merged(userId, status);
}

export async function emitDesktop(userId: string): Promise<void> {
  const desktop = await desktopState(userId).catch(() => offline(userId));
  emit({ topic: "desktop", userId, desktop });
}

/** Ends a reply's hold on the screen; answers the replies to tell that the desktop is free now. */
export async function releaseComputer(userId: string, threadId: string, options: { botId?: string; signal?: AbortSignal } = {}): Promise<DesktopDriver[]> {
  const free = leaveDesktop(userId, threadId, options.botId);
  const before = driversOf(userId);
  const after = before.filter((d) => d.threadId !== threadId || (options.botId !== undefined && d.botId !== options.botId));
  if (after.length === before.length) return free;
  if (after.length) drivers().set(userId, after);
  else drivers().delete(userId);
  if (!after.length) {
    const box = boxConfig(userId);
    if (box) await desktopControl(box, { holder: "free", from: "bots" }, options.signal).catch(() => undefined);
  }
  await emitDesktop(userId);
  return free;
}
