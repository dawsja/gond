import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRecordings } from "../recordings.mjs";

function fakeTimers() {
  let clock = 0;
  let next = 1;
  const pending = new Map();
  return {
    now: () => clock,
    timers: {
      setTimeout: (fn, ms) => {
        const id = next++;
        pending.set(id, { at: clock + ms, fn });
        return id;
      },
      clearTimeout: (id) => pending.delete(id),
    },
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      clock = until;
    },
  };
}

function setup({ viewers = 1, window = { name: "Terminal", cls: "xfce4-terminal" }, maxMs = 10_000 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teach-"));
  const clock = fakeTimers();
  const state = { viewers, window, recording: [] };
  const recordings = createRecordings({
    root: path.join(home, "teach"),
    takeFrame: async (_rec, file) => {
      fs.writeFileSync(file, "jpeg");
      return { width: 1280, height: 800, bytes: 4 };
    },
    windowAt: async () => state.window,
    browserRecord: async (_rec, on) => state.recording.push(on),
    viewers: () => state.viewers,
    now: clock.now,
    timers: clock.timers,
    maxMs,
  });
  return { home, clock, state, recordings };
}

test("a recording gathers the person's steps with a screenshot each, and keeps them on disk", async () => {
  const { home, clock, state, recordings } = setup();
  const heard = [];
  const status = await recordings.start({ key: "k", user: "u", bot: "b", id: "teach-0001" });
  assert.equal(status.browser, true);
  recordings.listen("k", (event) => heard.push(event.type));
  await clock.advance(1_000);
  assert.equal(recordings.get("k").frames.length, 1);

  state.window = { name: "Patch's browser - Google Chrome", cls: "Google-chrome" };
  assert.equal(await recordings.desktopInput("k", { step: { kind: "click", button: "left", x: 1, y: 1, count: 1 } }), null);
  assert.equal((await recordings.desktopInput("k", { step: { kind: "key", keys: "Ctrl+L" } })).label, "Pressed Ctrl+L in the browser");
  recordings.pageEvent("k", { kind: "navigate", url: "https://www.google.com/search?q=power+bill&sca=1", title: "power bill - Google Search" });
  recordings.pageEvent("k", { kind: "navigate", url: "https://www.google.com/search?q=power+bill&sca=2", title: "power bill - Google Search" });
  recordings.pageEvent("k", { kind: "navigate", url: "https://example.com/bills", title: "Your bills" });
  recordings.pageEvent("k", { kind: "fill", field: "Password", value: "hunter2", sensitive: "password", url: "https://example.com/" });
  state.window = { name: "Terminal", cls: "xfce4-terminal" };
  const typed = await recordings.desktopInput("k", { step: { kind: "type", text: "ls", enter: true } });
  assert.equal(typed.outside, true);
  await clock.advance(1_000);

  const now = recordings.get("k");
  assert.deepEqual(now.steps.map((s) => s.label), ["Pressed Ctrl+L in the browser", 'Searched Google for "power bill"', "Opened Your bills", "Typed a password", 'Typed "ls" and pressed Enter in Terminal']);
  assert.ok(!JSON.stringify(now).includes("hunter2"));
  assert.ok(now.frames.length >= 2);
  assert.ok(heard.includes("step") && heard.includes("frame"));

  const done = recordings.finish("k");
  assert.equal(done.ended, "done");
  assert.deepEqual(state.recording, [true, false]);
  assert.equal(await recordings.desktopInput("k", { step: { kind: "key", keys: "Ctrl+S" } }), null);
  const saved = recordings.fromDisk("u", "teach-0001");
  assert.equal(saved.steps.length, 5);
  assert.equal(saved.ended, "done");
  assert.ok(fs.existsSync(recordings.framePath("u", "teach-0001", 1)));
  recordings.discard("k");
  assert.equal(fs.existsSync(path.join(home, "teach", "u", "teach-0001")), false);
});

test("paused time doesn't count, the limit ends it, and nobody watching pauses then ends it", async () => {
  const { home, clock, state, recordings } = setup();
  await recordings.start({ key: "k", user: "u", bot: "b", id: "teach-0002" });
  await clock.advance(4_000);
  recordings.pause("k");
  await clock.advance(60_000);
  assert.equal(recordings.get("k").ended, null);
  assert.equal(recordings.get("k").activeMs, 4_000);
  recordings.resume("k");
  await clock.advance(6_000);
  assert.equal(recordings.get("k").ended, "limit");
});

test("nobody watching pauses a recording, and ends it after long enough", async () => {
  const { home, clock, state, recordings } = setup({ maxMs: 10 * 60 * 60_000 });
  await recordings.start({ key: "k2", user: "u", bot: "b2", id: "teach-0003" });
  state.viewers = 0;
  recordings.viewersChanged("k2");
  await clock.advance(31_000);
  assert.equal(recordings.get("k2").paused, true);
  assert.equal(recordings.get("k2").pausedFor, "away");
  await clock.advance(30 * 60_000);
  assert.equal(recordings.get("k2").ended, "away");
});

test("one recording per screen: the same id is the one running, another is refused", async () => {
  const { home, recordings } = setup();
  await recordings.start({ key: "k", user: "u", bot: "b", id: "teach-0004" });
  assert.equal((await recordings.start({ key: "k", user: "u", bot: "b", id: "teach-0004" })).id, "teach-0004");
  await assert.rejects(recordings.start({ key: "k", user: "u", bot: "b", id: "teach-0005" }), (error) => error.status === 409);
  assert.equal((await recordings.start({ key: "k", user: "u", bot: "b", id: "teach-0005", replace: true })).id, "teach-0005");
  assert.equal(recordings.fromDisk("u", "teach-0004"), null);
  assert.equal(recordings.fromDisk("u", "../etc"), null);
  assert.equal(recordings.fromDisk("../u", "teach-0004"), null);
  assert.equal(recordings.framePath("u", "teach-0004", 0), null);
});

test("a box going down keeps a recording to finish later, telling nobody it ended", async () => {
  const { clock, recordings } = setup();
  const heard = [];
  await recordings.start({ key: "k", user: "u", bot: "b", id: "teach-0006" });
  recordings.listen("k", (event) => heard.push(event));
  await recordings.desktopInput("k", { step: { kind: "key", keys: "Ctrl+S" } });
  await clock.advance(500);
  heard.length = 0;
  recordings.suspend("k");
  assert.equal(recordings.get("k"), null);
  assert.deepEqual(heard, []);
  const saved = recordings.fromDisk("u", "teach-0006");
  assert.equal(saved.ended, "restart");
  assert.equal(saved.steps.length, 1);
});
