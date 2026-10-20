// A bot's hands on its owner's screen. The model sends a batch of structured
// steps; nothing here runs anything a model wrote. The desktop's steps become
// xdotool argv (an argument list, never a shell line), the browser's become
// Playwright calls in browser-host.mjs, and the batch answers with one fresh
// screenshot.

export const STEP_TYPES = [
  "screenshot", "click", "move", "hover", "drag", "type", "key", "scroll", "wait", "copy", "paste", "clipboard",
  "navigate", "back", "forward", "reload", "tab", "new_tab", "close_tab", "fill", "select", "check", "read", "wait_for", "upload", "dialog",
];
export const BROWSER_ONLY = new Set(["navigate", "back", "forward", "reload", "tab", "new_tab", "close_tab", "fill", "select", "check", "read", "wait_for", "upload", "dialog"]);
export const LOOK_STEPS = new Set(["screenshot", "wait", "read", "wait_for", "clipboard"]);
// Steps that can name an element by its ref from the last answer's element list instead of a point.
const REF_STEPS = new Set(["click", "move", "hover", "drag", "type", "scroll", "fill", "select", "check", "read", "copy", "upload"]);
const NEEDS_REF = new Set(["fill", "select", "check", "upload"]);
export const TARGETS = ["desktop", "browser"];

export const MAX_STEPS = 20;
export const MAX_TEXT_CHARS = 2000;
export const MAX_KEY_CHARS = 200;
export const MAX_URL_CHARS = 4000;
export const MAX_WAIT_MS = 10_000;
export const MAX_SCROLL = 20;
export const DEFAULT_SCROLL = 3;
export const MAX_TABS = 50;
export const MAX_WAIT_FOR_MS = 30_000;
export const DEFAULT_WAIT_FOR_MS = 10_000;
export const MAX_OPTIONS = 20;
const REF = /^[a-z0-9]{1,24}$/i;
export const MAX_LABEL_CHARS = 200;
const ROLE = /^[a-z]{2,24}$/;

export const SETTLE_MS = 400;

export const THUMB_EDGE = 1024;

export const CONTROL_HOLDERS = ["free", "bots", "person"];
export const PERSON_HAS_CONTROL = "The person has taken control of the computer; wait for them to give it back or ask them.";

export class ComputerActionError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const BUTTONS = new Set(["left", "right", "middle"]);
const XDO_BUTTONS = { left: 1, middle: 2, right: 3 };
const XDO_SCROLL = { up: 4, down: 5, left: 6, right: 7 };

const KEY_NAMES = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  escape: "Escape",
  esc: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  insert: "Insert",
  pageup: "Page_Up",
  page_up: "Page_Up",
  pagedown: "Page_Down",
  page_down: "Page_Down",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  super: "super",
  win: "super",
  windows: "super",
  meta: "super",
  plus: "plus",
  minus: "minus",
  caps_lock: "Caps_Lock",
  capslock: "Caps_Lock",
  printscreen: "Print",
  print_screen: "Print",
};

// xdotool's names to the browser's (KeyboardEvent.key), so one chord works on both.
const BROWSER_KEYS = {
  Return: "Enter",
  space: "Space",
  BackSpace: "Backspace",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Page_Up: "PageUp",
  Page_Down: "PageDown",
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
  super: "Meta",
  plus: "+",
  minus: "-",
  Caps_Lock: "CapsLock",
  Print: "PrintScreen",
};

const KEY_PART = /^[A-Za-z0-9_]+$/;

function chordParts(text) {
  return text
    .trim()
    .split("+")
    .map((part) => {
      const name = part.trim();
      if (!name) throw new ComputerActionError(`Bad key chord ${JSON.stringify(text)}`);
      const known = KEY_NAMES[name.toLowerCase()];
      if (known) return known;
      if (/^f\d{1,2}$/i.test(name)) return name.toUpperCase();
      if (name.length === 1 && name !== "-" && !/\s/.test(name)) return name;
      if (!KEY_PART.test(name)) throw new ComputerActionError(`Bad key ${JSON.stringify(name)}`);
      return name;
    });
}

