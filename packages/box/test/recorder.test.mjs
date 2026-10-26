import assert from "node:assert/strict";
import test from "node:test";
import { appName, createInputTracker, createRfbReader, createTimeline, keyChar, keyName, labelOf, pageStep } from "../recorder.mjs";

const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const handshake = bytes("RFB 003.008\n", [1], [1]);
const pointer = (mask, x, y) => bytes([5, mask], u16(x), u16(y));
const key = (down, keysym) => bytes([4, down ? 1 : 0], u16(0), u32(keysym));

test("the reader follows a viewer from its handshake through every message noVNC sends", () => {
  const reader = createRfbReader();
  const stream = bytes(
    handshake,
    bytes([0, 0, 0, 0], Buffer.alloc(16)),
    bytes([2, 0], u16(2), u32(7), u32(-223)),
    bytes([3, 1], u16(0), u16(0), u16(1280), u16(800)),
    bytes([150, 1], u16(0), u16(0), u16(1280), u16(800)),
    bytes([248, 0, 0, 0], u32(0x80000000), [3], "abc"),
    bytes([251, 0], u16(1280), u16(800), [1, 0], Buffer.alloc(16)),
    pointer(1, 10, 20),
    bytes([5, 0x80], u16(11), u16(21), [0]),
    key(true, 0x61),
    bytes([255, 0], u16(0), u32(0x62), u32(48)),
    bytes([6, 0, 0, 0], u32(5), "hello"),
    bytes([6, 0, 0, 0], u32(-4), [0, 0, 0, 1]),
  );
  // Fed a byte at a time, as a network might split it.
  const events = [];
  for (const byte of stream) events.push(...reader.feed(Buffer.from([byte])));
  assert.equal(reader.lost, false);
  assert.deepEqual(events, [
    { type: "pointer", mask: 1, x: 10, y: 20 },
    { type: "pointer", mask: 0, x: 11, y: 21 },
    { type: "key", down: true, keysym: 0x61 },
    { type: "key", down: false, keysym: 0x62 },
    { type: "paste", text: "hello" },
  ]);
});

test("a message the reader doesn't know leaves it lost, rather than reading garbage", () => {
  const reader = createRfbReader();
  assert.deepEqual(reader.feed(bytes(handshake, [99, 1, 2, 3], pointer(1, 1, 1))), []);
  assert.equal(reader.lost, true);
  assert.deepEqual(reader.feed(pointer(0, 1, 1)), []);
});

test("keys read as characters and names", () => {
  assert.equal(keyChar(0x41), "A");
  assert.equal(keyChar(0xe9), "é");
  assert.equal(keyChar(0x010020ac), "€");
  assert.equal(keyChar(0xff0d), null);
  assert.equal(keyName(0xff0d), "Enter");
  assert.equal(keyName(0xffc1), "F4");
  assert.equal(keyName(0x73), "S");
});

