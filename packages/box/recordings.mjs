import fs from "node:fs";
import path from "node:path";
import { appName, createTimeline, pageStep, samePage, TEACH_MAX_FRAME_BYTES, TEACH_MAX_FRAMES, TEACH_MAX_MS } from "./recorder.mjs";

// With nobody watching the screen, a recording pauses after this, and ends after the second.
const AWAY_PAUSE_MS = 30_000;
const AWAY_END_MS = 30 * 60_000;
const FRAME_GAP_MS = 600;
const FRAME_SETTLE_MS = 300;
const STEPS_FILE = "steps.json";

export const RECORDING_ID = /^[A-Za-z0-9_-]{8,40}$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}$/;

const isBrowserWindow = (cls) => /chrom/i.test(cls ?? "");

/**
 * "Show me how" on the box: one recording per screen, made of the person's
 * own input (`desktopInput`, from the VNC tracker) and what the bot's browser
 * reports (`pageEvent`), each step answered with a screenshot a moment
 * later. Everything is written to the recording's folder as it goes, so a
 * box that restarts still has what was shown. Listeners hear every step,
 * frame and change of state. The clock counts only time not paused, up to
 * TEACH_MAX_MS, after which the recording ends itself.
 */
export function createRecordings({ root, takeFrame, windowAt, browserRecord, viewers, now = Date.now, timers = globalThis, maxMs = TEACH_MAX_MS, log = () => undefined }) {
  // Under the box's own state, root's alone: nothing a person controls is ever written through, so no link of theirs can redirect it.
  const dirOf = (user, id) => path.join(root, user, id);
  const live = new Map();

  const statusOf = (rec) => ({
    id: rec.id,
    bot: rec.bot,
    startedAt: new Date(rec.startedAt).toISOString(),
    activeMs: activeMs(rec),
    maxMs,
    paused: rec.paused,
    pausedFor: rec.pausedFor,
    ended: rec.ended,
    full: rec.timeline.full,
    browser: rec.browser,
    steps: rec.timeline.steps(),
    frames: rec.frames,
  });

  const activeMs = (rec) => rec.activeMs + (rec.paused || rec.ended ? 0 : now() - rec.resumedAt);

  const emit = (rec, event) => {
    for (const listener of rec.listeners) {
      try {
        listener(event);
      } catch (error) {
        log(`a recording listener failed: ${error.message}`);
      }
    }
  };

  const save = (rec) => {
    if (rec.saving) return;
    rec.saving = timers.setTimeout(() => {
      rec.saving = null;
      writeSteps(rec);
    }, 500);
  };

  const writeSteps = (rec) => {
    try {
      fs.writeFileSync(path.join(rec.dir, STEPS_FILE), JSON.stringify({ id: rec.id, bot: rec.bot, startedAt: rec.startedAt, activeMs: activeMs(rec), ended: rec.ended ?? (rec.suspended ? "restart" : null), steps: rec.timeline.steps(), frames: rec.frames }));
    } catch (error) {
      log(`couldn't save recording ${rec.id}: ${error.message}`);
    }
  };

  const clear = (rec, name) => {
    if (rec[name]) timers.clearTimeout(rec[name]);
    rec[name] = null;
  };

  const armLimit = (rec) => {
    clear(rec, "limitTimer");
    if (rec.paused || rec.ended) return;
    rec.limitTimer = timers.setTimeout(() => end(rec, "limit"), Math.max(0, maxMs - activeMs(rec)));
  };

  const frameFor = (rec, stepN) => {
    if (rec.ended || rec.paused) return;
    rec.frameStep = stepN;
    if (rec.frameTimer) return;
    const wait = Math.max(FRAME_SETTLE_MS, FRAME_GAP_MS - (now() - rec.lastFrameAt));
    rec.frameTimer = timers.setTimeout(() => {
      rec.frameTimer = null;
      void shoot(rec, rec.frameStep);
    }, wait);
  };

  const shoot = async (rec, stepN) => {
    if (rec.frames.length >= TEACH_MAX_FRAMES || rec.frameBytes >= TEACH_MAX_FRAME_BYTES) {
      if (!rec.framesFull) {
        rec.framesFull = true;
        emit(rec, { type: "status", ...brief(rec) });
      }
      return;
    }
    const n = rec.frames.length + 1;
    rec.lastFrameAt = now();
    try {
      const shot = await takeFrame(rec, path.join(rec.dir, `frame-${n}.jpg`));
      if (!shot || live.get(rec.key) !== rec) return;
      const frame = { n, step: stepN ?? null, width: shot.width, height: shot.height, bytes: shot.bytes };
      rec.frames.push(frame);
      rec.frameBytes += shot.bytes;
      if (stepN) rec.timeline.setFrame(stepN, n);
      emit(rec, { type: "frame", frame });
      save(rec);
    } catch (error) {
      log(`a recording's screenshot failed: ${error.message}`);
    }
  };

  const add = (rec, step, replace = false) => {
    if (rec.ended || rec.paused) return null;
    const result = rec.timeline.add(step, { replace });
    if (!result) {
      if (!rec.stepsFull) {
        rec.stepsFull = true;
        emit(rec, { type: "status", ...brief(rec) });
      }
      return null;
    }
    emit(rec, { type: "step", step: result.step, replaced: result.replaced });
    save(rec);
    frameFor(rec, result.step.n);
    return result.step;
  };

  const brief = (rec) => ({ paused: rec.paused, pausedFor: rec.pausedFor, ended: rec.ended, activeMs: activeMs(rec), full: rec.timeline.full || Boolean(rec.framesFull) });

  const pause = (rec, why = "person") => {
    if (rec.ended || rec.paused) return;
    rec.activeMs = activeMs(rec);
    rec.paused = true;
    rec.pausedFor = why;
    clear(rec, "limitTimer");
    emit(rec, { type: "status", ...brief(rec) });
    save(rec);
  };

  const resume = (rec) => {
    if (rec.ended || !rec.paused) return;
    rec.paused = false;
    rec.pausedFor = null;
    rec.resumedAt = now();
    armLimit(rec);
    emit(rec, { type: "status", ...brief(rec) });
    save(rec);
  };

  const end = (rec, why) => {
    if (rec.ended) return;
    rec.activeMs = activeMs(rec);
    rec.ended = why;
    for (const name of ["limitTimer", "awayTimer", "goneTimer", "frameTimer"]) clear(rec, name);
    void Promise.resolve(browserRecord(rec, false)).catch(() => undefined);
    emit(rec, { type: "status", ...brief(rec) });
    if (rec.saving) clear(rec, "saving");
    writeSteps(rec);
  };

  return {
    /** Starts recording a screen; the same id again is the one already running. */
    async start({ key, user, bot, id, replace = false }) {
      const running = live.get(key);
      if (running && !running.ended) {
        if (running.id === id) return statusOf(running);
        // The API holds the one recording a person has open: one it no longer knows of is left over.
        if (!replace) throw Object.assign(new Error("Someone is already showing this bot something"), { status: 409 });
        this.discard(key);
      }
      if (!RECORDING_ID.test(id) || !SAFE_NAME.test(user)) throw Object.assign(new Error("Bad recording id"), { status: 400 });
      const dir = dirOf(user, id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const rec = {
        key,
        user,
        bot,
        id,
        dir,
        startedAt: now(),
        resumedAt: now(),
        activeMs: 0,
        paused: false,
        pausedFor: null,
        ended: null,
        timeline: null,
        frames: [],
        frameBytes: 0,
        lastFrameAt: 0,
        frameStep: null,
        listeners: new Set(),
        browser: false,
      };
      rec.timeline = createTimeline({ startedAt: rec.startedAt, now });
      live.set(key, rec);
      rec.browser = await Promise.resolve(browserRecord(rec, true)).then(
        () => true,
        () => false,
      );
      armLimit(rec);
      this.viewersChanged(key);
      writeSteps(rec);
      void shoot(rec, null);
      return statusOf(rec);
    },
    get: (key) => {
      const rec = live.get(key);
      return rec ? statusOf(rec) : null;
    },
    active: (key) => {
      const rec = live.get(key);
      return rec && !rec.ended && !rec.paused ? rec : null;
    },
    listen(key, listener) {
      const rec = live.get(key);
      if (!rec) return null;
      rec.listeners.add(listener);
      return () => rec.listeners.delete(listener);
    },
    pause: (key) => {
      const rec = live.get(key);
      if (rec) pause(rec);
      return rec ? statusOf(rec) : null;
    },
    resume: (key) => {
      const rec = live.get(key);
      if (rec) resume(rec);
      return rec ? statusOf(rec) : null;
    },
    finish: (key, why = "done") => {
      const rec = live.get(key);
      if (!rec) return null;
      end(rec, why);
      return statusOf(rec);
    },
    /** Ends a recording and forgets it, files and all. */
    discard(key) {
      const rec = live.get(key);
      if (!rec) return false;
      end(rec, "discarded");
      live.delete(key);
      fs.rmSync(rec.dir, { recursive: true, force: true });
      return true;
    },
    /** A step from the person's own input, placed in the window it happened in. */
    async desktopInput(key, { step, replace }) {
      const rec = live.get(key);
      if (!rec || rec.ended || rec.paused) return null;
      const pointed = ["click", "drag", "scroll"].includes(step.kind);
      const where = await Promise.resolve(windowAt(rec, pointed ? { x: step.x, y: step.y } : null)).catch(() => null);
      // The browser reports its page itself, more exactly; its window's own keys (Ctrl+L, Ctrl+T) still count.
      if (rec.browser && isBrowserWindow(where?.cls) && step.kind !== "key") return null;
      const outside = (step.kind === "type" || step.kind === "paste") && !isBrowserWindow(where?.cls);
      const app = isBrowserWindow(where?.cls) ? "the browser" : appName(where?.name);
      return add(rec, { ...step, layer: "desktop", app, ...(outside ? { outside: true } : {}) }, replace);
    },
    /** A step the bot's browser reported; the page's own words are cut to what a step may hold. */
    pageEvent(key, raw) {
      const rec = live.get(key);
      if (!rec || rec.ended || rec.paused) return null;
      if (raw?.kind === "navigate") {
        const url = String(raw.url ?? "").slice(0, 500);
        // A site that loads one page several times (redirects, history) makes one step of it.
        const last = rec.timeline.steps().at(-1);
        const again = last?.kind === "navigate" && samePage(last.url, url);
        return add(rec, { kind: "navigate", layer: "browser", url, title: String(raw.title ?? "").slice(0, 120) }, again);
      }
      if (raw?.kind === "tab_open" || raw?.kind === "tab_close") return add(rec, { kind: raw.kind, layer: "browser" });
      if (raw?.kind === "download") return add(rec, { kind: "download", layer: "browser", name: String(raw.name ?? "").slice(0, 200) });
      const step = pageStep(raw);
      if (!step) return null;
      if (typeof raw.url === "string" && /^https?:/.test(raw.url)) step.url = raw.url.slice(0, 500);
      return add(rec, step);
    },
    /** The browser stopped answering mid-recording: say so once, and carry on with the desktop. */
    lostBrowser(key) {
      const rec = live.get(key);
      if (!rec || rec.ended || !rec.browser) return;
      rec.browser = false;
      add(rec, { kind: "gap", layer: "browser" });
    },
    /** Pauses a recording nobody watches, and ends one left that way too long. */
    viewersChanged(key) {
      const rec = live.get(key);
      if (!rec || rec.ended) return;
      const count = viewers(rec);
      if (count > 0) {
        clear(rec, "awayTimer");
        clear(rec, "goneTimer");
        return;
      }
      if (!rec.awayTimer && !rec.paused) rec.awayTimer = timers.setTimeout(() => ((rec.awayTimer = null), pause(rec, "away")), AWAY_PAUSE_MS);
      if (!rec.goneTimer) rec.goneTimer = timers.setTimeout(() => ((rec.goneTimer = null), end(rec, "away")), AWAY_END_MS);
    },
    /** What a recording left on disk, after the box restarted without it in memory. */
    fromDisk(user, id) {
      if (!RECORDING_ID.test(id) || !SAFE_NAME.test(user)) return null;
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(dirOf(user, id), STEPS_FILE), "utf8"));
        return { id, bot: saved.bot, startedAt: new Date(saved.startedAt).toISOString(), activeMs: saved.activeMs ?? 0, maxMs, paused: false, pausedFor: null, ended: saved.ended ?? "restart", full: false, browser: false, steps: saved.steps ?? [], frames: saved.frames ?? [] };
      } catch {
        return null;
      }
    },
    framePath(user, id, n) {
      if (!RECORDING_ID.test(id) || !SAFE_NAME.test(user) || !Number.isInteger(n) || n < 1) return null;
      return path.join(dirOf(user, id), `frame-${n}.jpg`);
    },
    removeFromDisk(user, id) {
      if (!RECORDING_ID.test(id) || !SAFE_NAME.test(user)) return;
      fs.rmSync(dirOf(user, id), { recursive: true, force: true });
    },
    /** Everything a person's recordings left, when they are deleted. */
    removeUser(user) {
      if (SAFE_NAME.test(user)) fs.rmSync(path.join(root, user), { recursive: true, force: true });
    },
    keys: () => [...live.keys()],
    /**
     * The box is going down (an update, a restart): the recording is written as it stands and
     * dropped without a word, so whoever follows it waits for the box and finishes it from disk.
     */
    suspend(key) {
      const rec = live.get(key);
      if (!rec) return;
      if (!rec.ended) {
        rec.activeMs = activeMs(rec);
        rec.suspended = true;
        rec.paused = true;
      }
      for (const name of ["limitTimer", "awayTimer", "goneTimer", "frameTimer", "saving"]) clear(rec, name);
      writeSteps(rec);
      live.delete(key);
    },
    /** Recordings nobody came back for, a week on. */
    sweep(maxAgeMs = 7 * 24 * 60 * 60_000) {
      const cutoff = now() - maxAgeMs;
      for (const user of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        for (const id of fs.readdirSync(path.join(root, user))) {
          const dir = path.join(root, user, id);
          if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    forget(key) {
      const rec = live.get(key);
      if (rec && !rec.ended) end(rec, "stopped");
      live.delete(key);
    },
  };
}

