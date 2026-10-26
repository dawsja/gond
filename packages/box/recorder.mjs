// What "Show me how" records: the person's own input on a bot's screen, read
// from the VNC messages their viewer sends (never the bots', which go through
// XTEST), and what the bot's browser reports about each page. Everything here
// is pure, so it is tested without a screen.

export const TEACH_MAX_MS = 10 * 60_000;
export const TEACH_MAX_STEPS = 300;
export const TEACH_MAX_FRAMES = 120;
export const TEACH_MAX_FRAME_BYTES = 15 * 1024 * 1024;

const VERSION_BYTES = 12;

/**
 * Reads what a VNC viewer sends, from its first byte: the version, the
 * security type (the box's screens use None, so nothing follows it), the
 * client init, then messages. Answers the pointer, key and clipboard events
 * in them; a message it doesn't know leaves it `lost`, since it can no longer
 * tell where the next one starts.
 */
export function createRfbReader() {
  let pending = Buffer.alloc(0);
  let phase = "version";
  let lost = false;

  const take = () => {
    const events = [];
    for (;;) {
      if (phase === "version") {
        if (pending.length < VERSION_BYTES) return events;
        pending = pending.subarray(VERSION_BYTES);
        phase = "security";
        continue;
      }
      if (phase === "security" || phase === "init") {
        if (pending.length < 1) return events;
        pending = pending.subarray(1);
        phase = phase === "security" ? "init" : "messages";
        continue;
      }
      if (pending.length < 1) return events;
      const length = messageLength(pending);
      if (length === -1) {
        lost = true;
        pending = Buffer.alloc(0);
        return events;
      }
      if (length === 0 || pending.length < length) return events;
      const message = pending.subarray(0, length);
      pending = pending.subarray(length);
      const event = eventOf(message);
      if (event) events.push(event);
    }
  };

  return {
    feed(chunk) {
      if (lost) return [];
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      return take();
    },
    get lost() {
      return lost;
    },
  };
}

/** A message's full length from its first bytes; 0 while too few have come to tell, -1 for a type this doesn't know. */
function messageLength(buffer) {
  const type = buffer[0];
  const need = (n) => buffer.length >= n;
  switch (type) {
    case 0:
      return 20;
    case 2:
      return need(4) ? 4 + 4 * buffer.readUInt16BE(2) : 0;
    case 3:
      return 10;
    case 4:
      return 8;
    case 5:
      // The marker bit says an extended pointer event, with one more byte of buttons.
      return need(2) ? (buffer[1] & 0x80 ? 7 : 6) : 0;
    case 6:
      return need(8) ? 8 + Math.abs(buffer.readInt32BE(4)) : 0;
    case 150:
      return 10;
    case 248:
      return need(9) ? 9 + buffer[8] : 0;
    case 250:
      return 4;
    case 251:
      return need(7) ? 8 + 16 * buffer[6] : 0;
    case 255:
      if (!need(2)) return 0;
      return buffer[1] === 0 ? 12 : -1;
    default:
      return -1;
  }
}

function eventOf(message) {
  switch (message[0]) {
    case 4:
      return { type: "key", down: message[1] !== 0, keysym: message.readUInt32BE(4) };
    case 255:
      return { type: "key", down: message.readUInt16BE(2) !== 0, keysym: message.readUInt32BE(4) };
    case 5: {
      const extended = message[1] & 0x80;
      const mask = (message[1] & 0x7f) | (extended ? message[6] << 7 : 0);
      return { type: "pointer", mask, x: message.readUInt16BE(2), y: message.readUInt16BE(4) };
    }
    case 6: {
      const length = message.readInt32BE(4);
      // A negative length is the extended clipboard's own protocol, not text.
      return length > 0 ? { type: "paste", text: message.subarray(8).toString("latin1") } : null;
    }
    default:
      return null;
  }
}

