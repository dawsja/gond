import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_ONLY,
  MAX_LABEL_CHARS,
  MAX_STEPS,
  STEP_TIMEOUT_MS,
  STEP_TYPES,
  batchTimeoutMs,
  browserKey,
  controlTransition,
  describeStep,
  normalizeUrl,
  parseSteps,
  pngSize,
  settleMs,
  stepTimeoutMs,
  thumbSize,
  usesInput,
  xdoKey,
  xdotoolArgv,
  xdotoolStdin,
} from "../computer.mjs";

const screen = { width: 1280, height: 800 };
const desktop = (...steps) => parseSteps(steps, "desktop", screen);
const browser = (...steps) => parseSteps(steps, "browser", screen);
const one = (step) => desktop(step)[0];
const argv = (step) => xdotoolArgv(one(step));
const rejects = (steps, pattern, target = "desktop") => assert.throws(() => parseSteps(steps, target, screen), (error) => error.status === 400 && pattern.test(error.message));

test("a batch is a list of known steps, at most twenty, and names the one that is wrong", () => {
  assert.equal(desktop({ type: "screenshot" }).length, 1);
  rejects([], /at least one/);
  rejects(null, /list/);
  rejects(Array.from({ length: MAX_STEPS + 1 }, () => ({ type: "screenshot" })), /At most 20/);
  rejects([{ type: "screenshot" }, { type: "launch_missiles" }], /^Step 2: Unknown step/);
  rejects([{ type: "screenshot" }, "click"], /^Step 2: each step must be an object/);
  assert.throws(() => parseSteps([{ type: "screenshot" }], "desktop", { width: 0, height: 0 }), /No screen/);
  assert.throws(() => parseSteps([{ type: "screenshot" }], "phone", screen), /target/);
});

test("browser steps are the browser's alone", () => {
  for (const type of BROWSER_ONLY) assert.ok(STEP_TYPES.includes(type));
  rejects([{ type: "navigate", url: "example.com" }], /is for the browser tool/);
  rejects([{ type: "back" }], /is for the browser tool/);
  assert.deepEqual(browser({ type: "navigate", url: "example.com" }, { type: "back" }, { type: "tab", index: 1 }), [
    { type: "navigate", url: "https://example.com/" },
    { type: "back" },
    { type: "tab", index: 1 },
  ]);
  rejects([{ type: "tab", index: -1 }], /tab needs index/, "browser");
  rejects([{ type: "tab" }], /tab needs index/, "browser");
});

