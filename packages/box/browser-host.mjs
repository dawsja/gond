// The bots' browser for one person, run as that person. It holds one
// Playwright persistent context (Chrome on their desktop, a profile in their
// home) for as long as the box keeps it, and runs batches of steps that
// server.mjs has already checked with parseSteps. One JSON object per line:
// in, { id, op: "run", steps } or { id, op: "close" }; out, { id, result }
// or { id, error }.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { spawn } from "node:child_process";
import { describeStep, DRAG_PRESS_MS, DRAG_STEP_MS, dragPath, LOOK_STEPS, NAVIGATE_TIMEOUT_MS, pngSize, SETTLE_MS } from "./computer.mjs";
import { takeLines } from "./gond-mcp.mjs";
import { compactSnapshot, snapshotControls } from "./snapshot.mjs";

export const VIEWPORT = { width: 1280, height: 800 };
export const SCROLL_PIXELS = 100;
const SHOT_TIMEOUT_MS = 15_000;
const LOAD_WAIT_MS = 5_000;

const SCROLL_DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Playwright's errors carry a call log after the first line; the model needs the first line. */
export function errorLine(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].replace(/^[a-zA-Z.]+: /, "").slice(0, 300);
}

const ACTION_TIMEOUT_MS = 5_000;
// A label may name something on a page that is still loading.
const FIND_TIMEOUT_MS = 8_000;
const LABEL_ROLES = ["button", "link", "menuitem", "tab", "option", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox"];
const QUIET_MS = 150;
const SETTLE_MAX_MS = 1_500;
const DOWNLOAD_WAIT_MS = 15_000;
export const MAX_READ_CHARS = 20_000;
const JPEG_QUALITY = 75;

/** The X clipboard of the person's display, which their Chrome and desktop share. */
export const xclipClipboard = { read: () => readXclip(), write: (text) => writeXclip(text) };

export function readXclip(spawnAs = spawn, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnAs("xclip", ["-selection", "clipboard", "-o"], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => reject(new Error(`The clipboard isn't available: ${error.message}`)));
    child.on("close", (code) => {
      // An empty clipboard is an error to xclip; to the bot it is just empty.
      if (code !== 0 && !/not available/i.test(err)) reject(new Error(`The clipboard failed: ${err.trim().slice(0, 200) || `xclip exited ${code}`}`));
      else resolve(out);
    });
  });
}

/**
 * xclip -i forks to keep serving the selection and holds whatever stdout it
 * was given, so a caller waiting for the pipe to close would wait forever:
 * its output goes nowhere and the first process's exit is the answer.
 */
