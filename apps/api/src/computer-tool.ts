import { BROWSER_ONLY_STEPS, fromNativeAction, isCardField, LOOK_STEPS, MAX_SCREEN_STEPS, SCREEN_STEP_TYPES, type Bot, type DesktopDriver, type Message, type ScreenStepType, type ScreenTarget, type Thread } from "@gond/shared";
import { askApproval, expiredText, requestApproval, setAsideText, type Decision } from "./approvals.ts";
import { BoxError, desktopControl, personHasControl, readBoxFileBytes, screenBatch, type BoxConfig, type ScreenResult, type ScreenStep, type ScreenView } from "./box.ts";
import { getBot } from "./data/bots.ts";
import { storeAttachment, postMessage } from "./data/threads.ts";
import { cardNumberForms, hideSecrets, readLogin, readSecret } from "./data/secrets.ts";
import { emitDesktop, markDriving, tookControl, untilHandedBack, waitForScreen } from "./desktop.ts";
import type { DriverTool, ToolPart } from "./driver.ts";
import { heldIn, heldLogin, holdLogin } from "./logins.ts";
import { createRedactor } from "./redact.ts";
import { botHome } from "./memory.ts";
import { sendPush } from "./push.ts";

export const DISPLAY = { width: 1024, height: 640 };
export const MAX_ACTIONS = 300;

export const DENIED_TEXT = "The person denied the computer for this turn; say what you would have done.";
export const EXPIRED_TEXT = () => expiredText("to use the screen");
export const TOO_MANY_TEXT = "Too many actions in one reply; finish, or tell the person where you got to.";
// How long a batch waits for another reply to finish with the desktop before the bot is told to end its turn.
export const SCREEN_WAIT_MS = 90_000;

class ScreenBusy extends Error {
  constructor(readonly holder: DesktopDriver) {
    super("The desktop is in use");
  }
}

export function screenBusyText(holder: DesktopDriver, bot: Pick<Bot, "id">): string {
  const who = holder.botId === bot.id ? "You are using your screen in another conversation" : `${getBot(holder.botId)?.name ?? "Another bot"} is using your screen`;
  return `${who}, so nothing in this batch ran: its mouse and keyboard go to one reply at a time, and your browser is on that screen too. End your turn: say in a line what you were about to do and that you'll carry on once your screen is free. You'll be told when it is.`;
}

export const SCREENS_FULL_TEXT =
  "Nothing in this batch ran: the person's other bots are using every screen the computer keeps running for them at once. End your turn: say in a line what you were about to do and that you'll carry on in a few minutes, when one frees up.";

class ScreensFull extends Error {}

const screensFull = (error: unknown) => error instanceof BoxError && error.status === 429 && error.code === "screens_full";
// How long a batch waits for the person to give the screen back before the bot is told to end its turn.
export const HANDBACK_WAIT_MS = 10 * 60 * 1000;
export const PERSON_HAS_CONTROL_TEXT = `The person has taken control of the mouse and keyboard and kept it for ${HANDBACK_WAIT_MS / 60_000} minutes, so your input was not sent. End your turn: say in a line what you were doing and that you'll carry on when they give the screen back. You'll be told when they do; never fight for the mouse.`;
export const HANDED_BACK_TEXT =
  "Nothing in this batch ran: the person took control of the screen while you were working and has now given it back. They may have changed things (moved on a step, closed or opened something, filled something in), so this is the screen as they left it. Carry on from here, not from where you were, and don't redo what they did.";

const STEP_HELP =
  "Each action is a JSON object with a type: screenshot; click {x, y, button?: left|right|middle, count?: 1-3, hold?: ms} — hold keeps the button down that many ms before letting go (a press-and-hold check), and a click with no x/y clicks where the pointer already is; click {points: [[x,y], …], delay?: ms} clicks several places in order in one action (select every matching tile, then Verify); hold {x, y, ms} presses and keeps the button down without letting go (the clearest way to pass a press-and-hold check: 1500-4000 ms); mouse_down {x?, y?} and mouse_up {x?, y?} press or release and leave it that way, for holding across two batches; hover {x, y}; drag {x, y, to_x, to_y, hold?} presses, moves there the way a hand does and waits over the spot before letting go (hold: how long, in ms, default 80, up to 15000; hold near a list's edge and it scrolls, so a far move is a drag to the edge with a long hold, a look, then a second drag); type {text}; type_login {name, submit?} types a sign-in detail from request_login, or any stored secret by name (a server's root password; the person is asked first), without you seeing it; key {key: Enter, Tab, ctrl+l, ctrl+shift+t, several separated by spaces}; scroll {direction: up|down|left|right, amount?: 1-20, x?, y?}; wait {ms}; copy (the selection; its text comes back); paste {text?} (puts text on the clipboard and pastes it, far faster than typing a long text); clipboard (its text comes back).";