test("navigate opens http and https only, and a bare host gets https", () => {
  assert.equal(normalizeUrl("example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.throws(() => normalizeUrl("file:///etc/passwd"), /http and https/);
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /http and https/);
  assert.throws(() => normalizeUrl("chrome://settings"), /http and https/);
  assert.throws(() => normalizeUrl(""), /needs url/);
  assert.throws(() => normalizeUrl("x".repeat(5000)), /too long/);
});

test("clicks move to the point when given, with the button and count asked for", () => {
  assert.deepEqual(argv({ type: "click", x: 10, y: 20 }), ["xdotool", "mousemove", "10", "20", "click", "1"]);
  assert.deepEqual(argv({ type: "click" }), ["xdotool", "click", "1"]);
  assert.deepEqual(argv({ type: "click", x: 5, y: 5, button: "right" }), ["xdotool", "mousemove", "5", "5", "click", "3"]);
  assert.deepEqual(argv({ type: "click", button: "middle" }), ["xdotool", "click", "2"]);
  assert.deepEqual(argv({ type: "click", x: 1, y: 2, count: 2 }), ["xdotool", "mousemove", "1", "2", "click", "--repeat", "2", "--delay", "80", "1"]);
  rejects([{ type: "click", button: "fourth" }], /button/);
  rejects([{ type: "click", count: 4 }], /count/);
  rejects([{ type: "click", x: 1 }], /needs x and y/);
});

test("a move needs a point and a drag needs both ends", () => {
  assert.deepEqual(argv({ type: "move", x: 3, y: 4 }), ["xdotool", "mousemove", "3", "4"]);
  rejects([{ type: "move" }], /move needs x and y/);
  assert.deepEqual(argv({ type: "drag", x: 1, y: 2, to_x: 30, to_y: 40 }), ["xdotool", "mousemove", "1", "2", "mousedown", "1", "mousemove", "--sync", "30", "40", "mouseup", "1"]);
  rejects([{ type: "drag", x: 1, y: 2 }], /needs to_x and to_y/);
});

test("points are rounded and clamped to the area they are in", () => {
  assert.deepEqual(one({ type: "move", x: 10.6, y: 20.4 }).at, [11, 20]);
  assert.deepEqual(one({ type: "move", x: 99999, y: -5 }).at, [1279, 0]);
  assert.deepEqual(parseSteps([{ type: "move", x: 2000, y: 2000 }], "browser", { width: 1280, height: 800 })[0].at, [1279, 799]);
});

test("typing goes through stdin, bounded, and a secret is never described", () => {
  const typed = one({ type: "type", text: "hello; rm -rf ~" });
  assert.deepEqual(xdotoolArgv(typed), ["xdotool", "type", "--delay", "12", "--clearmodifiers", "--file", "-"]);
  assert.equal(xdotoolStdin(typed), "hello; rm -rf ~");
  assert.equal(describeStep(typed), "typed 15 characters");
  const secret = one({ type: "type", text: "hunter2", secret: true });
  assert.equal(describeStep(secret), "typed a sign-in detail");
  assert.ok(!describeStep(secret).includes("hunter2"));
  rejects([{ type: "type" }], /type needs text/);
  rejects([{ type: "type", text: "x".repeat(2001) }], /2000 characters/);
});

test("key names a model uses become xdotool's on the desktop and the browser's in the browser", () => {
  assert.equal(xdoKey("Enter"), "Return");
  assert.equal(xdoKey("ctrl+L"), "ctrl+L");
  assert.equal(xdoKey("cmd+shift+t"), "super+shift+t");
  assert.equal(xdoKey("ArrowDown"), "Down");
  assert.equal(xdoKey("F5"), "F5");
  assert.throws(() => xdoKey("ctrl+;rm"), /Bad key/);
  assert.throws(() => xdoKey("ctrl++"), /Bad key chord/);
  assert.equal(browserKey("Enter"), "Enter");
  assert.equal(browserKey("Return"), "Enter");
  assert.equal(browserKey("ctrl+l"), "Control+l");
  assert.equal(browserKey("cmd+shift+t"), "Meta+Shift+t");
  assert.equal(browserKey("space"), "Space");
  assert.equal(browserKey("pagedown"), "PageDown");
  assert.equal(browserKey("Backspace"), "Backspace");
  assert.deepEqual(argv({ type: "key", key: "ctrl+a Delete" }), ["xdotool", "key", "--clearmodifiers", "ctrl+a", "Delete"]);
  assert.deepEqual(browser({ type: "key", key: "ctrl+a Delete" })[0].keys, ["Control+a", "Delete"]);
  rejects([{ type: "key" }], /key needs key/);
});

test("scrolling is wheel clicks, 1 to 20 of them, at the point when given", () => {
  assert.deepEqual(argv({ type: "scroll", direction: "down" }), ["xdotool", "click", "--repeat", "3", "--delay", "30", "5"]);
  assert.deepEqual(argv({ type: "scroll", direction: "up", amount: 99, x: 5, y: 6 }), ["xdotool", "mousemove", "5", "6", "click", "--repeat", "20", "--delay", "30", "4"]);
  assert.equal(one({ type: "scroll", direction: "left", amount: 0 }).amount, 1);
  rejects([{ type: "scroll", direction: "sideways" }], /direction/);
});

test("wait is bounded to ten seconds and runs nothing; looking is not input", () => {
  assert.equal(one({ type: "wait", ms: 60_000 }).ms, 10_000);
  assert.equal(one({ type: "wait" }).ms, 1000);
  assert.equal(argv({ type: "wait", ms: 10 }), null);
  assert.equal(argv({ type: "screenshot" }), null);
  assert.equal(usesInput(desktop({ type: "screenshot" }, { type: "wait", ms: 5 })), false);
  assert.equal(usesInput(desktop({ type: "screenshot" }, { type: "click" })), true);
  assert.equal(usesInput(browser({ type: "navigate", url: "example.com" })), true);
});

test("a batch gets the time its steps need, and settles before the screenshot only after input", () => {
  assert.equal(stepTimeoutMs(one({ type: "type", text: "abcd" })), STEP_TIMEOUT_MS + 60);
  assert.equal(stepTimeoutMs(one({ type: "wait", ms: 2000 })), STEP_TIMEOUT_MS + 2000);
  assert.equal(batchTimeoutMs(desktop({ type: "click" }, { type: "click" })), STEP_TIMEOUT_MS * 3);
  assert.equal(settleMs(desktop({ type: "screenshot" })), 0);
  assert.equal(settleMs(desktop({ type: "key", key: "Return" })), 400);
});

test("a screenshot's long edge fits the model", () => {
  assert.deepEqual(thumbSize({ width: 1280, height: 800 }), { width: 1024, height: 640 });
  assert.deepEqual(thumbSize({ width: 800, height: 1280 }), { width: 640, height: 1024 });
  assert.deepEqual(thumbSize({ width: 1024, height: 768 }), { width: 1024, height: 768 });
  assert.deepEqual(thumbSize({ width: 640, height: 480 }), { width: 640, height: 480 });
  assert.deepEqual(thumbSize({ width: 3840, height: 2160 }), { width: 1024, height: 576 });
  assert.deepEqual(thumbSize({ width: 1280, height: 800 }, 640), { width: 640, height: 400 });
  assert.deepEqual(thumbSize({ width: 0, height: 0 }), { width: 1, height: 1 });
});

test("control moves to the person or back to free; from: bots only changes what a bot held", () => {
  assert.equal(controlTransition("free", { holder: "person" }), "person");
  assert.equal(controlTransition("bots", { holder: "person" }), "person");
  assert.equal(controlTransition("person", { holder: "free" }), "free");
  assert.equal(controlTransition("bots", { holder: "free", from: "bots" }), "free");
  assert.equal(controlTransition("bots", { holder: "person", from: "bots" }), "person");
  assert.equal(controlTransition("person", { holder: "free", from: "bots" }), null);
  assert.equal(controlTransition("free", { holder: "free", from: "bots" }), null);
  assert.throws(() => controlTransition("free", { holder: "bots" }), /holder must be person or free/);
  assert.throws(() => controlTransition("free", {}), /holder/);
  assert.throws(() => controlTransition("free", null), /holder/);
  assert.throws(() => controlTransition("free", { holder: "free", from: "person" }), /from can only be bots/);
});

test("a PNG's size is read from its header, and other bytes are not a PNG", () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(640, 20);
  assert.deepEqual(pngSize(png), { width: 1024, height: 640 });
  assert.equal(pngSize(Buffer.from("not a png at all, just some text here")), null);
  assert.equal(pngSize(Buffer.alloc(3)), null);
  assert.equal(pngSize(null), null);
});

