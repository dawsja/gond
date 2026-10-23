import { QUIET_REPLY } from "@gond/shared";

/** True while the text so far could still turn out to be `NOTHING_NEW` (see `isQuietReply`). */
export function couldBeQuiet(text: string): boolean {
  const core = text.replace(/^[\s`*_]+/, "").replace(/[\s`*_.]+$/, "").toLowerCase();
  return QUIET_REPLY.toLowerCase().startsWith(core);
}

export const WRITING_INTERVAL_MS = 80;

type Timers = { now: () => number; later: (run: () => void, ms: number) => () => void };

const realTimers: Timers = {
  now: Date.now,
  later: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * The words of a reply on their way to the person, at most one update every `WRITING_INTERVAL_MS`.
 * Nothing shows while the text could still be `NOTHING_NEW`, which posts nothing.
 */
export function createWriting(send: (text: string | null) => void, redact: (text: string) => string, timers: Timers = realTimers) {
  let latest: string | null = null;
  let shown = false;
  let sentAt = -Infinity;
  let cancel: (() => void) | null = null;

  const flush = () => {
    cancel = null;
    if (latest === null) return;
    sentAt = timers.now();
    shown = true;
    send(redact(latest));
  };

  const stop = () => {
    cancel?.();
    cancel = null;
    latest = null;
    if (shown) send(null);
    shown = false;
  };

  return {
    text(text: string | null) {
      if (text === null) return stop();
      const trimmed = text.trim();
      if (couldBeQuiet(trimmed)) return;
      latest = trimmed;
      if (cancel) return;
      const wait = sentAt + WRITING_INTERVAL_MS - timers.now();
      if (wait <= 0) flush();
      else cancel = timers.later(flush, wait);
    },
    close: stop,
  };
}