test("the tracker makes clicks, double clicks, drags, scrolls, typing and shortcuts", () => {
  let t = 0;
  const tracker = createInputTracker({ now: () => t });
  const feed = (event) => tracker.feed(event);
  assert.deepEqual([...feed({ type: "pointer", mask: 1, x: 100, y: 100 }), ...feed({ type: "pointer", mask: 0, x: 101, y: 100 })], [{ step: { kind: "click", button: "left", x: 100, y: 100, count: 1 }, replace: false }]);
  t = 200;
  assert.deepEqual([...feed({ type: "pointer", mask: 1, x: 102, y: 101 }), ...feed({ type: "pointer", mask: 0, x: 102, y: 101 })], [{ step: { kind: "click", button: "left", x: 102, y: 101, count: 2 }, replace: true }]);
  t = 2000;
  assert.deepEqual([...feed({ type: "pointer", mask: 1, x: 10, y: 10 }), ...feed({ type: "pointer", mask: 1, x: 200, y: 10 }), ...feed({ type: "pointer", mask: 0, x: 200, y: 10 })], [{ step: { kind: "drag", button: "left", x: 10, y: 10, to_x: 200, to_y: 10 } }]);
  const scrolled = [];
  for (let i = 0; i < 3; i += 1) {
    t += 100;
    scrolled.push(...feed({ type: "pointer", mask: 16, x: 5, y: 6 }), ...feed({ type: "pointer", mask: 0, x: 5, y: 6 }));
  }
  assert.deepEqual(scrolled.map((o) => [o.step.amount, o.replace]), [
    [1, false],
    [2, true],
    [3, true],
  ]);
  const typing = [];
  for (const c of "hix") typing.push(...feed({ type: "key", down: true, keysym: c.charCodeAt(0) }), ...feed({ type: "key", down: false, keysym: c.charCodeAt(0) }));
  typing.push(...feed({ type: "key", down: true, keysym: 0xff08 }));
  assert.deepEqual(typing, []);
  assert.deepEqual(feed({ type: "key", down: true, keysym: 0xff0d }), [{ step: { kind: "type", text: "hi", enter: true } }]);
  feed({ type: "key", down: true, keysym: 0x61 });
  feed({ type: "key", down: true, keysym: 0xffe3 });
  assert.deepEqual(feed({ type: "key", down: true, keysym: 0x73 }), [{ step: { kind: "type", text: "a" } }, { step: { kind: "key", keys: "Ctrl+S" } }]);
});

test("a page's report is cut to known fields, and a private field never carries its value", () => {
  assert.deepEqual(pageStep({ kind: "fill", field: "Password", value: "hunter2", sensitive: "password", evil: 1 }), { kind: "fill", layer: "browser", field: "Password", sensitive: "password" });
  assert.deepEqual(pageStep({ kind: "click", name: "  View\n bill ", role: "button", x: 10.4, y: 20.6 }), { kind: "click", layer: "browser", name: "View bill", role: "button", x: 10, y: 21 });
  assert.equal(pageStep({ kind: "script", value: "x" }), null);
  assert.equal(labelOf({ kind: "fill", sensitive: "code" }), "Entered a sign-in code");
  assert.equal(labelOf({ kind: "navigate", url: "https://www.northsidepower.com/billing", title: "" }), "Opened northsidepower.com");
  assert.equal(labelOf({ kind: "type", text: "sudo apt update", enter: true, app: "Terminal" }), 'Typed "sudo apt update" and pressed Enter in Terminal');
});

test("the timeline numbers steps, keeps a field's last fill, merges a double click and stops at its limit", () => {
  let t = 1000;
  const timeline = createTimeline({ startedAt: 0, now: () => t, maxSteps: 3 });
  timeline.add({ kind: "fill", layer: "browser", field: "Email", value: "a" });
  timeline.add({ kind: "fill", layer: "browser", field: "Email", value: "ab@example.com" });
  t = 2000;
  timeline.add({ kind: "click", layer: "desktop", button: "left", count: 1, app: "Files" });
  timeline.add({ kind: "click", layer: "desktop", button: "left", count: 2, app: "Files" }, { replace: true });
  assert.deepEqual(timeline.steps().map((s) => [s.n, s.at, s.label]), [
    [1, 1000, 'Typed "ab@example.com" into Email'],
    [2, 2000, "Double-clicked in Files"],
  ]);
  timeline.add({ kind: "submit", layer: "browser" });
  assert.equal(timeline.add({ kind: "submit", layer: "browser" }), null);
  assert.equal(timeline.full, true);
});

test("a window's title reads as the app a person would name", () => {
  assert.equal(appName("plank"), "the dock");
  assert.equal(appName("Terminal - agent@4ea63d95a50a: ~"), "Terminal");
  assert.equal(appName("Bills - File Manager"), "Bills - File Manager");
  assert.equal(appName(""), "");
});