/** One chord ("ctrl+l", "Enter") in xdotool's names. */
export function xdoKey(text) {
  if (typeof text !== "string" || !text.trim()) throw new ComputerActionError("key needs the key to press");
  return chordParts(text).join("+");
}

/** One chord in Playwright's names: "ctrl+l" is "Control+l". */
export function browserKey(text) {
  if (typeof text !== "string" || !text.trim()) throw new ComputerActionError("key needs the key to press");
  return chordParts(text)
    .map((part) => BROWSER_KEYS[part] ?? part)
    .join("+");
}

function point(step, xName, yName, area) {
  const x = Number(step[xName]);
  const y = Number(step[yName]);
  if (step[xName] === undefined || step[yName] === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ComputerActionError(`${step.type} needs ${xName} and ${yName}: pixels of the last screenshot`);
  }
  return [Math.min(Math.max(Math.round(x), 0), area.width - 1), Math.min(Math.max(Math.round(y), 0), area.height - 1)];
}

function optionalPoint(step, area) {
  if (step.x === undefined && step.y === undefined) return null;
  return point(step, "x", "y", area);
}

/** A navigate step's address: http or https only, and a bare host gets https://. */
export function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new ComputerActionError("navigate needs url");
  const text = value.trim();
  if (text.length > MAX_URL_CHARS) throw new ComputerActionError("That address is too long");
  if (text === "about:blank") return text;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ComputerActionError(`Not an address: ${JSON.stringify(text)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ComputerActionError("navigate opens http and https addresses only");
  return url.href;
}

/**
 * Checks and normalizes one batch. `area` is what coordinates are in: the
 * screen for the desktop, the page's viewport for the browser. A `type` step
 * may carry `secret: true` from the API (a sign-in detail it filled in); the
 * box never repeats its text.
 */
export function parseSteps(body, target, area) {
  if (!TARGETS.includes(target)) throw new ComputerActionError("target must be desktop or browser");
  if (!area || !(area.width > 0) || !(area.height > 0)) throw new ComputerActionError("No screen to act on");
  if (!Array.isArray(body) || body.length === 0) throw new ComputerActionError("steps must be a list of at least one step");
  if (body.length > MAX_STEPS) throw new ComputerActionError(`At most ${MAX_STEPS} steps at a time`);
  return body.map((raw, index) => {
    try {
      return parseStep(raw, target, area);
    } catch (error) {
      if (error instanceof ComputerActionError) throw new ComputerActionError(`Step ${index + 1}: ${error.message}`);
      throw error;
    }
  });
}

function refOf(step, name = "ref") {
  const value = step[name];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !REF.test(value)) throw new ComputerActionError(`${name} must be an element's ref from the last answer, like e12`);
  return value;
}

/**
 * An element named by what a person sees: its text or accessible name, and
 * optionally its role. Unlike a ref it needs no earlier look, so a batch can
 * act on a page it opened itself.
 */
function labelOf(step) {
  if (step.label === undefined || step.label === null || step.label === "") {
    if (step.role !== undefined && step.role !== null) throw new ComputerActionError("role goes with label: the element's text or name");
    return null;
  }
  if (typeof step.label !== "string" || !step.label.trim() || step.label.length > MAX_LABEL_CHARS) throw new ComputerActionError(`label must be the element's visible text or name, up to ${MAX_LABEL_CHARS} characters`);
  if (step.role !== undefined && step.role !== null && (typeof step.role !== "string" || !ROLE.test(step.role))) throw new ComputerActionError("role must be an ARIA role like button, link, textbox or checkbox");
  return { label: step.label.trim(), role: step.role ?? null, exact: step.exact === true };
}

function textOf(step, name = "text", { optional = false } = {}) {
  const value = step[name];
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || (!optional && !value)) throw new ComputerActionError(`${step.type} needs ${name}`);
  if (value.length > MAX_TEXT_CHARS) throw new ComputerActionError(`${name} is longer than ${MAX_TEXT_CHARS} characters; send it in parts`);
  return value;
}

