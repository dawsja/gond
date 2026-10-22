import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { clearForeignLock, createBrowser, errorLine, profileHolder, SCROLL_PIXELS } from "../browser-host.mjs";
import { createBrowsers } from "../browser.mjs";
import { parseSteps } from "../computer.mjs";

const FAKE_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-browser-host.mjs");
const start = () => spawn(process.execPath, [FAKE_HOST], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
const alice = { id: "alice" };
const bob = { id: "bob" };

test("each bot keeps one browser host across batches, and a dead one is replaced", async () => {
  const browsers = createBrowsers({ start, launchMs: 5_000 });
  try {
    const first = await browsers.run(alice, [{ type: "screenshot" }]);
    const second = await browsers.run(alice, [{ type: "click" }]);
    assert.equal(first.pid, second.pid);
    assert.deepEqual(second.steps, [{ type: "click" }]);
    const other = await browsers.run(bob, [{ type: "screenshot" }]);
    assert.notEqual(other.pid, first.pid);
    const otherBot = await browsers.run(alice, [{ type: "screenshot" }], undefined, { bot: "b-net" });
    assert.notEqual(otherBot.pid, first.pid);
    browsers.close("alice", "b-net");
    assert.equal(browsers.running("alice", "b-net"), false);
    assert.equal(browsers.running("alice"), true);

    await assert.rejects(browsers.run(alice, [{ type: "die" }]), (error) => error.status === 502 && /closed/.test(error.message));
    assert.equal(browsers.running("alice"), false);
    const again = await browsers.run(alice, [{ type: "screenshot" }]);
    assert.notEqual(again.pid, first.pid);

    await assert.rejects(browsers.run(alice, [{ type: "fail" }]), (error) => error.status === 502 && error.message === "it broke");
    assert.equal((await browsers.run(alice, [{ type: "screenshot" }])).pid, again.pid);
  } finally {
    browsers.closeAll();
  }
});

test("a host that stops answering is dropped, and closing ends what was waiting", async () => {
  const browsers = createBrowsers({ start, launchMs: 0, batchMs: () => 300 });
  try {
    const before = await browsers.run(alice, [{ type: "screenshot" }]);
    await assert.rejects(browsers.run(alice, [{ type: "stall" }]), (error) => error.status === 504);
    assert.notEqual((await browsers.run(alice, [{ type: "screenshot" }])).pid, before.pid);

    const waiting = browsers.run(bob, [{ type: "stall" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    browsers.close("bob");
    await assert.rejects(waiting, /closed/);
    assert.equal(browsers.running("bob"), false);

    const abort = new AbortController();
    const aborted = browsers.run(alice, [{ type: "stall" }], abort.signal);
    abort.abort();
    await assert.rejects(aborted, (error) => error.status === 499);
  } finally {
    browsers.closeAll();
  }
});

test("an idle host closes on its own", async () => {
  const browsers = createBrowsers({ start, idleMs: 30, launchMs: 5_000 });
  await browsers.run(alice, [{ type: "screenshot" }]);
  assert.equal(browsers.running("alice"), true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(browsers.running("alice"), false);
});

function fakeContext() {
  const calls = [];
  const listeners = {};
  const pages = [];
  const makePage = (url = "about:blank", title = "") => {
    const page = {
      url: () => url,
      title: async () => title,
      closed: false,
      isClosed: () => page.closed,
      mouse: {
        click: async (x, y, options) => calls.push(["click", x, y, options.button, options.clickCount]),
        move: async (x, y) => calls.push(["move", x, y]),
        down: async () => calls.push(["down"]),
        up: async () => calls.push(["up"]),
        wheel: async (dx, dy) => calls.push(["wheel", dx, dy]),
      },
      keyboard: {
        type: async (text) => calls.push(["type", text]),
        press: async (key) => calls.push(["press", key]),
      },
      goto: async (to) => {
        if (to.includes("nowhere")) throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nowhere.invalid/\nCall log:\n  - navigating");
        url = to;
        calls.push(["goto", to]);
      },
      goBack: async () => calls.push(["back"]),
      goForward: async () => calls.push(["forward"]),
      reload: async () => calls.push(["reload"]),
      bringToFront: async () => calls.push(["front", url]),
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
      screenshot: async () => {
        const png = Buffer.alloc(24);
        png.writeUInt32BE(0x89504e47, 0);
        png.writeUInt32BE(0x0d0a1a0a, 4);
        png.write("IHDR", 12, "latin1");
        png.writeUInt32BE(1280, 16);
        png.writeUInt32BE(800, 20);
        return png;
      },
    };
    pages.push(page);
    return page;
  };
  const context = {
    pages: () => pages,
    newPage: async () => makePage(),
    on: (event, fn) => {
      listeners[event] = fn;
    },
    close: async () => calls.push(["close"]),
    popup: (url, title, opener) => {
      const page = makePage(url, title);
      if (opener) page.opener = async () => opener;
      listeners.page(page);
    },
  };
  return { context, calls, pages };
}

const steps = (...list) => parseSteps(list, "browser", { width: 1280, height: 800 });

test("the browser runs a batch in order with the mouse and keyboard, and answers with the page", async () => {
  const { context, calls } = fakeContext();
  let launches = 0;
  const browser = createBrowser({ launch: async () => (launches++, context) });
  const result = await browser.run(steps({ type: "navigate", url: "example.com" }, { type: "click", x: 10, y: 20 }, { type: "type", text: "dr pepper" }, { type: "key", key: "Enter" }, { type: "scroll", direction: "down", amount: 2, x: 5, y: 6 }));
  assert.deepEqual(calls, [
    ["goto", "https://example.com/"],
    ["click", 10, 20, "left", 1],
    ["type", "dr pepper"],
    ["press", "Enter"],
    ["move", 5, 6],
    ["wheel", 0, 2 * SCROLL_PIXELS],
  ]);
  assert.equal(result.url, "https://example.com/");
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert.equal(typeof result.image, "string");
  assert.equal(result.error, null);
  assert.equal(result.done.length, 5);
  await browser.run(steps({ type: "screenshot" }));
  assert.equal(launches, 1);
});

test("a failed step stops the batch, says why in one line, and still shows the page", async () => {
  const { context, calls } = fakeContext();
  const browser = createBrowser({ launch: async () => context });
  const result = await browser.run(steps({ type: "click", x: 1, y: 1 }, { type: "navigate", url: "nowhere.invalid" }, { type: "type", text: "never" }));
  assert.deepEqual(result.error, { index: 1, message: "net::ERR_NAME_NOT_RESOLVED at https://nowhere.invalid/" });
  assert.equal(result.done.length, 1);
  assert.ok(!calls.some(([name]) => name === "type"));
  assert.equal(errorLine(new Error("locator.click: Timeout 30000ms exceeded.\nCall log:")), "Timeout 30000ms exceeded.");
});

test("a page that opens a tab is followed, and tab switches between them", async () => {
  const { context, calls } = fakeContext();
  const browser = createBrowser({ launch: async () => context });
  await browser.run(steps({ type: "navigate", url: "example.com" }));
  context.popup("https://checkout.example.com/", "Checkout");
  const followed = await browser.run(steps({ type: "screenshot" }));
  assert.equal(followed.url, "https://checkout.example.com/");
  assert.deepEqual(followed.tabs.map((tab) => [tab.index, tab.active]), [
    [0, false],
    [1, true],
  ]);
  const back = await browser.run(steps({ type: "tab", index: 0 }));
  assert.equal(back.url, "https://example.com/");
  assert.deepEqual(calls.at(-1), ["front", "https://example.com/"]);
  const missing = await browser.run(steps({ type: "tab", index: 5 }));
  assert.match(missing.error.message, /no tab 5/);
});

test("each bot works in tabs of its own, and a tab its page opens is its own", async () => {
  const { context, calls, pages } = fakeContext();
  const browser = createBrowser({ launch: async () => context });
  await browser.run(steps({ type: "navigate", url: "example.com" }), { owner: "ada" });
  const bo = await browser.run(steps({ type: "navigate", url: "other.com" }), { owner: "bo" });
  assert.equal(bo.url, "https://other.com/");
  assert.deepEqual(bo.tabs.map((tab) => tab.url), ["https://other.com/"]);

  const ada = await browser.run(steps({ type: "screenshot" }), { owner: "ada" });
  assert.equal(ada.url, "https://example.com/");
  assert.deepEqual(ada.tabs.map((tab) => tab.url), ["https://example.com/"]);
  assert.deepEqual(calls.at(-1), ["front", "https://example.com/"]);

  context.popup("https://checkout.example.com/", "Checkout", pages[0]);
  assert.equal((await browser.run(steps({ type: "screenshot" }), { owner: "bo" })).url, "https://other.com/");
  const followed = await browser.run(steps({ type: "screenshot" }), { owner: "ada" });
  assert.equal(followed.url, "https://checkout.example.com/");
  assert.equal(followed.tabs.length, 2);
  assert.match((await browser.run(steps({ type: "tab", index: 1 }), { owner: "bo" })).error.message, /no tab 1; you have 1/);
});

test("profileHolder names a live Chrome holding the profile, and nothing else", async () => {
  const lock = (target) => async () => target;
  assert.equal(await profileHolder("/p", { readlink: lock("box-4242"), alive: () => true, hostname: "box" }), 4242);
  assert.equal(await profileHolder("/p", { readlink: lock("my-box-host-4242"), alive: () => true, hostname: "my-box-host" }), 4242);
  assert.equal(await profileHolder("/p", { readlink: lock("box-4242"), alive: () => false, hostname: "box" }), null);
  assert.equal(await profileHolder("/p", { readlink: async () => Promise.reject(new Error("ENOENT")), alive: () => true, hostname: "box" }), null);
  assert.equal(await profileHolder("/p", { readlink: lock(`box-${process.pid}`), alive: () => true, hostname: "box" }), null);
  // A pid from the container before an update means nothing here, and may be another process.
  assert.equal(await profileHolder("/p", { readlink: lock("old-box-4242"), alive: () => true, hostname: "box" }), null);
});

test("clearForeignLock clears a lock another host left, and only that", async () => {
  const lock = (target) => async () => target;
  const removed = [];
  const rm = async (file) => void removed.push(file);
  assert.equal(await clearForeignLock("/p", { readlink: lock("3f9a2c1d7e4b-88"), rm, hostname: "b71c0e5d2a93" }), true);
  assert.deepEqual(removed, ["/p/SingletonLock", "/p/SingletonSocket", "/p/SingletonCookie"]);
  removed.length = 0;
  assert.equal(await clearForeignLock("/p", { readlink: lock("b71c0e5d2a93-88"), rm, hostname: "b71c0e5d2a93" }), false);
  assert.equal(await clearForeignLock("/p", { readlink: async () => Promise.reject(new Error("ENOENT")), rm, hostname: "box" }), false);
  assert.deepEqual(removed, []);
});