const NAMED = new Map([
  [0xff0d, "Enter"],
  [0xff8d, "Enter"],
  [0xff08, "Backspace"],
  [0xff09, "Tab"],
  [0xff1b, "Escape"],
  [0xffff, "Delete"],
  [0xff50, "Home"],
  [0xff57, "End"],
  [0xff51, "Left"],
  [0xff52, "Up"],
  [0xff53, "Right"],
  [0xff54, "Down"],
  [0xff55, "Page Up"],
  [0xff56, "Page Down"],
  [0xff63, "Insert"],
  [0x0020, "Space"],
]);
const MODIFIERS = new Map([
  [0xffe1, "Shift"],
  [0xffe2, "Shift"],
  [0xffe3, "Ctrl"],
  [0xffe4, "Ctrl"],
  [0xffe9, "Alt"],
  [0xffea, "Alt"],
  [0xffe7, "Super"],
  [0xffe8, "Super"],
  [0xffeb, "Super"],
  [0xffec, "Super"],
  [0xfe03, "Alt"],
]);

/** The character a keysym types, or null for one that types none. */
export function keyChar(keysym) {
  if (keysym >= 0x20 && keysym <= 0x7e) return String.fromCharCode(keysym);
  if (keysym >= 0xa0 && keysym <= 0xff) return String.fromCharCode(keysym);
  if (keysym >= 0x01000100 && keysym <= 0x0110ffff) return String.fromCodePoint(keysym - 0x01000000);
  if (keysym >= 0xffb0 && keysym <= 0xffb9) return String(keysym - 0xffb0);
  return null;
}

/** A key's name for a shortcut ("S" in Ctrl+S, "F5", "Enter"). */
export function keyName(keysym) {
  if (NAMED.has(keysym)) return NAMED.get(keysym);
  if (keysym >= 0xffbe && keysym <= 0xffd5) return `F${keysym - 0xffbe + 1}`;
  const char = keyChar(keysym);
  return char ? char.toUpperCase() : null;
}

const DOUBLE_MS = 400;
const DOUBLE_PX = 6;
const DRAG_PX = 10;
const SCROLL_MS = 900;
const BUTTONS = [
  [1, "left"],
  [2, "middle"],
  [4, "right"],
];
const WHEEL = [
  [8, "up"],
  [16, "down"],
  [32, "left"],
  [64, "right"],
];

/**
 * Turns the person's pointer and key events into steps: clicks (a second
 * close by in time and place makes a double click), drags, scrolls run
 * together, typing gathered into one step until something else happens,
 * and shortcuts. `replace` says the step takes the place of the last one.
 */