function parseStep(step, target, area) {
  if (!step || typeof step !== "object") throw new ComputerActionError("each step must be an object");
  const { type } = step;
  if (!STEP_TYPES.includes(type)) throw new ComputerActionError(`Unknown step ${JSON.stringify(type)}`);
  if (BROWSER_ONLY.has(type) && target !== "browser") throw new ComputerActionError(`${type} is for the browser tool`);
  const ref = REF_STEPS.has(type) ? refOf(step) : null;
  const named = REF_STEPS.has(type) && type !== "drag" ? labelOf(step) : null;
  if ((ref || named) && target !== "browser") throw new ComputerActionError("refs and labels name elements of a web page; on the desktop use x and y");
  if (ref && named) throw new ComputerActionError("name the element by ref or by label, not both");
  if (NEEDS_REF.has(type) && !ref && !named) throw new ComputerActionError(`${type} needs ref (from the last answer) or label (the element's text or name)`);
  const where = ref ? { ref } : named ? { find: named } : {};
  const pointed = Boolean(ref || named);
  switch (type) {
    case "screenshot":
    case "back":
    case "forward":
    case "reload":
    case "clipboard":
      return { type };
    case "click": {
      const button = step.button ?? "left";
      if (!BUTTONS.has(button)) throw new ComputerActionError("button must be left, right or middle");
      const count = step.count === undefined ? 1 : Number(step.count);
      if (![1, 2, 3].includes(count)) throw new ComputerActionError("count must be 1, 2 or 3");
      return { type, ...where, at: pointed ? null : optionalPoint(step, area), button, count };
    }
    case "move":
    case "hover":
      return { type: "move", ...where, at: pointed ? null : point(step, "x", "y", area) };
    case "drag": {
      const toRef = refOf(step, "to_ref");
      if (ref || toRef) {
        if (!ref || !toRef) throw new ComputerActionError("drag by element needs ref and to_ref");
        return { type, ref, toRef };
      }
      return { type, from: point(step, "x", "y", area), to: point(step, "to_x", "to_y", area) };
    }
    case "type":
      return { type, ...where, text: textOf(step), secret: step.secret === true };
    case "fill":
      return { type, ...where, text: textOf(step, "text", { optional: true }) ?? "", secret: step.secret === true };
    case "select": {
      const given = Array.isArray(step.option) ? step.option : [step.option];
      if (given.length === 0 || given.length > MAX_OPTIONS || !given.every((option) => typeof option === "string" && option.length > 0 && option.length <= 500)) {
        throw new ComputerActionError("select needs option: the option's label or value, or a list of them");
      }
      return { type, ...where, options: given };
    }
    case "check":
      return { type, ...where, checked: step.checked !== false };
    case "read":
      return { type, ...where };
    case "copy":
      return { type, ...where };
    case "paste":
      return { type, text: textOf(step, "text", { optional: true }) };
    case "wait_for": {
      const text = textOf(step, "text", { optional: true });
      const url = textOf(step, "url", { optional: true });
      if (!text && !url) throw new ComputerActionError("wait_for needs text (to appear, or to go with gone: true) or url (part of the address)");
      const given = step.ms === undefined || step.ms === null ? DEFAULT_WAIT_FOR_MS : Number(step.ms);
      if (!Number.isFinite(given)) throw new ComputerActionError("ms must be a number");
      return { type, text, url, gone: step.gone === true, ms: Math.min(Math.max(Math.round(given), 100), MAX_WAIT_FOR_MS) };
    }
    case "upload": {
      if (typeof step.path !== "string" || !step.path.trim() || step.path.length > 1000) throw new ComputerActionError("upload needs path: a file in your home");
      return { type, ...where, path: step.path.trim() };
    }
    case "dialog":
      return { type, accept: step.accept !== false, text: textOf(step, "text", { optional: true }) };
    case "new_tab":
      return { type, url: step.url === undefined || step.url === null || step.url === "" ? null : normalizeUrl(step.url) };
    case "close_tab": {
      if (step.index === undefined || step.index === null) return { type, index: null };
      const index = Number(step.index);
      if (!Number.isInteger(index) || index < 0 || index >= MAX_TABS) throw new ComputerActionError("close_tab's index is a tab's number from the last answer");
      return { type, index };
    }
    case "key": {
      if (typeof step.key !== "string" || !step.key.trim()) throw new ComputerActionError("key needs key, like Enter or ctrl+l");
      if (step.key.length > MAX_KEY_CHARS) throw new ComputerActionError("That isn't a key");
      const chords = step.key.trim().split(/\s+/);
      return { type, keys: chords.map(target === "browser" ? browserKey : xdoKey) };
    }
    case "scroll": {
      // A ref with no direction brings that element into view.
      if (pointed && step.direction === undefined) return { type, ...where, direction: null, amount: 0 };
      if (!Object.hasOwn(XDO_SCROLL, step.direction)) throw new ComputerActionError("direction must be up, down, left or right");
      const given = step.amount === undefined || step.amount === null ? DEFAULT_SCROLL : Number(step.amount);
      if (!Number.isFinite(given)) throw new ComputerActionError("amount must be a number");
      return { type, ...where, at: pointed ? null : optionalPoint(step, area), direction: step.direction, amount: Math.min(Math.max(Math.round(given), 1), MAX_SCROLL) };
    }
    case "wait": {
      const given = step.ms === undefined || step.ms === null ? 1000 : Number(step.ms);
      if (!Number.isFinite(given)) throw new ComputerActionError("ms must be a number");
      return { type, ms: Math.min(Math.max(Math.round(given), 0), MAX_WAIT_MS) };
    }
    case "navigate":
      return { type, url: normalizeUrl(step.url) };
    case "tab": {
      const index = Number(step.index);
      if (!Number.isInteger(index) || index < 0 || index >= MAX_TABS) throw new ComputerActionError("tab needs index: a tab's number from the last answer");
      return { type, index };
    }
    default:
      throw new ComputerActionError(`Unknown step ${JSON.stringify(type)}`);
  }
}