test("a browser step can name an element by its ref, and the browser's own steps check what they need", () => {
  assert.deepEqual(browser({ type: "click", ref: "e12" })[0], { type: "click", ref: "e12", at: null, button: "left", count: 1 });
  assert.deepEqual(browser({ type: "hover", ref: "f3e7" })[0], { type: "move", ref: "f3e7", at: null });
  assert.deepEqual(browser({ type: "fill", ref: "e4", text: "a@b.c" })[0], { type: "fill", ref: "e4", text: "a@b.c", secret: false });
  assert.deepEqual(browser({ type: "fill", ref: "e4" })[0].text, "");
  assert.deepEqual(browser({ type: "select", ref: "e6", option: "Large" })[0].options, ["Large"]);
  assert.deepEqual(browser({ type: "select", ref: "e6", option: ["A", "B"] })[0].options, ["A", "B"]);
  assert.equal(browser({ type: "check", ref: "e8", checked: false })[0].checked, false);
  assert.deepEqual(browser({ type: "drag", ref: "e1", to_ref: "e2" })[0], { type: "drag", ref: "e1", toRef: "e2" });
  assert.deepEqual(browser({ type: "scroll", ref: "e9" })[0], { type: "scroll", ref: "e9", direction: null, amount: 0 });
  assert.deepEqual(browser({ type: "read" })[0], { type: "read" });
  assert.deepEqual(browser({ type: "wait_for", text: "Order placed" })[0], { type: "wait_for", text: "Order placed", url: null, gone: false, ms: 10_000 });
  assert.equal(browser({ type: "wait_for", url: "/checkout", ms: 99_000 })[0].ms, 30_000);
  assert.deepEqual(browser({ type: "new_tab" })[0], { type: "new_tab", url: null });
  assert.equal(browser({ type: "new_tab", url: "example.com" })[0].url, "https://example.com/");
  assert.deepEqual(browser({ type: "close_tab" })[0], { type: "close_tab", index: null });
  assert.deepEqual(browser({ type: "dialog", accept: false })[0], { type: "dialog", accept: false, text: null });
  assert.deepEqual(browser({ type: "upload", ref: "e10", path: "~/note.pdf" })[0], { type: "upload", ref: "e10", path: "~/note.pdf" });
  assert.deepEqual(browser({ type: "paste", text: "hello" })[0], { type: "paste", text: "hello" });

  rejects([{ type: "fill", text: "x" }], /needs ref/, "browser");
  rejects([{ type: "select", ref: "e6" }], /option/, "browser");
  rejects([{ type: "click", ref: "e 12" }], /ref must be/, "browser");
  rejects([{ type: "drag", ref: "e1" }], /ref and to_ref/, "browser");
  rejects([{ type: "wait_for" }], /text .* or url/, "browser");
  rejects([{ type: "new_tab", url: "file:///etc/passwd" }], /http and https/, "browser");
  rejects([{ type: "click", ref: "e12" }], /on the desktop use x and y/);
  rejects([{ type: "fill", ref: "e4", text: "x" }], /for the browser tool/);
});