const CHALLENGE_HELP =
  "Anti-bot checks you can do yourself: press-and-hold (hold {x, y, ms: 3000}, or click with hold, and do not let go early); pick every picture with something such as a train (click each tile by x,y, or one click {points: [...]}, then Verify); pick the one icon that matches (zoom into the grid, then click it, then Verify); click icons in the order shown (one click {points: [...]}); a plain not-a-robot checkbox (click it and wait). A simple slider whose gap you can see: drag from the handle to the gap, then check it. For anything else — audio, a 3D rotation, an unfamiliar puzzle, a slider you can't place, or two failed attempts — call hand_over and end your turn: do not keep guessing. The person takes the mouse and keyboard, and you are woken when they hand it back. After a successful action wait_for the success text or look again; if it says try again, take a fresh screenshot and use the new picture.";

const BROWSER_HELP =
  "Every answer lists the page's controls and headings on screen, one per line: `e12 button \"Add to cart\" @640,410`. Name one by its ref instead of x and y and it is found exactly, even if the page moved (a page that shifts after one click sends the next x and y somewhere else, so use x and y only for what the list doesn't name): click {ref}; hover {ref}; zoom {x, y, width, height} on the call (with view both or image) answers with just that part of the page, larger, for a small picture grid or a challenge's words; type {ref, text}; drag {ref, to_ref}; scroll {ref} brings it into view, or with direction scrolls inside it. On a page you haven't seen yet (one this batch opens), name an element by label instead: its visible text or name, with role (button, link, textbox, checkbox, …) when the text alone is ambiguous; the step waits up to 8 seconds for it to appear. So one batch can carry an errand across pages: navigate to the store, click {label: \"#1 Whataburger\"}, select {label: \"Drink\", option: \"Dr Pepper\"}, click {label: \"Add to order\", role: \"button\"}, wait_for {text: \"Total\"}, read {label: \"Total\"}. If a label isn't found the batch stops there and says so. Browser-only actions (each takes ref or label): fill {ref, text} replaces a field's text at once (use it rather than type for forms); select {ref, option} picks a dropdown option by its label or value; check {ref, checked?: false to untick} sets a checkbox, radio or switch and leaves it that way whatever it was, so use it rather than click for a form's options (a site that draws its own boxes is listed by the row you would click); type_login {ref, name} fills a sign-in detail, or a card's after use_card (CARD_NUMBER, CARD_EXPIRY, CARD_CVC…; add select: true for a dropdown); read {ref?} gives the text of the page or of one element, without a picture (prices, totals, a list); wait_for {text, gone?} or {url} waits until text appears or goes, or the address changes, instead of a guessed wait; upload {ref, path} sends a file from your home to a file field; dialog {accept, text?} answers an alert, confirm or prompt; navigate {url}; back; forward; reload; tab {index}; new_tab {url?}; close_tab {index?}. Refs only hold until the next answer, which brings a new list. Downloads go to ~/Downloads.";

export const COMPUTER_DESCRIPTION = `Your whole desktop on the computer, for apps that aren't a web page (a file manager, a terminal window, a desktop program): send the actions to run, in order, and get back one fresh screenshot. Coordinates are pixels of the last screenshot. ${STEP_HELP} Batch what you're sure of (click a field, type, press Enter) and look before anything that depends on what appears. For a website use the browser tool instead. ${CHALLENGE_HELP} The person can take control of the mouse and keyboard; your actions are refused until they give it back.`;

export const BROWSER_DESCRIPTION = `Your browser on the computer: one Chrome window on the desktop the person watches, kept open between calls and replies, with its tabs and sign-ins. Send the actions to run, in order; the answer has the page's address, title and tabs, the list of what is on screen, what any read or copy returned, and a screenshot. ${BROWSER_HELP} ${STEP_HELP} ${CHALLENGE_HELP} Every answer costs a model turn, so do as much as you can per batch: plan several actions from one answer, and carry on into pages you expect by label. Open a search or a store by its address when you know it (a site's search URL with the query in it) rather than typing into its search box. Set view to "text" when you only need the list or a read, which is faster than a picture. The person can take control of the mouse and keyboard; your actions are refused until they give it back.`;