export function createInputTracker({ now = Date.now } = {}) {
  let mask = 0;
  let down = null;
  let lastClick = null;
  let lastScroll = null;
  let typed = "";
  let at = { x: 0, y: 0 };
  const held = new Set();

  const flush = () => {
    if (!typed) return [];
    const step = { kind: "type", text: typed };
    typed = "";
    return [{ step }];
  };

  const pointer = (event) => {
    const out = [];
    const before = mask;
    mask = event.mask;
    at = { x: event.x, y: event.y };
    for (const [bit, button] of BUTTONS) {
      const pressed = !(before & bit) && mask & bit;
      const released = before & bit && !(mask & bit);
      if (pressed) {
        out.push(...flush());
        down = { button, x: event.x, y: event.y };
      } else if (released && down?.button === button) {
        const moved = Math.hypot(event.x - down.x, event.y - down.y);
        if (moved > DRAG_PX) {
          out.push({ step: { kind: "drag", button, x: down.x, y: down.y, to_x: event.x, to_y: event.y } });
          lastClick = null;
        } else {
          const t = now();
          const again = lastClick && lastClick.button === button && t - lastClick.at < DOUBLE_MS && Math.hypot(down.x - lastClick.x, down.y - lastClick.y) <= DOUBLE_PX;
          const count = again ? lastClick.count + 1 : 1;
          out.push({ step: { kind: "click", button, x: down.x, y: down.y, count }, replace: Boolean(again) });
          lastClick = { button, x: down.x, y: down.y, at: t, count };
        }
        down = null;
      }
    }
    for (const [bit, direction] of WHEEL) {
      if (before & bit || !(mask & bit)) continue;
      const t = now();
      const more = lastScroll && lastScroll.direction === direction && t - lastScroll.at < SCROLL_MS;
      const amount = more ? lastScroll.amount + 1 : 1;
      if (!more) out.push(...flush());
      out.push({ step: { kind: "scroll", direction, amount, x: event.x, y: event.y }, replace: Boolean(more) });
      lastScroll = { direction, at: t, amount };
    }
    return out;
  };

  const key = (event) => {
    const modifier = MODIFIERS.get(event.keysym);
    if (modifier) {
      if (event.down) held.add(modifier);
      else held.delete(modifier);
      return [];
    }
    if (!event.down) return [];
    const combo = held.has("Ctrl") || held.has("Alt") || held.has("Super");
    const char = keyChar(event.keysym);
    if (!combo && char !== null) {
      typed += char;
      return [];
    }
    if (!combo && event.keysym === 0xff08) {
      typed = typed.slice(0, -1);
      return [];
    }
    const name = keyName(event.keysym);
    if (!name) return [];
    if (!combo && name === "Enter" && typed) {
      const step = { kind: "type", text: typed, enter: true };
      typed = "";
      return [{ step }];
    }
    const keys = [...["Ctrl", "Alt", "Shift", "Super"].filter((m) => held.has(m) && (combo || m !== "Shift")), name].join("+");
    return [...flush(), { step: { kind: "key", keys } }];
  };

  return {
    feed(event) {
      if (event.type === "pointer") return pointer(event);
      if (event.type === "key") return key(event);
      if (event.type === "paste" && event.text) return [...flush(), { step: { kind: "paste", text: event.text.slice(0, 500) } }];
      return [];
    },
    /** What is typed so far, as a step, when something else (a page's own event, Done) needs the timeline settled. */
    flush,
    pointerAt: () => at,
  };
}

const clip = (text, n) => {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** What a Google search address searched for, or null. */
function searchOf(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)google\.[a-z.]+$/.test(parsed.hostname) && parsed.pathname === "/search" ? parsed.searchParams.get("q") : null;
  } catch {
    return null;
  }
}

/** Two addresses of one page: the same site and path, whatever the query says. */
export function samePage(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname === y.pathname && (searchOf(a) ?? "") === (searchOf(b) ?? "");
  } catch {
    return false;
  }
}

/** A window's title as the app a person would name: the dock, or Terminal without the user and host it adds. */
export function appName(title) {
  const name = String(title ?? "").trim();
  if (!name) return "";
  if (/^plank$/i.test(name)) return "the dock";
  if (/^xfdesktop$|^desktop$/i.test(name)) return "the desktop";
  // "Terminal - agent@host: ~" and the like: what follows the dash is a prompt, not the app.
  const [first, ...rest] = name.split(" - ");
  if (rest.length && /\S+@\S+/.test(rest.join(" - "))) return first.trim();
  return name;
}

const SENSITIVE_LABELS = { password: "Typed a password", code: "Entered a sign-in code", card: "Typed card details" };