export function usesInput(steps) {
  return steps.some((step) => !LOOK_STEPS.has(step.type));
}

/** What a step did, for the answer's list. A secret's text never appears. */
export function describeStep(step) {
  const on = step.ref ? ` ${step.ref}` : step.find ? ` ${JSON.stringify(step.find.label)}` : "";
  switch (step.type) {
    case "click":
      return `${step.count === 2 ? "double-" : step.count === 3 ? "triple-" : ""}${step.button === "left" ? "" : `${step.button} `}clicked${on}${step.at ? ` at ${step.at[0]},${step.at[1]}` : ""}`;
    case "move":
      return on ? `hovered${on}` : `moved to ${step.at[0]},${step.at[1]}`;
    case "drag":
      return step.ref ? `dragged ${step.ref} to ${step.toRef}` : `dragged ${step.from[0]},${step.from[1]} to ${step.to[0]},${step.to[1]}`;
    case "type":
      return step.secret ? `typed a sign-in detail${on && ` into${on}`}` : `typed ${step.text.length} characters${on && ` into${on}`}`;
    case "fill":
      return step.secret ? `filled${on} with a sign-in detail` : `filled${on} with ${step.text.length} characters`;
    case "select":
      return `picked ${step.options.map((option) => JSON.stringify(option)).join(", ")} in${on}`;
    case "check":
      return `${step.checked ? "checked" : "unchecked"}${on}`;
    case "read":
      return `read${on || " the page"}`;
    case "copy":
      return `copied${on}`;
    case "paste":
      return step.text === null ? "pasted" : `pasted ${step.text.length} characters`;
    case "clipboard":
      return "read the clipboard";
    case "wait_for":
      return step.url ? `waited for the address to have ${step.url}` : `waited for ${JSON.stringify(step.text)} to ${step.gone ? "go" : "appear"}`;
    case "upload":
      return `uploaded ${step.path}${on && ` to${on}`}`;
    case "dialog":
      return step.accept ? "accepted the dialog" : "dismissed the dialog";
    case "new_tab":
      return step.url ? `opened ${step.url} in a new tab` : "opened a new tab";
    case "close_tab":
      return step.index === null ? "closed the tab" : `closed tab ${step.index}`;
    case "key":
      return `pressed ${step.keys.join(" ")}`;
    case "scroll":
      return step.direction ? `scrolled ${step.direction} ${step.amount}${on && ` over${on}`}` : `scrolled${on} into view`;
    case "wait":
      return `waited ${step.ms} ms`;
    case "navigate":
      return `opened ${step.url}`;
    case "tab":
      return `switched to tab ${step.index}`;
    default:
      return step.type;
  }
}