export function writeXclip(text, spawnAs = spawn, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnAs("xclip", ["-selection", "clipboard", "-i"], { ...options, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) => reject(new Error(`The clipboard isn't available: ${error.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`The clipboard failed: xclip exited ${code}`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(text);
  });
}

export const clipText = (text, max = MAX_READ_CHARS) => (text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters]` : text);

const centerOf = (box) => (box ? [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] : null);

function refError(error, ref) {
  const line = errorLine(error);
  if (/aria-ref|no element|not attached|detached/i.test(line)) return new Error(`${ref} isn't on the page any more; use the refs from the newest element list`);
  if (/Timeout \d+ms exceeded/.test(line)) return new Error(`${ref} didn't become ready to use (hidden, covered or disabled): ${line}`);
  return error;
}

/**
 * The refs whose box is in the viewport but can't be hit at its middle: an
 * element scrolled out of a panel keeps its box, and a click there lands on
 * whatever the panel shows instead. Runs in the page.
 */
function clippedOf(boxes) {
  const near = (a, b) => Math.abs(a - b) < 1.5;
  const hits = (root, x, y) => root.elementsFromPoint(x, y).flatMap((el) => (el.shadowRoot && el.shadowRoot !== root ? [el, ...hits(el.shadowRoot, x, y)] : [el]));
  return boxes
    .filter(({ x, y, width, height }) => {
      const left = Math.max(x, 0);
      const top = Math.max(y, 0);
      const right = Math.min(x + width, innerWidth);
      const bottom = Math.min(y + height, innerHeight);
      if (right <= left || bottom <= top) return false;
      const [cx, cy] = [(left + right) / 2, (top + bottom) / 2];
      return !hits(document, cx, cy).some((el) => {
        const r = el.getBoundingClientRect();
        return near(r.x, x) && near(r.y, y) && near(r.width, width) && near(r.height, height);
      });
    })
    .map(({ ref }) => ref);
}

/** Waits for the DOM to stop changing for a moment, or SETTLE_MAX_MS, whichever comes first. */
function quiet({ quietMs, maxMs }) {
  return new Promise((resolve) => {
    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    function done() {
      observer.disconnect();
      resolve();
    }
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, quietMs);
    setTimeout(done, maxMs);
  });
}

function uniqueName(dir, wanted, exists) {
  const safe = path.basename(wanted || "download").replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 200) || "download";
  const dot = safe.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
  for (let n = 1; ; n++) {
    const name = n === 1 ? safe : `${stem} (${n})${ext}`;
    if (!exists(path.join(dir, name))) return name;
  }
}

export function createBrowser({ launch, clipboard = xclipClipboard, downloadsDir = path.join(os.homedir(), "Downloads") }) {
  let context = null;
  let active = null;
  let mouse = { x: 0, y: 0 };
  let dialog = null;
  const dialogWaiters = [];
  const downloads = [];
  const saving = [];

  const watch = (page) => {
    page.on?.("dialog", (opened) => {
      // Leaving a page with unsaved changes is the step's own intent.
      if (opened.type() === "beforeunload") return void opened.accept().catch(() => undefined);
      dialog = { page, opened, type: opened.type(), message: opened.message() };
      for (const waiter of dialogWaiters.splice(0)) waiter();
    });
    page.on?.("download", (download) => {
      saving.push(
        (async () => {
          await fs.mkdir(downloadsDir, { recursive: true });
          const taken = new Set((await fs.readdir(downloadsDir).catch(() => [])).map((name) => path.join(downloadsDir, name)));
          const name = uniqueName(downloadsDir, download.suggestedFilename(), (file) => taken.has(file));
          await download.saveAs(path.join(downloadsDir, name));
          downloads.push(`~/Downloads/${name}`);
        })().catch((error) => downloads.push(`a download failed: ${errorLine(error)}`)),
      );
    });
  };

  const open = async () => {
    if (context) return context;
    context = await launch();
    context.on("page", (page) => {
      watch(page);
      active = page;
    });
    for (const page of context.pages()) watch(page);
    active = context.pages().at(-1) ?? (await context.newPage());
    return context;
  };

  const livePages = () => context.pages().filter((p) => !p.isClosed());

  const page = async () => {
    await open();
    if (!active || active.isClosed()) active = livePages().at(-1) ?? (await context.newPage());
    return active;
  };

  const element = (current, ref) => current.locator(`aria-ref=${ref}`);

  // What a person would call it, best guess first: a control with that name, then a field with that label or hint, then any text.
  // Each kind is tried as an exact match, then text that starts with the label, then text that has it anywhere: "Total" is the total, not the subtotal.
  const candidates = (current, { label, role, exact }) => {
    const starts = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const tiers = exact ? [{ exact: true }] : [{ exact: true }, { starts: true }, { exact: false }];
    const by = (find) => tiers.map((tier) => find(tier.starts ? starts : label, tier.starts ? {} : { exact: tier.exact }));
    if (role) return by((name, options) => current.getByRole(role, { name, ...options }));
    return [
      ...LABEL_ROLES.flatMap((name) => by((text, options) => current.getByRole(name, { name: text, ...options })).slice(0, 1)),
      ...by((text, options) => current.getByLabel(text, options)).slice(0, 1),
      ...by((text, options) => current.getByPlaceholder(text, options)).slice(0, 1),
      ...LABEL_ROLES.flatMap((name) => by((text, options) => current.getByRole(name, { name: text, ...options })).slice(1)),
      ...by((text, options) => current.getByText(text, options)),
    ];
  };

  // A site that draws its own checkbox hides the input itself; its label is what a person clicks, and Playwright reads the state through it.
  const labelOf = async (current, candidate) => {
    const input = candidate.first();
    const kind = await input.evaluate((el) => (el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type) ? el.id || "-" : null)).catch(() => null);
    if (!kind) return null;
    const around = input.locator("xpath=ancestor::label[1]");
    const label = kind === "-" ? around : around.or(current.locator(`label[for="${kind.replace(/["\\]/g, "\\$&")}"]`));
    const shown = label.filter({ visible: true });
    return (await shown.count().catch(() => 0)) > 0 ? shown.first() : null;
  };

  const findByLabel = async (current, find) => {
    const deadline = Date.now() + FIND_TIMEOUT_MS;
    for (;;) {
      for (const candidate of candidates(current, find)) {
        const shown = candidate.filter({ visible: true });
        if ((await shown.count().catch(() => 0)) > 0) return shown.first();
        if ((await candidate.count().catch(() => 0)) > 0) {
          const label = await labelOf(current, candidate);
          if (label) return label;
        }
      }
      if (Date.now() > deadline) throw new Error(`Nothing ${find.role ? `with role ${find.role} ` : ""}labelled ${JSON.stringify(find.label)} appeared on the page`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  // A click that opens a dialog never finishes on its own: the page is paused until the dialog is answered.
  const untilDialog = (action) => {
    let stop;
    const opened = new Promise((resolve) => (stop = resolve));
    dialogWaiters.push(stop);
    action.catch(() => undefined);
    return Promise.race([action, opened]).finally(() => dialogWaiters.splice(dialogWaiters.indexOf(stop) >>> 0, 1));
  };

  const onElement = async (current, step, act) => {
    if (step.find) {
      const el = await findByLabel(current, step.find);
      return untilDialog(act(el));
    }
    const el = element(current, step.ref);
    try {
      if ((await el.count()) === 0) throw new Error(`no element ${step.ref}`);
      return await untilDialog(act(el));
    } catch (error) {
      throw refError(error, step.ref);
    }
  };

  // Each step answers with text for the model when it read something.
  const runStep = async (step) => {
    const current = await page();
    if (dialog && step.type !== "dialog" && !dialog.page.isClosed()) {
      throw new Error(`A ${dialog.type} dialog is open ("${dialog.message.slice(0, 200)}"); answer it with dialog {accept: true or false} first`);
    }
    const options = { timeout: ACTION_TIMEOUT_MS };
    switch (step.type) {
      case "screenshot":
        return null;
      case "click":
        if (step.ref || step.find) {
          await onElement(current, step, (el) => el.click({ ...options, button: step.button, clickCount: step.count }));
          return null;
        }
        if (step.at) mouse = { x: step.at[0], y: step.at[1] };
        await untilDialog(current.mouse.click(mouse.x, mouse.y, { button: step.button, clickCount: step.count, delay: 30 }));
        return null;
      case "move":
        if (step.ref || step.find) {
          await onElement(current, step, (el) => el.hover(options));
          return null;
        }
        mouse = { x: step.at[0], y: step.at[1] };
        await current.mouse.move(mouse.x, mouse.y, { steps: 4 });
        return null;
      case "drag": {
        let from = step.from;
        let to = step.to;
        if (step.ref) {
          for (const ref of [step.ref, step.toRef]) if ((await element(current, ref).count()) === 0) throw refError(new Error(`no element ${ref}`), ref);
          const source = element(current, step.ref);
          await source.scrollIntoViewIfNeeded(options).catch((error) => {
            throw refError(error, step.ref);
          });
          from = centerOf(await source.boundingBox());
          to = centerOf(await element(current, step.toRef).boundingBox());
          if (!from || !to) throw new Error(`${from ? step.toRef : step.ref} isn't showing, so it can't be dragged`);
        }
        await current.mouse.move(from[0], from[1]);
        await current.mouse.down();
        await current.waitForTimeout(DRAG_PRESS_MS);
        for (const [x, y] of dragPath(from, to)) {
          await current.mouse.move(x, y);
          await current.waitForTimeout(DRAG_STEP_MS);
        }
        await current.waitForTimeout(step.hold);
        await current.mouse.up();
        mouse = { x: to[0], y: to[1] };
        return null;
      }
      case "type":
        if (step.ref || step.find) await onElement(current, step, (el) => el.click(options));
        await current.keyboard.type(step.text, { delay: 12 });
        return null;
      case "fill":
        await onElement(current, step, (el) => el.fill(step.text, options));
        return null;
      case "select":
        await onElement(current, step, (el) => el.selectOption(step.options, options));
        return null;
      case "check":
        await onElement(current, step, (el) => el.setChecked(step.checked, options));
        return null;
      case "upload":
        await onElement(current, step, (el) => el.setInputFiles(step.path, options));
        return null;
      case "read": {
        const text = step.ref || step.find ? await onElement(current, step, (el) => el.innerText(options)) : await current.locator("body").innerText(options);
        return clipText(text.replace(/\n{3,}/g, "\n\n").trim());
      }
      case "copy": {
        if (step.ref || step.find) {
          const text = await onElement(current, step, (el) => el.innerText(options));
          await clipboard.write(text);
        } else {
          await current.keyboard.press("ControlOrMeta+c");
        }
        return clipText(await clipboard.read());
      }
      case "paste":
        if (step.text !== null) await clipboard.write(step.text);
        await current.keyboard.press("ControlOrMeta+v");
        return null;
      case "clipboard":
        return clipText(await clipboard.read());
      case "wait_for":
        if (step.url) {
          await current.waitForURL((url) => url.href.includes(step.url), { timeout: step.ms, waitUntil: "commit" });
          return null;
        }
        await current.getByText(step.text).first().waitFor({ state: step.gone ? "hidden" : "visible", timeout: step.ms });
        return null;
      case "dialog": {
        if (!dialog) throw new Error("No dialog is open");
        const { opened } = dialog;
        dialog = null;
        if (step.accept) await opened.accept(step.text ?? undefined);
        else await opened.dismiss();
        return null;
      }
      case "key":
        for (const chord of step.keys) {
          await untilDialog(current.keyboard.press(chord));
          if (dialog) break;
        }
        return null;
      case "scroll": {
        if ((step.ref || step.find) && !step.direction) {
          await onElement(current, step, (el) => el.scrollIntoViewIfNeeded(options));
          return null;
        }
        if (step.ref || step.find) await onElement(current, step, (el) => el.hover(options));
        else if (step.at) {
          mouse = { x: step.at[0], y: step.at[1] };
          await current.mouse.move(mouse.x, mouse.y);
        }
        const [dx, dy] = SCROLL_DELTA[step.direction];
        await current.mouse.wheel(dx * step.amount * SCROLL_PIXELS, dy * step.amount * SCROLL_PIXELS);
        return null;
      }
      case "wait":
        await current.waitForTimeout(step.ms);
        return null;
      case "navigate":
        await current.goto(step.url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
        return null;
      case "back":
        await current.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
        return null;
      case "forward":
        await current.goForward({ waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
        return null;
      case "reload":
        await current.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
        return null;
      case "tab": {
        const pages = livePages();
        if (step.index >= pages.length) throw new Error(`There is no tab ${step.index}; there are ${pages.length}`);
        active = pages[step.index];
        await active.bringToFront();
        return null;
      }
      case "new_tab": {
        const opened = await context.newPage();
        active = opened;
        await opened.bringToFront();
        if (step.url) await opened.goto(step.url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
        return null;
      }
      case "close_tab": {
        const pages = livePages();
        const target = step.index === null ? current : pages[step.index];
        if (!target) throw new Error(`There is no tab ${step.index}; there are ${pages.length}`);
        // Closing the last tab would close the window, and the person's browser with it.
        if (pages.length === 1) throw new Error("That is the only tab; navigate it somewhere else instead");
        await target.close();
        active = livePages().at(-1);
        await active.bringToFront();
        return null;
      }
      default:
        throw new Error(`Unknown step ${step.type}`);
    }
  };

  const settle = async (current) => {
    await current.waitForLoadState("domcontentloaded", { timeout: LOAD_WAIT_MS }).catch(() => undefined);
    if (current.evaluate) await current.evaluate(quiet, { quietMs: QUIET_MS, maxMs: SETTLE_MAX_MS }).catch(() => undefined);
    else await current.waitForTimeout(SETTLE_MS);
  };

  const viewOf = async (current) => (current.evaluate ? await current.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null) : null);

  const elementsOf = async (current, view) => {
    if (!current.ariaSnapshot || !view) return null;
    try {
      const snapshot = await current.ariaSnapshot({ mode: "ai", boxes: true, timeout: SHOT_TIMEOUT_MS });
      // A ref inside a frame has its box in the frame's own page, which this document can't hit-test.
      const boxes = snapshotControls(snapshot)
        .filter(({ ref }) => !/^f\d/.test(ref))
        .map(({ ref, box }) => ({ ref, ...box }));
      const clipped = await current.evaluate(clippedOf, boxes).catch(() => []);
      return compactSnapshot(snapshot, view, new Set(clipped));
    } catch {
      return null;
    }
  };

  /** `view`: "both" (screenshot and element list), "image" or "text". */
  const run = async (steps, { view = "both", format = "jpeg" } = {}) => {
    const done = [];
    const outputs = [];
    let error = null;
    downloads.length = 0;
    for (const [index, step] of steps.entries()) {
      try {
        const text = await runStep(step);
        if (text !== null && text !== undefined) outputs.push({ index, text });
        done.push(describeStep(step));
      } catch (caught) {
        error = { index, message: errorLine(caught) };
        break;
      }
    }
    // An open dialog pauses the page's scripts, and a screenshot or snapshot with it would wait forever.
    const blocked = () => dialog !== null && !dialog.page.isClosed();
    if (steps.some((step) => !LOOK_STEPS.has(step.type)) && !blocked()) await settle(await page());
    if (saving.length) await Promise.race([Promise.all(saving.splice(0)), new Promise((resolve) => setTimeout(resolve, DOWNLOAD_WAIT_MS))]);
    const shown = await page();
    const size = (blocked() ? null : await viewOf(shown)) ?? VIEWPORT;
    const elements = view === "image" || blocked() ? null : await elementsOf(shown, size);
    let shot = null;
    if (view !== "text" && !blocked()) {
      const image = await shown.screenshot(format === "png" ? { type: "png", timeout: SHOT_TIMEOUT_MS } : { type: "jpeg", quality: JPEG_QUALITY, timeout: SHOT_TIMEOUT_MS });
      const measured = pngSize(image) ?? size;
      shot = { image: image.toString("base64"), mime: format === "png" ? "image/png" : "image/jpeg", width: measured.width, height: measured.height };
    }
    const tabs = await Promise.all(livePages().map(async (p, index) => ({ index, title: await p.title().catch(() => ""), url: p.url(), active: p === shown })));
    return {
      ...shot,
      ...(shot ? {} : { width: size.width, height: size.height }),
      url: shown.url(),
      title: await shown.title().catch(() => ""),
      tabs,
      done,
      error,
      outputs,
      elements: elements ? { text: elements.text, note: elements.note } : null,
      dialog: dialog ? { type: dialog.type, message: dialog.message.slice(0, 500) } : null,
      downloads: [...downloads],
    };
  };

  const close = async () => {
    const current = context;
    context = null;
    active = null;
    dialog = null;
    await current?.close().catch(() => undefined);
  };

  return { run, close, opened: () => context !== null };
}

// Like a Chrome the person opens: maximized on their desktop, its page as big
// as the window, without the "controlled by automated test software" bar.
// No debugging port: Playwright drives it over a pipe only this host holds.
export const CHROME_ARGS = [
  "--start-maximized",
  "--password-store=basic",
  "--hide-crash-restore-bubble",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
];

function lockOf(target) {
  const at = target?.lastIndexOf("-") ?? -1;
  return at > 0 ? { host: target.slice(0, at), pid: Number(target.slice(at + 1)) } : null;
}

/** The pid of a Chrome on this host already holding the profile (its SingletonLock reads "host-pid"), if it is alive. */
export async function profileHolder(profile, { readlink = fs.readlink, alive = isAlive, hostname = os.hostname() } = {}) {
  const lock = lockOf(await readlink(path.join(profile, "SingletonLock")).catch(() => null));
  if (!lock || lock.host !== hostname) return null;
  return Number.isInteger(lock.pid) && lock.pid > 0 && lock.pid !== process.pid && alive(lock.pid) ? lock.pid : null;
}

/**
 * A lock left by a Chrome on another host is stale: the box's container was
 * made again (an update) with a new hostname, and the profile kept its lock.
 * Chrome won't clear one it can't check and refuses to open the profile.
 */
export async function clearForeignLock(profile, { readlink = fs.readlink, rm = fs.rm, hostname = os.hostname() } = {}) {
  const lock = lockOf(await readlink(path.join(profile, "SingletonLock")).catch(() => null));
  if (!lock || lock.host === hostname) return false;
  await Promise.all(["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) => rm(path.join(profile, name), { force: true })));
  return true;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A Chrome the person opened from the dock shares this profile, so their
// sign-ins are the bots'. If it is still running when the bots need the
// browser it is closed (Chrome saves its session on SIGTERM) and this one
// opens the profile instead; two can't hold it at once.
async function freeProfile(profile) {
  const pid = await profileHolder(profile);
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 5_000 && isAlive(pid); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
}

async function launchChrome() {
  const { chromium } = await import("playwright-core");
  const profile = process.env.GOND_BROWSER_PROFILE;
  if (!profile) throw new Error("GOND_BROWSER_PROFILE is not set");
  await clearForeignLock(profile);
  await freeProfile(profile);
  const headless = process.env.GOND_BROWSER_HEADLESS === "1";
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || "/usr/local/bin/google-chrome",
    headless,
    // Headed, the page is the maximized window's; headless has no window to take it from.
    viewport: headless ? VIEWPORT : null,
    ignoreDefaultArgs: ["--enable-automation"],
    acceptDownloads: true,
    args: headless ? [...CHROME_ARGS, `--window-size=${VIEWPORT.width},${VIEWPORT.height}`] : CHROME_ARGS,
  });
  // The person closed the window: this host ends, and the next batch opens a new one.
  context.on("close", () => process.exit(0));
  return context;
}

function main() {
  const browser = createBrowser({ launch: launchChrome });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let queue = Promise.resolve();
  const input = { pending: "" };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const line of takeLines(input, chunk)) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // One batch at a time: two bots of the person's share this browser, as they share the desktop.
      queue = queue.then(async () => {
        try {
          if (message.op === "run") send({ id: message.id, result: await browser.run(message.steps, { view: message.view, format: message.format }) });
          else if (message.op === "close") {
            await browser.close();
            send({ id: message.id, result: { ok: true } });
          } else send({ id: message.id, error: `Unknown op ${message.op}` });
        } catch (error) {
          send({ id: message.id, error: errorLine(error) });
        }
      });
    }
  });
  const quit = () => {
    void browser.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", quit);
  process.on("SIGTERM", quit);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