const SEND_SCREENSHOT_DESCRIPTION =
  "Show the person the screen: takes a fresh screenshot of your browser's page (or the whole desktop) and posts it in this conversation as a picture, with your caption. This is how you send a screenshot; never save one to a file. Use it when they ask to see the screen, and to end a task on something they should check with their own eyes: a cart before anything is bought, an order or booking confirmation, a finished form. Not for the steps on the way.";

const HAND_OVER_DESCRIPTION =
  "Send the person a Take Control card and stop. Use it instead of guessing at a check you are not sure of — audio, a 3D rotation, an unfamiliar puzzle, a slider you can't place — or after two failed attempts. It gives them the mouse and keyboard and posts one card whose button opens the computer so they can see the challenge and finish it. The card is the message: don't explain the check in chat. Do not call it for a press-and-hold, a click-every-train grid, a matching icon, a click-in-order grid or a plain checkbox: those you do yourself. After they give the screen back you are woken to look and carry on; never keep clicking while they hold it.";

const SHARE_HELP =
  "Optional: post this batch's last screenshot in the conversation for the person, with this line as its caption, so they can check it with their own eyes. Only on the screen your answer is about: a cart before anything is bought, an order or booking confirmation, a finished form. Never on the steps on the way; nothing is saved on the computer.";

const coordinate = (what: string) => ({ type: "integer", minimum: 0, description: `${what}, in pixels of the last screenshot.` });

function stepSchema(target: ScreenTarget) {
  const types = SCREEN_STEP_TYPES.filter((type) => target === "browser" || !BROWSER_ONLY_STEPS.includes(type));
  return {
    type: "object",
    properties: {
      type: { type: "string", enum: types },
      ...(target === "browser"
        ? {
            ref: { type: "string", description: "An element's ref from the last answer's list, like e12: instead of x and y." },
            to_ref: { type: "string", description: "drag: the ref to drop on." },
            label: { type: "string", description: "Instead of ref, for a page not seen yet: the element's visible text or name. Waits up to 8 s for it." },
            role: { type: "string", description: "With label: its role, like button, link, textbox, checkbox, combobox, tab." },
            exact: { type: "boolean", description: "With label: match the whole text exactly." },
          }
        : {}),
      x: coordinate("Where to click, hover or scroll at, or where a drag starts"),
      y: coordinate("Where to click, hover or scroll at, or where a drag starts"),
      to_x: coordinate("Where a drag ends"),
      to_y: coordinate("Where a drag ends"),
      hold: { type: "integer", minimum: 0, maximum: 15_000, description: "click: ms to keep the button down (a press-and-hold check). drag: ms to wait over the drop spot before letting go (default 80). Longer near a list's edge lets it scroll." },
      points: { type: "array", minItems: 1, maxItems: 20, items: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 2, maxItems: 2 }, description: "click: several [x, y] places to click in order (every matching tile), instead of x and y." },
      delay: { type: "integer", minimum: 0, maximum: 2000, description: "click with points: ms between those clicks (default 120)." },
      button: { type: "string", enum: ["left", "right", "middle"] },
      count: { type: "integer", minimum: 1, maximum: 3, description: "2 for a double click, 3 for a triple click." },
      text: { type: "string", description: "type, fill, paste: the text. wait_for: the text to wait for. dialog: a prompt's answer." },
      key: { type: "string", description: "Keys to press: Enter, Escape, ctrl+a, alt+Tab; several separated by spaces." },
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", minimum: 1, maximum: 20, description: "How far to scroll, in wheel clicks." },
      ms: { type: "integer", minimum: 0, maximum: 30_000, description: "wait: how long. hold: how long to keep the button down (default 2000, up to 15000). wait_for: the most to wait (default 10000)." },
      name: { type: "string", description: "type_login: the detail's name from request_login, like UBER_EATS_PASSWORD, or a stored secret's, like ROOT_PASSWORD." },
      submit: { type: "boolean", description: "type_login: press Enter after it." },
      select: { type: "boolean", description: "type_login: pick the held value in a dropdown (a card's CARD_MONTH or CARD_YEAR) instead of typing it." },
      ...(target === "browser"
        ? {
            url: { type: "string", description: "navigate, new_tab: the address to open. wait_for: part of the address to wait for." },
            index: { type: "integer", minimum: 0, description: "tab, close_tab: the tab's number from the last answer." },
            option: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "select: the option's label or value, or several for a multi-select." },
            checked: { type: "boolean", description: "check: false to untick." },
            gone: { type: "boolean", description: "wait_for: wait for the text to go instead." },
            path: { type: "string", description: "upload: the file, in your home." },
            accept: { type: "boolean", description: "dialog: true to accept (OK), false to dismiss (Cancel)." },
          }
        : {}),
    },
    required: ["type"],
    additionalProperties: false,
  };
}

