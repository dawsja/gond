import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;
let current = 0;
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= window.setInterval(() => {
    current = Date.now();
    for (const l of listeners) l();
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function snapshot() {
  current ||= Date.now();
  return current;
}

export function useNow(): number | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