test("copy, paste and the clipboard work on both, and the reads only look", () => {
  assert.deepEqual(desktop({ type: "copy" }, { type: "paste" }, { type: "clipboard" }), [{ type: "copy" }, { type: "paste", text: null }, { type: "clipboard" }]);
  assert.equal(usesInput(browser({ type: "read" }, { type: "wait_for", text: "x" }, { type: "clipboard" })), false);
  assert.equal(usesInput(browser({ type: "copy" })), true);
  assert.equal(describeStep(browser({ type: "fill", ref: "e4", text: "pw", secret: true })[0]), "filled e4 with a sign-in detail");
  assert.equal(describeStep(browser({ type: "select", ref: "e6", option: "Large" })[0]), 'picked "Large" in e6');
  assert.equal(describeStep(browser({ type: "wait_for", text: "Done", gone: true })[0]), 'waited for "Done" to go');
  assert.equal(describeStep(desktop({ type: "paste", text: "abc" })[0]), "pasted 3 characters");
  assert.equal(stepTimeoutMs(browser({ type: "wait_for", text: "x", ms: 20_000 })[0]), 20_000 + STEP_TIMEOUT_MS);
});

test("a browser step can name an element by label instead, for a page it hasn't seen", () => {
  assert.deepEqual(browser({ type: "click", label: " Add to order ", role: "button" })[0], { type: "click", find: { label: "Add to order", role: "button", exact: false }, at: null, button: "left", count: 1 });
  assert.deepEqual(browser({ type: "select", label: "Drink", option: "Dr Pepper" })[0], { type: "select", find: { label: "Drink", role: null, exact: false }, options: ["Dr Pepper"] });
  assert.deepEqual(browser({ type: "read", label: "Total", exact: true })[0].find, { label: "Total", role: null, exact: true });
  assert.equal(describeStep(browser({ type: "click", label: "Checkout" })[0]), 'clicked "Checkout"');

  rejects([{ type: "click", ref: "e1", label: "Checkout" }], /not both/, "browser");
  rejects([{ type: "click", role: "button" }], /role goes with label/, "browser");
  rejects([{ type: "click", label: "Go", role: "Big Button" }], /ARIA role/, "browser");
  rejects([{ type: "click", label: "x".repeat(MAX_LABEL_CHARS + 1) }], /label must be/, "browser");
  rejects([{ type: "click", label: "Checkout" }], /on the desktop use x and y/);
});