function batchSchema(target: ScreenTarget) {
  return {
    type: "object",
    properties: {
      actions: { type: "array", items: stepSchema(target), minItems: 1, maxItems: MAX_SCREEN_STEPS, description: `Up to ${MAX_SCREEN_STEPS} actions, run in order; the page comes back after the last one.` },
      ...(target === "browser"
        ? {
            view: { type: "string", enum: ["both", "text", "image"], description: "What comes back: both (default), text (the list and any reads, no picture: fastest) or image." },
            zoom: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: 0 },
                y: { type: "integer", minimum: 0 },
                width: { type: "integer", minimum: 32 },
                height: { type: "integer", minimum: 32 },
              },
              required: ["x", "y", "width", "height"],
              additionalProperties: false,
              description: "Answer with just this part of the page, larger, instead of the whole screen: a CAPTCHA's picture grid or a small line of text.",
            },
          }
        : {}),
      share: { type: "string", description: SHARE_HELP },
    },
    required: ["actions"],
    additionalProperties: false,
  };
}

export const COMPUTER_SCHEMA = batchSchema("desktop");
export const BROWSER_SCHEMA = batchSchema("browser");

export const COMPUTER_NATIVE = { type: "computer_20250124", name: "computer", display_width_px: DISPLAY.width, display_height_px: DISPLAY.height };

export type Scale = { x: number; y: number };

export function scaleOf(result: Pick<ScreenResult, "screen" | "width" | "height">): Scale | null {
  if (!result.width || !result.height || !result.screen?.width || !result.screen?.height) return null;
  return { x: result.screen.width / result.width, y: result.screen.height / result.height };
}

const POINTS = [
  ["x", "y"],
  ["to_x", "to_y"],
] as const;

/**
 * The model's actions as the box takes them: checked, coordinates turned into
 * real pixels, and a type_login turned into the value it names, which only the
 * box ever sees. Anthropic's own computer tool sends one action in its form;
 * it becomes a batch of one.
 */