/** A step in the words the person and the bot read. */
export function labelOf(step) {
  const app = step.app ? ` in ${clip(step.app, 40)}` : "";
  switch (step.kind) {
    case "navigate": {
      const searched = searchOf(step.url);
      return searched ? `Searched Google for "${clip(searched, 60)}"` : `Opened ${clip(step.title || hostOf(step.url) || step.url, 60)}`;
    }
    case "click":
      if (step.layer === "browser") return step.name ? `Clicked "${clip(step.name, 60)}"` : `Clicked a ${step.role || "spot"} on the page`;
      return `${step.count >= 2 ? "Double-clicked" : step.button === "right" ? "Right-clicked" : step.button === "middle" ? "Middle-clicked" : "Clicked"}${app || " on the desktop"}`;
    case "drag":
      return `Dragged${app || " on the desktop"}`;
    case "scroll":
      return `Scrolled ${step.direction}${app}`;
    case "fill":
      if (step.sensitive) return SENSITIVE_LABELS[step.sensitive] ?? "Typed something private";
      return `Typed "${clip(step.value, 60)}"${step.field ? ` into ${clip(step.field, 40)}` : ""}`;
    case "select":
      return `Picked "${clip(step.value, 50)}"${step.field ? ` in ${clip(step.field, 40)}` : ""}`;
    case "check":
      return `${step.checked ? "Ticked" : "Unticked"} ${clip(step.field || "a box", 50)}`;
    case "enter":
      return "Pressed Enter";
    case "submit":
      return "Sent the form";
    case "type":
      return `Typed "${clip(step.text, 60)}"${step.enter ? " and pressed Enter" : ""}${app}`;
    case "paste":
      return `Pasted "${clip(step.text, 60)}"${app}`;
    case "key":
      return `Pressed ${step.keys}${app}`;
    case "tab_open":
      return "Opened a new tab";
    case "tab_close":
      return "Closed a tab";
    case "download":
      return `Downloaded ${clip(step.name, 60)}`;
    case "upload":
      return `Uploaded ${clip(step.name, 60)}`;
    case "gap":
      return "I lost sight of the page for a moment";
    default:
      return "Did something";
  }
}

/** The fields a step from the browser's page script may carry, and nothing else, cut to size. */
export function pageStep(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kinds = new Set(["click", "fill", "select", "check", "enter", "submit", "upload"]);
  if (!kinds.has(raw.kind)) return null;
  const step = { kind: raw.kind, layer: "browser" };
  const text = (key, n) => {
    if (typeof raw[key] === "string" && raw[key].trim()) step[key] = clip(raw[key], n);
  };
  text("name", 120);
  text("role", 30);
  text("field", 80);
  if (raw.kind === "upload") text("name", 200);
  if (["password", "code", "card"].includes(raw.sensitive)) step.sensitive = raw.sensitive;
  else if (raw.kind === "fill" || raw.kind === "select") text("value", 300);
  if (raw.kind === "check") step.checked = raw.checked === true;
  for (const key of ["x", "y"]) if (Number.isFinite(raw[key])) step[key] = Math.round(raw[key]);
  return step;
}

/**
 * One recording's steps in order, each numbered, timed from the start and
 * labelled. A page's fill of the same field twice in a row keeps the last;
 * past `maxSteps` nothing more is added, and `full` says so.
 */
export function createTimeline({ startedAt = Date.now(), now = Date.now, maxSteps = TEACH_MAX_STEPS } = {}) {
  const steps = [];
  let full = false;
  const add = (step, { replace = false } = {}) => {
    const last = steps.at(-1);
    const same = last && step.kind === "fill" && last.kind === "fill" && last.layer === step.layer && last.field === step.field && last.url === step.url;
    if (((replace && last?.kind === step.kind && last.layer === step.layer) || same) && last) {
      const merged = { ...step, n: last.n, at: last.at, frame: last.frame ?? null };
      merged.label = labelOf(merged);
      steps[steps.length - 1] = merged;
      return { step: merged, replaced: true };
    }
    if (steps.length >= maxSteps) {
      full = true;
      return null;
    }
    const added = { ...step, n: steps.length + 1, at: Math.max(0, now() - startedAt), frame: null };
    added.label = labelOf(added);
    steps.push(added);
    return { step: added, replaced: false };
  };
  return {
    add,
    steps: () => steps,
    get full() {
      return full;
    },
    setFrame(n, frame) {
      const step = steps.find((s) => s.n === n);
      if (step) step.frame = frame;
    },
  };
}