/** The desktop's argv for a step, or null for one that runs nothing (a look, a wait). */
export function xdotoolArgv(step) {
  const move = step.at ? ["mousemove", String(step.at[0]), String(step.at[1])] : [];
  switch (step.type) {
    case "click":
      return step.count > 1
        ? ["xdotool", ...move, "click", "--repeat", String(step.count), "--delay", "80", String(XDO_BUTTONS[step.button])]
        : ["xdotool", ...move, "click", String(XDO_BUTTONS[step.button])];
    case "move":
      return ["xdotool", ...move];
    case "drag":
      return ["xdotool", "mousemove", String(step.from[0]), String(step.from[1]), "mousedown", "1", "mousemove", "--sync", String(step.to[0]), String(step.to[1]), "mouseup", "1"];
    case "type":
      return ["xdotool", "type", "--delay", "12", "--clearmodifiers", "--file", "-"];
    case "key":
      return ["xdotool", "key", "--clearmodifiers", ...step.keys];
    case "scroll":
      return ["xdotool", ...move, "click", "--repeat", String(step.amount), "--delay", "30", String(XDO_SCROLL[step.direction])];
    default:
      return null;
  }
}

/** What goes to xdotool's stdin: the text to type, so it is never an argument anyone can see in ps. */
export function xdotoolStdin(step) {
  return step.type === "type" ? step.text : undefined;
}

export const STEP_TIMEOUT_MS = 15_000;
export const TYPE_MS_PER_CHAR = 15;
export const NAVIGATE_TIMEOUT_MS = 30_000;

export function stepTimeoutMs(step) {
  if (step.type === "type") return STEP_TIMEOUT_MS + step.text.length * TYPE_MS_PER_CHAR;
  if (step.type === "wait" || step.type === "wait_for") return step.ms + STEP_TIMEOUT_MS;
  if (step.type === "new_tab" && step.url) return NAVIGATE_TIMEOUT_MS;
  if (step.type === "navigate" || step.type === "reload" || step.type === "back" || step.type === "forward") return NAVIGATE_TIMEOUT_MS;
  return STEP_TIMEOUT_MS;
}

export function batchTimeoutMs(steps) {
  return steps.reduce((total, step) => total + stepTimeoutMs(step), 0) + STEP_TIMEOUT_MS;
}

/** How long the screen gets to settle after a batch before it is looked at. */
export function settleMs(steps) {
  return usesInput(steps) ? SETTLE_MS : 0;
}

export function thumbSize(screen, max = THUMB_EDGE) {
  const width = Math.max(1, Math.round(Number(screen.width) || 1));
  const height = Math.max(1, Math.round(Number(screen.height) || 1));
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function controlTransition(current, request) {
  if (!request || (request.holder !== "person" && request.holder !== "free")) throw new ComputerActionError("holder must be person or free");
  if (request.from !== undefined && request.from !== null && request.from !== "bots") throw new ComputerActionError("from can only be bots");
  if (request.from === "bots" && current !== "bots") return null;
  return request.holder;
}

export function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
