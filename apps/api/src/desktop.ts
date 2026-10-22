import type { DesktopDriver, DesktopState, ScreenState, ScreenTarget } from "@gond/shared";
import { boxConfig, desktopControl, desktopScreens, type DesktopStatus } from "./box.ts";
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

/** How long a reply keeps its bot's screen after its last batch there, while another reply of that bot waits for it. */
export const DESKTOP_LAPSE_MS = 2 * 60_000;
const WAIT_POLL_MS = 500;

// Every bot has a screen of its own, so what is kept per screen is keyed by the person and the bot.
const screenKey = (userId: string, botId: string) => `${userId}\n${botId}`;
const ofPerson = (userId: string, key: string) => key.startsWith(`${userId}\n`);

function drivers(): Map<string, DesktopDriver[]> {
  return (holder.__gondDesktopDrivers ??= new Map());
}

// The replies the person took a screen from, or turned away while they held it: each hears when it comes back.
function takenFrom(): Map<string, DesktopDriver[]> {
  return (holder.__gondDesktopTakenFrom ??= new Map());
}

function waiters(): Map<string, Set<Waiter>> {
  return (holder.__gondDesktopWaiters ??= new Map());
}

const same = (a: DesktopDriver, b: DesktopDriver) => a.botId === b.botId && a.threadId === b.threadId;

function addTaken(key: string, list: DesktopDriver[]) {
  const kept = takenFrom().get(key) ?? [];
  const added = list.filter((driver) => !kept.some((k) => same(k, driver)));
  if (added.length) takenFrom().set(key, [...kept, ...added]);
}

/** The person took the mouse on a bot's screen: whoever was driving it is told when they give it back. */
export function tookControl(userId: string, botId: string): void {
  addTaken(
    screenKey(userId, botId),
    driversOf(userId).filter((driver) => driver.botId === botId),
  );
}

/**
 * Waits until the person gives the bot's screen back, the signal aborts or
 * `ms` passes; true only for the hand back. A bot that gives up waiting is
 * still told later, by `handedBack`.
 */