export function screenSteps(input: Record<string, unknown>, target: ScreenTarget, scale: Scale | null, login: (name: string) => string | null): { steps: ScreenStep[] } | { error: string } {
  if (typeof input.action === "string") {
    if (input.action === "cursor_position") return { error: "There is no cursor_position; take a screenshot to see the pointer." };
    input = { actions: [fromNativeAction(input)] };
  }
  const given = input.actions;
  if (!Array.isArray(given) || given.length === 0) return { error: `Send actions: a list of 1 to ${MAX_SCREEN_STEPS} steps, like [{"type": "screenshot"}].` };
  const steps: ScreenStep[] = [];
  for (const [index, raw] of given.entries()) {
    const where = `Action ${index + 1}`;
    if (!raw || typeof raw !== "object") return { error: `${where} isn't an object.` };
    const step = { ...(raw as Record<string, unknown>) };
    const type = step.type as ScreenStepType;
    if (!SCREEN_STEP_TYPES.includes(type)) return { error: `${where}: no such type ${JSON.stringify(step.type ?? null)}. Use one of ${SCREEN_STEP_TYPES.join(", ")}.` };
    if (target === "desktop" && BROWSER_ONLY_STEPS.includes(type)) return { error: `${where}: ${type} is a browser action; use the browser tool for websites.` };
    if (type === "type_login") {
      const name = String(step.name ?? "").trim().toUpperCase();
      const value = name ? login(name) : null;
      if (!value) return { error: `NOT typed: there is no ${name || "sign-in detail"} for this conversation or among the stored secrets. Call request_login, or request_secret for a password that isn't a website's. Nothing in this batch ran.` };
      const ref = target === "browser" && typeof step.ref === "string" && step.ref ? step.ref : null;
      const label = target === "browser" && !ref && typeof step.label === "string" && step.label ? step.label : null;
      if (step.select === true) {
        if (!ref && !label) return { error: `${where}: a type_login with select picks from a dropdown on a web page; name it by ref or label in the browser tool.` };
        steps.push({ type: "select", ...(ref ? { ref } : { label: label!, ...(typeof step.role === "string" ? { role: step.role } : {}) }), option: selectOptions(name, value), secret: true });
        continue;
      }
      if (ref) steps.push({ type: "fill", ref, text: value, secret: true });
      else if (label) steps.push({ type: "fill", label, ...(typeof step.role === "string" ? { role: step.role } : {}), text: value, secret: true });
      else steps.push({ type: "type", text: value, secret: true });
      if (step.submit === true) steps.push({ type: "key", key: "Enter" });
      continue;
    }
    if (target === "desktop" && (step.ref !== undefined || step.to_ref !== undefined || step.label !== undefined)) return { error: `${where}: refs and labels name elements of a web page; on the desktop use x and y from the screenshot.` };
    if (target === "desktop") {
      for (const [xName, yName] of POINTS) {
        if (step[xName] === undefined && step[yName] === undefined) continue;
        const x = Number(step[xName]);
        const y = Number(step[yName]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return { error: `${where}: ${xName} and ${yName} must be pixels of the last screenshot.` };
        step[xName] = Math.round(scale ? x * scale.x : x);
        step[yName] = Math.round(scale ? y * scale.y : y);
      }
      if (Array.isArray(step.points)) {
        step.points = step.points.map((pair) => {
          if (!Array.isArray(pair) || pair.length < 2) return pair;
          const x = Number(pair[0]);
          const y = Number(pair[1]);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return pair;
          return [Math.round(scale ? x * scale.x : x), Math.round(scale ? y * scale.y : y)];
        });
      }
    }
    delete step.secret;
    steps.push(step as ScreenStep);
  }
  if (steps.length > MAX_SCREEN_STEPS) return { error: `At most ${MAX_SCREEN_STEPS} actions at a time, counting a type_login with submit as two.` };
  return { steps };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The ways a dropdown may write a held value: a month as 08, 8, August or Aug, a year as 2028 or 28. */
export function selectOptions(name: string, value: string): string[] {
  if (name.endsWith("_MONTH") && /^\d{2}$/.test(value)) {
    const month = MONTHS[Number(value) - 1] ?? "";
    return [value, String(Number(value)), month, month.slice(0, 3)].filter(Boolean);
  }
  if (name.endsWith("_YEAR") && /^\d{4}$/.test(value)) return [value, value.slice(2)];
  return [value];
}

export function usesInput(steps: ScreenStep[]): boolean {
  return steps.some((step) => !LOOK_STEPS.includes(step.type));
}

/** The words that go with a screenshot: what ran, what failed, what was read, and for the browser where it is and what is on screen. */
export function screenSummary(result: ScreenResult, steps: number): string {
  const lines: string[] = [];
  if (result.target === "browser") {
    if (result.zoom) lines.push(`Zoomed picture ${result.width ?? "?"}x${result.height ?? "?"} of the page at ${result.zoom.x},${result.zoom.y}: ${result.title?.trim() || "(no title)"} at ${result.url ?? "about:blank"}`);
    else lines.push(`Page ${result.width ?? "?"}x${result.height ?? "?"}: ${result.title?.trim() || "(no title)"} at ${result.url ?? "about:blank"}`);
    const tabs = result.tabs ?? [];
    if (tabs.length > 1) lines.push(`Tabs: ${tabs.map((tab) => `${tab.index}${tab.active ? " (this one)" : ""} ${tab.title.trim() || tab.url}`).join("; ")}`);
  } else {
    lines.push(`Screenshot ${result.width ?? "?"}x${result.height ?? "?"} (screen ${result.screen?.width ?? "?"}x${result.screen?.height ?? "?"})`);
  }
  if (result.error) lines.push(`Action ${result.error.index + 1} of ${steps} failed: ${result.error.message}. The actions after it didn't run.`);
  else if (steps > 1) lines.push(`All ${steps} actions ran.`);
  for (const output of result.outputs ?? []) lines.push(`Action ${output.index + 1} returned:\n${output.text}`);
  if (result.dialog) lines.push(`A ${result.dialog.type} dialog is open: "${result.dialog.message}". Answer it with dialog {accept: true or false}; nothing else runs until then.`);
  if (result.downloads?.length) lines.push(`Downloaded: ${result.downloads.join(", ")}`);
  if (result.elements) lines.push(`On screen (ref role "name" @x,y):\n${result.elements.text || "(nothing to act on)"}${result.elements.note ? `\n${result.elements.note}` : ""}`);
  return lines.join("\n");
}

type Context = {
  box: BoxConfig;
  bot: Bot;
  thread: Thread;
  message?: Pick<Message, "depth">;
  signal?: AbortSignal;
  imageResults?: boolean;
};

/**
 * The bot's two hands on its owner's screen, the same on every engine: the
 * whole desktop and the persistent browser. Both send structured steps to the
 * box's drivers; one approval and one action budget cover both for the reply.
 */
export function computerTool(context: Context): { computer: DriverTool; browser: DriverTool; send_screenshot: DriverTool; hand_over: DriverTool } {
  const { box, bot, thread } = context;
  const pictures = context.imageResults !== false;
  const screenFile = `${botHome(bot.id)}/screen.png`;
  let scale: Scale | null = null;
  let asked: Decision | null = null;
  let actions = 0;
  // The page the browser last showed, so a hand-off can say where.
  let lastUrl: string | null = null;

  const send = async (target: ScreenTarget, steps: ScreenStep[], view?: ScreenView, zoom?: { x: number; y: number; width: number; height: number }): Promise<ScreenResult> => {
    if (target === "browser" || usesInput(steps)) {
      const holder = await waitForScreen(thread.userId, { botId: bot.id, threadId: thread.id }, target, SCREEN_WAIT_MS, context.signal);
      if (holder) throw new ScreenBusy(holder);
    }
    const batch = { bot: bot.id, primary: bot.primary, name: bot.name, color: bot.color, target, steps, ...(view ? { view } : {}), ...(zoom ? { zoom } : {}), ...(pictures || view === "text" ? {} : { saveTo: screenFile }) };
    // A screen frees up when another bot's turn ends; until then the batch waits, as for its own screen.
    const deadline = Date.now() + SCREEN_WAIT_MS;
    let result: ScreenResult;
    for (;;) {
      try {
        result = await screenBatch(box, batch, context.signal);
        break;
      } catch (error) {
        if (!screensFull(error) || context.signal?.aborted || Date.now() >= deadline) throw screensFull(error) ? new ScreensFull() : error;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          context.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (context.signal?.aborted) throw new ScreensFull();
      }
    }
    if (target === "desktop") scale = scaleOf(result) ?? scale;
    if (result.url) lastUrl = result.url;
    return result;
  };

  const answer = (result: ScreenResult, steps: number, view?: ScreenView): ToolPart[] | string => {
    // What this conversation holds (a card, a sign-in) never comes back as text, whatever the page shows in its fields.
    const text = createRedactor(heldIn(thread.id).flatMap((value) => [value, ...cardNumberForms(value).slice(1)]), Infinity)(screenSummary(result, steps));
    if (result.image) return [{ type: "text", text }, { type: "image", data: result.image, mimeType: result.mime ?? "image/png" }];
    return pictures || !result.width || view === "text" ? text : `${text}\nThe screenshot is saved to ~/${screenFile}.`;
  };

  const mayUseInput = async (target: ScreenTarget): Promise<string | null> => {
    if (asked === null) {
      const summary = target === "browser" ? `Use the computer (the browser on ${bot.name}'s screen)` : `Use the computer (the mouse and keyboard on ${bot.name}'s screen)`;
      const answer = await askApproval({ bot, threadId: thread.id, tool: "computer", input: { target }, summary, signal: context.signal });
      // Set aside isn't a no for the rest of the reply: the next batch asks again.
      if (answer.aside) return setAsideText("to use the computer");
      asked = answer.decision;
    }
    if (asked === "deny") return DENIED_TEXT;
    if (asked === "expired") return EXPIRED_TEXT();
    if (markDriving(thread.userId, { botId: bot.id, threadId: thread.id })) void emitDesktop(thread.userId);
    return null;
  };

  // The box takes the screen for the bots when the first batch arrives, after markDriving's event went out.
  let control: ScreenResult["control"] | null = null;
  const sent = (result: ScreenResult): ScreenResult => {
    if (result.control !== control) {
      control = result.control;
      void emitDesktop(thread.userId);
    }
    return result;
  };

  /** Posts a batch's last screenshot in the conversation, when the bot asked for it with share. */
  const share = async (result: ScreenResult, caption: string): Promise<string> => {
    if (result.error) return "NOT shared: a step failed, so the screenshot isn't the screen you meant. Fix it and share again.";
    let data: Uint8Array;
    try {
      data = result.image ? Buffer.from(result.image, "base64") : await readBoxFileBytes(box, screenFile);
    } catch {
      return "NOT shared: the screenshot couldn't be read.";
    }
    const jpeg = (result.mime ?? "image/png") === "image/jpeg";
    const file = storeAttachment({ name: `screenshot.${jpeg ? "jpg" : "png"}`, mediaType: jpeg ? "image/jpeg" : "image/png", data });
    postMessage({ threadId: thread.id, author: bot.id, body: hideSecrets(caption.slice(0, 4000)), attachments: [file], depth: (context.message?.depth ?? 0) + 1, answered: true });
    return "Shared this screenshot in the conversation with your caption; the person sees it above your answer, so don't send it again.";
  };

  const sendScreenshot: DriverTool = {
    description: SEND_SCREENSHOT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        caption: { type: "string", description: "A line to go with it, like \"Your cart, nothing placed yet\"." },
        target: { type: "string", enum: ["browser", "desktop"], description: "browser (default): the page in your browser. desktop: the whole screen." },
      },
      required: ["caption"],
      additionalProperties: false,
    },
    execute: async (raw) => {
      const caption = typeof raw.caption === "string" ? raw.caption.trim() : "";
      if (!caption) return "NOT sent: give it a caption, a line saying what it shows.";
      const target: ScreenTarget = raw.target === "desktop" ? "desktop" : "browser";
      let result: ScreenResult;
      try {
        result = await send(target, [{ type: "screenshot" }], target === "browser" ? "image" : undefined);
      } catch (error) {
        if (error instanceof ScreenBusy) return screenBusyText(error.holder, bot);
        if (error instanceof ScreensFull) return SCREENS_FULL_TEXT;
        throw error;
      }
      if (target === "browser" && (!result.url || result.url === "about:blank")) return "NOT sent: the browser has no page open. Open the page first, or send the desktop.";
      return share(result, caption);
    },
  };

  const handOver: DriverTool = {
    description: HAND_OVER_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      try {
        // The box's own control, then the API's bookkeeping, exactly as the person's Take control button does.
        await desktopControl(box, bot.id, { holder: "person" }, context.signal);
      } catch (error) {
        return `NOT handed over: the screen couldn't be given to the person (${error instanceof Error ? error.message : "the box didn't answer"}). End your turn.`;
      }
      // The tool promised a wake-up, so this conversation hears the hand back even if it never drove the screen.
      tookControl(thread.userId, bot.id, [{ botId: bot.id, threadId: thread.id }]);
      void emitDesktop(thread.userId);
      const site = hostOf(lastUrl);
      postMessage({
        threadId: thread.id,
        author: bot.id,
        kind: "control",
        body: site ?? "",
        depth: (context.message?.depth ?? 0) + 1,
        answered: true,
      });
      if (bot.notify) void sendPush({ title: `${bot.name} needs you on its screen`, body: site ? `Something on ${site} needs a person. Open the screen to finish it.` : "Something on its screen needs a person. Open it to finish.", url: `/app/t/${thread.id}`, tag: thread.id, threadId: thread.id }, bot.userId);
      return "Posted the Take Control card and gave the person the mouse and keyboard. End your turn now: they will open the computer and finish it, and you'll be woken when they give it back. Don't keep clicking.";
    },
  };

  const afterHandBack = async (target: ScreenTarget): Promise<ToolPart[] | string> => {
    const back = await untilHandedBack(thread.userId, { botId: bot.id, threadId: thread.id }, HANDBACK_WAIT_MS, context.signal);
    if (!back) return PERSON_HAS_CONTROL_TEXT;
    let result: ScreenResult;
    try {
      result = await send(target, [{ type: "screenshot" }]);
    } catch (error) {
      if (error instanceof ScreenBusy) return screenBusyText(error.holder, bot);
      if (error instanceof ScreensFull) return SCREENS_FULL_TEXT;
      throw error;
    }
    const shown = answer(result, 0);
    return typeof shown === "string" ? `${HANDED_BACK_TEXT}\n${shown}` : [{ type: "text", text: HANDED_BACK_TEXT }, ...shown];
  };

  // A type_login of a stored secret that isn't a held sign-in (a server's root password, say) is typed only once the person allows it.
  const typeSecrets = async (raw: Record<string, unknown>): Promise<string | null> => {
    const names = (Array.isArray(raw.actions) ? raw.actions : [raw]).flatMap((step) =>
      step && typeof step === "object" && (step as Record<string, unknown>).type === "type_login" ? [String((step as Record<string, unknown>).name ?? "").trim().toUpperCase()] : [],
    );
    for (const name of new Set(names)) {
      if (isCardField(name) && heldLogin(thread.id, name) === null) return `NOT typed: no card is ready in this conversation for ${name}. Call use_card at the checkout first; the person picks the card. Nothing in this batch ran.`;
      // A website's saved sign-in goes through request_login, which asks for it by site.
      if (!name || heldLogin(thread.id, name) !== null || readLogin(bot.userId, name) !== null) continue;
      const value = readSecret(bot.userId, name);
      if (value === null) continue;
      const decision = await requestApproval({ bot, threadId: thread.id, tool: "type_secret", input: { name }, summary: `Type ${name} into the screen`, signal: context.signal });
      if (decision === "expired") return `NOT typed: nobody answered about typing ${name}. Nothing in this batch ran.`;
      if (decision !== "allow" && decision !== "always") return `NOT typed: the person said no to typing ${name}. Nothing in this batch ran.`;
      holdLogin(thread.id, name, value);
    }
    return null;
  };

  const tool = (target: ScreenTarget): DriverTool => ({
    description: target === "browser" ? BROWSER_DESCRIPTION : COMPUTER_DESCRIPTION,
    inputSchema: target === "browser" ? BROWSER_SCHEMA : COMPUTER_SCHEMA,
    ...(target === "desktop" ? { native: { anthropic: COMPUTER_NATIVE } } : {}),
    execute: async (raw) => {
      const pointed = target === "desktop" && hasCoordinates(raw);
      if (pointed && !scale) await send("desktop", [{ type: "screenshot" }]);
      const typed = await typeSecrets(raw);
      if (typed) return typed;
      const parsed = screenSteps(raw, target, scale, (name) => heldLogin(thread.id, name));
      if ("error" in parsed) return parsed.error;
      const { steps } = parsed;
      actions += steps.length;
      if (actions > MAX_ACTIONS) return TOO_MANY_TEXT;
      if (usesInput(steps)) {
        const refused = await mayUseInput(target);
        if (refused) return refused;
      }
      const caption = typeof raw.share === "string" ? raw.share.trim() : "";
      const asked = target === "browser" && (raw.view === "text" || raw.view === "image" || raw.view === "both") ? raw.view : undefined;
      const zoom = target === "browser" && raw.zoom && typeof raw.zoom === "object" ? (raw.zoom as { x: number; y: number; width: number; height: number }) : undefined;
      const view = (caption && asked === "text") || (zoom && asked === "text") ? "both" : asked;
      try {
        const result = await send(target, steps, view, zoom);
        const shown = answer(usesInput(steps) ? sent(result) : result, steps.length, view);
        if (!caption) return shown;
        const note = await share(result, caption);
        return typeof shown === "string" ? `${shown}\n${note}` : [...shown, { type: "text", text: note }];
      } catch (error) {
        if (error instanceof ScreenBusy) return screenBusyText(error.holder, bot);
        if (error instanceof ScreensFull) return SCREENS_FULL_TEXT;
        if (personHasControl(error)) return afterHandBack(target);
        if (error instanceof BoxError && error.status === 400) return `NOT done: ${error.message}. Nothing in this batch ran.`;
        throw error;
      }
    },
  });

  return { computer: tool("desktop"), browser: tool("browser"), send_screenshot: sendScreenshot, hand_over: handOver };
}

/** A web page's host, for saying where; the bots' own homepage and blank tabs have none. */
function hostOf(url: string | null): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function hasCoordinates(raw: Record<string, unknown>): boolean {
  if (Array.isArray(raw.coordinate) || Array.isArray(raw.start_coordinate)) return true;
  return Array.isArray(raw.actions) && raw.actions.some((step) => step && typeof step === "object" && ("x" in step || "to_x" in step || "points" in step));
}
