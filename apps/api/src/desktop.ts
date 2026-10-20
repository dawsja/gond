import type { DesktopDriver, DesktopState } from "@gond/shared";
import { boxConfig, desktopControl, desktopStatus, type DesktopStatus } from "./box.ts";
import { emit } from "./events.ts";

type Waiter = DesktopDriver & { wake: () => void };

const holder = globalThis as typeof globalThis & {
  __gondDesktopDrivers?: Map<string, DesktopDriver[]>;
  __gondDesktopTakenFrom?: Map<string, DesktopDriver[]>;
  __gondDesktopWaiters?: Map<string, Set<Waiter>>;
};

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

/** A stopped conversation's bots are not told the screen came back. */
export function forgetHandBack(userId: string, threadId: string): void {
  const list = (takenFrom().get(userId) ?? []).filter((driver) => driver.threadId !== threadId);
  if (list.length) takenFrom().set(userId, list);
  else takenFrom().delete(userId);
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

export async function releaseComputer(userId: string, threadId: string, options: { botId?: string; signal?: AbortSignal } = {}): Promise<void> {
  const before = driversOf(userId);
  const after = before.filter((d) => d.threadId !== threadId || (options.botId !== undefined && d.botId !== options.botId));
  if (after.length === before.length) return;
  if (after.length) drivers().set(userId, after);
  else drivers().delete(userId);
  if (!after.length) {
    const box = boxConfig(userId);
    if (box) await desktopControl(box, { holder: "free", from: "bots" }, options.signal).catch(() => undefined);
  }
  await emitDesktop(userId);
}