export function untilHandedBack(userId: string, driver: DesktopDriver, ms: number, signal?: AbortSignal): Promise<boolean> {
  const key = screenKey(userId, driver.botId);
  addTaken(key, [driver]);
  return new Promise((resolve) => {
    const set = waiters().get(key) ?? new Set<Waiter>();
    waiters().set(key, set);
    const finish = (back: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      set.delete(waiter);
      if (!set.size) waiters().delete(key);
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

/** The person gave a bot's screen back: wakes the replies waiting for it and answers the ones that weren't, which still need telling. */
export function handedBack(userId: string, botId: string): DesktopDriver[] {
  const key = screenKey(userId, botId);
  const list = takenFrom().get(key) ?? [];
  takenFrom().delete(key);
  const waiting = [...(waiters().get(key) ?? [])];
  for (const waiter of waiting) waiter.wake();
  return list.filter((driver) => !waiting.some((waiter) => same(waiter, driver)));
}

/** A stopped conversation's bots are not told a screen came back, or that it is free. */
export function forgetHandBack(userId: string, threadId: string): void {
  for (const map of [takenFrom(), turnedAway()]) {
    for (const [key, all] of [...map]) {
      if (!ofPerson(userId, key)) continue;
      const list = all.filter((driver) => driver.threadId !== threadId);
      if (list.length) map.set(key, list);
      else map.delete(key);
    }
  }
}

/*
 * A bot's screen goes to one of its replies at a time (the bot can be at work
 * in a room and in its own chat at once), first come first served, from its
 * first batch with input on the desktop until the reply ends or leaves it alone
 * for DESKTOP_LAPSE_MS while another waits. A browser batch waits for a
 * desktop the bot's other reply holds, without taking it, since bringing its
 * tab forward would cover that screen.
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

export function desktopHolder(userId: string, botId: string): DesktopDriver | null {
  const turn = turns().get(screenKey(userId, botId));
  return turn ? { botId: turn.botId, threadId: turn.threadId } : null;
}

function screenIsFree(key: string, driver: DesktopDriver, target: ScreenTarget): boolean {
  const turn = turns().get(key);
  if (turn && !same(turn, driver) && Date.now() - turn.at < DESKTOP_LAPSE_MS) return false;
  if (target === "browser") return true;
  const first = (lines().get(key) ?? []).find((waiting) => waiting.target === "desktop");
  return !first || same(first, driver);
}

/**
 * Waits for the bot's screen: null once this reply may go ahead (and, for the
 * desktop, holds it), else the reply that still had it after `ms` or a stop.
 * One turned away hears when it is free (`releaseComputer`).
 */
export async function waitForScreen(userId: string, driver: DesktopDriver, target: ScreenTarget, ms: number, signal?: AbortSignal): Promise<DesktopDriver | null> {
  const key = screenKey(userId, driver.botId);
  const deadline = Date.now() + ms;
  const me: InLine = { ...driver, target };
  let queued = false;
  try {
    for (;;) {
      if (screenIsFree(key, driver, target)) {
        const turn = turns().get(key);
        if (target === "desktop" || (turn && same(turn, driver))) turns().set(key, { ...driver, at: Date.now() });
        return null;
      }
      if (signal?.aborted || Date.now() >= deadline) {
        const kept = turnedAway().get(key) ?? [];
        if (!kept.some((k) => same(k, driver))) turnedAway().set(key, [...kept, driver]);
        return desktopHolder(userId, driver.botId) ?? driver;
      }
      if (!queued) {
        lines().set(key, [...(lines().get(key) ?? []), me]);
        queued = true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, Math.max(deadline - Date.now(), 0))));
    }
  } finally {
    if (queued) {
      const rest = (lines().get(key) ?? []).filter((waiting) => waiting !== me);
      if (rest.length) lines().set(key, rest);
      else lines().delete(key);
    }
  }
}

/** The reply that held its bot's screen is done: the replies turned away while it did, and not waiting now, are told it is free. */
function leaveDesktop(userId: string, threadId: string, botId?: string): DesktopDriver[] {
  const told: DesktopDriver[] = [];
  for (const [key, turn] of [...turns()]) {
    if (!ofPerson(userId, key) || turn.threadId !== threadId || (botId !== undefined && turn.botId !== botId)) continue;
    turns().delete(key);
    const waiting = lines().get(key) ?? [];
    told.push(...(turnedAway().get(key) ?? []).filter((driver) => !same(driver, turn) && !waiting.some((w) => same(w, driver))));
    turnedAway().delete(key);
  }
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

const toScreen = (status: DesktopStatus): ScreenState => ({ botId: status.bot, running: status.running, ready: status.ready, width: status.width, height: status.height, viewers: status.viewers, control: status.control ?? "free" });

export async function desktopState(userId: string): Promise<DesktopState> {
  const box = boxConfig(userId);
  if (!box) return { screens: [], drivers: driversOf(userId) };
  const { screens } = await desktopScreens(box);
  const driving = new Set(driversOf(userId).map((driver) => driver.botId));
  const out: ScreenState[] = [];
  for (const status of screens) {
    // The box still holds a screen for a bot this API no longer runs (it restarted mid-turn): the person gets it back.
    if (status.control === "bots" && !driving.has(status.bot)) {
      const freed = await desktopControl(box, status.bot, { holder: "free", from: "bots" }).catch(() => null);
      out.push(toScreen(freed ?? status));
    } else out.push(toScreen(status));
  }
  return { screens: out, drivers: driversOf(userId) };
}

export async function emitDesktop(userId: string): Promise<void> {
  const desktop = await desktopState(userId).catch((): DesktopState => ({ screens: [], drivers: driversOf(userId) }));
  emit({ topic: "desktop", userId, desktop });
}

/** Ends a reply's hold on its bot's screen; answers the replies to tell that the screen is free now. */
export async function releaseComputer(userId: string, threadId: string, options: { botId?: string; signal?: AbortSignal } = {}): Promise<DesktopDriver[]> {
  const free = leaveDesktop(userId, threadId, options.botId);
  const before = driversOf(userId);
  const after = before.filter((d) => d.threadId !== threadId || (options.botId !== undefined && d.botId !== options.botId));
  if (after.length === before.length) return free;
  if (after.length) drivers().set(userId, after);
  else drivers().delete(userId);
  const box = boxConfig(userId);
  const idle = [...new Set(before.filter((d) => !after.includes(d)).map((d) => d.botId))].filter((botId) => !after.some((d) => d.botId === botId));
  if (box) await Promise.all(idle.map((botId) => desktopControl(box, botId, { holder: "free", from: "bots" }, options.signal).catch(() => undefined)));
  await emitDesktop(userId);
  return free;
}
