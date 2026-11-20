import { posix } from "node:path";
import { QUIET_REPLY, appAction, approvalLine, physicalAccess, editedEmailInput, emailDraftOf, emailEditable, emailMode, handleOf, isPaused, plainMarkdown, routineName, sendDraftAction, type Approval, type ApprovalAnswer, type ApprovalLevel, type Bot, type Message } from "@gond/shared";
import { boxHome } from "./box.ts";
import { approvalTimeoutMs } from "./config.ts";
import { addRule, cardWork, createApproval, getApproval, lapsePausedApprovals, listApprovals, listRules, pauseApproval, pausedApprovals, resolveApproval, resolvePaused, unpauseApprovals } from "./data/approvals.ts";
import { getBot } from "./data/bots.ts";
import { personOf } from "./data/profiles.ts";
import { botHome } from "./memory.ts";
import { hideSecrets } from "./data/secrets.ts";
import { getMessage, getThread, postMessage, takeLateYes } from "./data/threads.ts";
import { withdrawFromPhones } from "./phone-push.ts";
import { sendPush } from "./push.ts";
import { lateAnswerText } from "./resume.ts";

type Pending = { resolve: (answer: Answer) => void; timer: ReturnType<typeof setTimeout> };
export type Decision = "allow" | "deny" | "always" | "expired";

/**
 * A decision and what came with it on an email's card: the letter as the person left it, Send on a draft, a note on a no.
 * `aside` is a card the person wrote past instead of answering (`setAside`); its decision is "deny", so a caller that
 * doesn't look for it still does nothing.
 */
type Answer = { decision: Decision; input: Record<string, unknown>; edited: boolean; send: boolean; note: string | null; aside: boolean };

const holder = globalThis as typeof globalThis & { __gondPendingApprovals?: Map<string, Pending> };

function pending(): Map<string, Pending> {
  return (holder.__gondPendingApprovals ??= new Map());
}

export function ruleFor(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") {
    const first = input.command.trim().split(/\s+/)[0] ?? "";
    return first ? `Bash(${first}:*)` : "Bash";
  }
  if (FILE_TOOLS.has(tool)) {
    const file = pathOf(input);
    const folder = file ? posix.dirname(posix.normalize(file)) : null;
    if (folder && !folder.split("/").includes("..")) return `${tool}(${folder}/**)`;
  }
  return tool;
}

function pathOf(input: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) if (typeof input[key] === "string" && (input[key] as string).trim()) return (input[key] as string).trim();
  return null;
}

/**
 * What a shell can do past its first command: chain another, pipe into
 * one, substitute one, redirect into a file. A rule for `ls` is a yes to
 * `ls`, never to `ls; curl … | sh`, so a command with any of these asks.
 */
const SHELL_CHAIN = /[;&|`<>\n\r]|\$\(/;

function underFolder(file: string, folder: string): boolean {
  const clean = posix.normalize(file);
  if (clean.split("/").includes("..")) return false;
  if (folder === ".") return !clean.startsWith("/") && !clean.startsWith("~");
  return clean.startsWith(`${folder}/`);
}

export function summarize(tool: string, input: Record<string, unknown>): string {
  return approvalLine(tool, input);
}

export function ruleMatches(rule: string, tool: string, input: Record<string, unknown>): boolean {
  if (rule === tool) return true;
  const prefix = /^Bash\((.+):\*\)$/.exec(rule);
  if (prefix && tool === "Bash" && typeof input.command === "string") {
    const command = input.command.trim();
    if (SHELL_CHAIN.test(command)) return false;
    return command.split(/\s+/)[0] === prefix[1];
  }
  const folder = /^(\w+)\((.+)\/\*\*\)$/.exec(rule);
  if (folder && folder[1] === tool && FILE_TOOLS.has(tool)) {
    const file = pathOf(input);
    return file !== null && underFolder(file, folder[2]!);
  }
  return false;
}

const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoRead", "TodoWrite", "Task", "WebSearch", "NotebookRead"]);

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const PATH_KEYS = ["file_path", "notebook_path", "path"];

/**
 * A path in the bot's own folder on the computer. Three shapes:
 * - relative: a CLI session runs in that folder, so one that doesn't climb
 *   out is inside it;
 * - `~/…`: the API engine's tools name everything from the person's home,
 *   so it must be `~/.bots/<id>` or under it;
 * - absolute: its owner's home on the box then `.bots/<id>`, from the
 *   start of the path, never merely somewhere in it.
 */
export function ownPath(bot: Pick<Bot, "id" | "userId">, value: string): boolean {
  const path = value.trim();
  if (!path || path.split("/").includes("..")) return false;
  const desk = botHome(bot.id);
  const inside = (clean: string, root: string) => clean === root || clean.startsWith(`${root}/`);
  if (path.startsWith("~/")) return inside(posix.normalize(path.slice(2)), desk);
  if (path.startsWith("~")) return false;
  if (!path.startsWith("/")) return true;
  const clean = posix.normalize(path);
  const home = bot.userId ? boxHome(bot.userId) : null;
  if (home) return inside(clean, `${home}/${desk}`);

  const at = clean.indexOf(`/${desk}`);
  return at > 0 && /^\/home\/[^/]+$/.test(clean.slice(0, at)) && inside(clean.slice(at + 1), desk);
}

function inOwnHome(bot: Pick<Bot, "id" | "userId">, tool: string, input: Record<string, unknown>): boolean {
  if (!FILE_TOOLS.has(tool)) return false;
  const paths = PATH_KEYS.map((key) => input[key]).filter((value): value is string => typeof value === "string");
  return paths.length > 0 && paths.every((path) => ownPath(bot, path));
}

export const CARD_EXPIRED_LINE = "That card expired. Ask me again when you're ready.";

const enders = new WeakMap<AbortSignal, () => void>();

/** The responder says how to end a turn whose answer is the person's, so a card that times out needs no model round. */
export function endTurnOnExpiry(signal: AbortSignal, end: () => void): void {
  enders.set(signal, end);
}

/**
 * A turn whose work can start again: what it answers, the steps it has finished so far, and the card
 * whose late yes started it, if one did (the hidden prompt carries it until its one call is spent).
 */
type Resumable = { messageId: string; card: string | null; done: () => readonly string[] };
const resumable = new WeakMap<AbortSignal, Resumable>();

/**
 * The responder marks a turn whose work can start again later: a card it waits on that nobody
 * answers in time is paused instead of expired, so the person can still answer it, and the bot
 * starts again from there (`decideLate`). The turn still ends at once (`endTurnOnExpiry`).
 */
export function pauseOnExpiry(signal: AbortSignal, turn: Resumable): void {
  resumable.set(signal, turn);
}

// A sign-in or a secret needs values typed fresh, and money or a key waits for nobody: these keep the strict expiry.
const STRICT_TOOLS = new Set(["request_login", "type_secret", "forget_secret"]);
const MONEY_ACTION = /(^|_)(PAY|PAYS|PAYMENT|PAYMENTS|PAYOUT|TRANSFER|PURCHASE|BUY|CHECKOUT|CHARGE|REFUND|ORDER)(_|$)/;

/** Whether a card may wait for a late answer: never a sign-in, a secret, a server's keys or money. */
export function answerableLate(tool: string, input: Record<string, unknown>): boolean {
  if (STRICT_TOOLS.has(tool) || physicalAccess(tool, input)) return false;
  if (tool === "ask_approval") return input.kind !== "purchase" && !input.total;
  if (tool === "add_mcp_server") return !input.headers && !(input.env && typeof input.env === "object" && Object.keys(input.env).length);
  return !MONEY_ACTION.test(appAction(tool).action);
}

/** What makes two calls the same action: the fields whatever their order, empty ones aside, and for a command only the command. */
function actionKey(tool: string, input: Record<string, unknown>): string {
  return JSON.stringify(canonical(tool === "Bash" ? { command: input.command, background: input.run_in_background === true } : input));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined || field === null || field === "" || (Array.isArray(field) && !field.length)) continue;
    out[key] = canonical(field);
  }
  return out;
}

/**
 * The one call a late yes lets through, in the turn it started (`decideLate`): the same bot, conversation,
 * tool and input as the card the person answered, once, as they left it (an edited letter, Send now).
 * Anything else, or a second call, posts a new card.
 */
function lateYes(bot: Pick<Bot, "id">, threadId: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Answer | null {
  const turn = signal ? resumable.get(signal) : undefined;
  const card = turn?.card ? getApproval(turn.card) : null;
  if (!turn || !card || card.status !== "allowed" || card.botId !== bot.id || card.threadId !== threadId || card.tool !== tool) return null;
  if (actionKey(tool, input) !== actionKey(tool, card.input) || !takeLateYes(turn.messageId, card.id)) return null;
  return { decision: "allow", input: card.input, edited: card.edited, send: card.outcome === "sent", note: null, aside: false };
}

/**
 * A card timed out: the bot says so in the chat in Gond's own words, and a turn answering the person
 * ends there, since there is nothing left for the model to say. A turn on a teammate's errand goes on
 * and hears `expiredText`, so it can report back.
 */
export function cardExpired(bot: Pick<Bot, "id">, threadId: string, signal?: AbortSignal): void {
  postMessage({ threadId, author: bot.id, body: CARD_EXPIRED_LINE, answered: true });
  if (signal) enders.get(signal)?.();
}

/**
 * What a bot hears when its card timed out: the person was already told (`tellCardExpired`), so the
 * turn ends quietly rather than going on without them or asking again unprompted.
 */
export function expiredText(card: string): string {
  return `NOT done: nobody answered the card ${card} in time, so it expired, and the person has been told so in the chat. Don't ask again: if this was a teammate's errand, say in your answer that the person didn't answer the card; otherwise answer exactly ${QUIET_REPLY}.`;
}

/** What a bot hears when the person wrote to it while its card waited: their line reaches it straight after. */
export function setAsideText(card: string): string {
  return `NOT done: the person wrote to you while the card ${card} waited, so it was set aside unanswered and nothing ran. Their message comes next: read it and do what it says. If they still want this done, call it again and a new card goes up.`;
}

/**
 * The person wrote to a bot whose card was waiting in that conversation: each such card closes
 * unanswered (`expired`, outcome `aside`) and the turn goes on with nothing done, so it reads what
 * they wrote now instead of once they tap. How many it closed.
 */
export function setAside(botId: string, threadId: string): number {
  let closed = 0;
  for (const approval of listApprovals({ threadId, status: "pending" })) {
    const waiter = approval.botId === botId ? pending().get(approval.id) : undefined;
    if (!waiter) continue;
    clearTimeout(waiter.timer);
    pending().delete(approval.id);
    offPhones(approval.id);
    resolveApproval(approval.id, "expired", null, { outcome: "aside" });
    waiter.resolve({ decision: "deny", input: approval.input, edited: false, send: false, note: null, aside: true });
    closed += 1;
  }
  return closed;
}

export function boxPermission(level: ApprovalLevel): "ask" | "full" {
  return level === "full" ? "full" : "ask";
}

const OUTWARD_ACTION = /(^|_)(SEND|SENDS|REPLY|FORWARD|DELETE|REMOVE|TRASH|DESTROY|PURGE|ERASE|WIPE|CANCEL|PAY|PAYMENT|TRANSFER|PUBLISH)(_|$)/;

const PIPED_INSTALL = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash)(?=\s|$)|\b(?:sh|bash|zsh|dash)\s+<\(\s*(?:curl|wget)\b/;
const ESCALATES = new Set(["sudo", "su", "doas"]);
const SEGMENTS = /\s*(?:\|\||&&|[;|\n\r`()]|\$\()\s*/;

export function mustAsk(tool: string, input: Record<string, unknown>, bot: Pick<Bot, "id" | "userId">): boolean {
  if (tool === "ask_approval" || tool === "add_mcp_server" || tool === "request_login" || tool === "type_secret" || tool === "forget_secret") return true;
  if (tool === "Bash") return typeof input.command === "string" && riskyCommand(input.command, bot);
  if (physicalAccess(tool, input)) return true;
  // A draft goes nowhere, but the letter card is how the person sees what was written, so it asks too.
  return OUTWARD_ACTION.test(appAction(tool).action) || emailDraftOf(tool, input)?.mode === "draft";
}

function sendsEmail(tool: string): boolean {
  const mode = emailMode(tool)?.mode;
  return mode === "send" || mode === "reply" || mode === "forward";
}

function riskyCommand(command: string, bot: Pick<Bot, "id" | "userId">): boolean {
  if (PIPED_INSTALL.test(command)) return true;
  for (const segment of command.split(SEGMENTS)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.some((word) => ESCALATES.has(word))) return true;
    const name = posix.basename(words[0]!);
    const rest = words.slice(1);
    if (name === "rm") {
      const flags = rest.filter((word) => word.startsWith("-"));
      const forced = flags.some((flag) => flag === "--recursive" || flag === "--force" || /^-[a-zA-Z]*[rRf]/.test(flag));
      const paths = rest.filter((word) => !word.startsWith("-"));
      if (forced && paths.some((path) => !ownPath(bot, path))) return true;
    }
    if (name === "git" && rest.includes("push")) {
      if (rest.some((word) => word === "--force" || word.startsWith("--force-with-lease") || /^-[a-zA-Z]*f/.test(word) || /^\+\S/.test(word))) return true;
    }
  }
  return false;
}

export const ENGINE_FILES_TEXT =
  "Not run: ~/.claude holds the settings and sign-in of the tool you run in, and it is not yours to read or change. Make bots, skills and routines with Gond's tools (create_bot, update_bot, set_profile, save_skill, create_routine) instead.";

const ENGINE_DIR = String.raw`(?:~|\$HOME|\$\{HOME\}|/home/[^/\s"']+|/root)/\.claude(?:\.json)?`;
const ENGINE_PATH = new RegExp(`^${ENGINE_DIR}(?:/|$)`);
const ENGINE_IN_COMMAND = new RegExp(`(?:^|[\\s"'=:(<>])${ENGINE_DIR}(?=$|[/\\s"';|&)<>])`);

const FILE_READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

function reachesEngine(given: string, bot?: Pick<Bot, "id">): boolean {
  const path = given.trim();
  if (!path) return false;
  if (/^[~/$]/.test(path)) return ENGINE_PATH.test(posix.normalize(path));
  // A CLI session runs in the bot's own folder, so a relative path starts there.
  if (bot) return ENGINE_PATH.test(posix.normalize(`~/${botHome(bot.id)}/${path}`));
  const clean = posix.normalize(path);
  return clean.split("/").includes("..") && /(?:^|\/)\.claude(?:\.json)?(?:\/|$)/.test(clean);
}

/** A shell command, a file read or a file change that reaches into the CLI's own settings and sign-ins in the home. */
export function touchesEngine(tool: string, input: Record<string, unknown>, bot?: Pick<Bot, "id">): boolean {
  if (tool === "Bash") return typeof input.command === "string" && ENGINE_IN_COMMAND.test(input.command);
  if (!FILE_TOOLS.has(tool) && !FILE_READS.has(tool)) return false;
  const keys = tool === "Glob" ? [...PATH_KEYS, "pattern"] : PATH_KEYS;
  return keys.some((key) => typeof input[key] === "string" && reachesEngine(input[key] as string, bot));
}

export const SCRIPTED_SCREEN_TEXT =
  "Not run: clicks, typing and scrolling on the screen go through the browser and computer tools, never a script (xdotool, pyautogui, pynput, or a debugging port on Chrome). Send the steps to one of those tools instead.";

const SCREEN_SCRIPTING = /\b(xdotool|ydotool|wtype|pyautogui|pynput)\b|--remote-debugging-(port|pipe)|connect_?over_?cdp|connectOverCDP/i;

/** A shell command or a file that would drive the screen itself instead of through the browser and computer tools. */
export function scriptsTheScreen(tool: string, input: Record<string, unknown>): boolean {
  const texts: unknown[] =
    tool === "Bash"
      ? [input.command]
      : tool === "Write"
        ? [input.content]
        : tool === "Edit"
          ? [input.new_string]
          : tool === "MultiEdit" && Array.isArray(input.edits)
            ? input.edits.map((edit) => (edit && typeof edit === "object" ? (edit as Record<string, unknown>).new_string : null))
            : [];
  return texts.some((text) => typeof text === "string" && SCREEN_SCRIPTING.test(text));
}

export async function requestApproval(input: { bot: Bot; threadId: string; tool: string; input: Record<string, unknown>; summary?: string; signal?: AbortSignal }): Promise<Decision> {
  return (await askApproval(input)).decision;
}

/** The email card this one redrafts: the bot's last in the conversation, if the person sent it back with changes. */
function redrafting(botId: string, threadId: string, tool: string): Approval["revises"] {
  if (!emailMode(tool)) return null;
  const last = listApprovals({ threadId, limit: 10 }).find((a) => a.botId === botId && emailDraftOf(a.tool, a.input));
  return last?.outcome === "changes" ? { tool: last.tool, input: last.input } : null;
}

export async function askApproval(input: { bot: Bot; threadId: string; tool: string; input: Record<string, unknown>; summary?: string; signal?: AbortSignal }): Promise<Answer> {
  const { tool } = input;
  const answer = (decision: Decision): Answer => ({ decision, input: input.input, edited: false, send: false, note: null, aside: false });
  const late = lateYes(input.bot, input.threadId, tool, input.input, input.signal);
  if (late) return late;

  /*
   * The level as it is right now, not as it was when the turn started: a
   * turn can run for minutes, and changing the level while a bot works is
   * exactly when a person does it.
   */
  const bot = getBot(input.bot.id) ?? input.bot;
  // Unlocking a door, a car or an alarm asks every time, whatever the level or a saved rule says, and only while it's current.
  const physical = physicalAccess(tool, input.input);
  if (physical) return postCard({ ...input, bot, strict: true });
  // An email that goes out can't be called back, so even Always allow shows the letter first.
  if (bot.approval === "full" && !sendsEmail(tool)) return answer("allow");
  if (READ_ONLY.has(tool)) return answer("allow");
  if (inOwnHome(bot, tool, input.input)) return answer("allow");
  for (const rule of listRules(bot.id)) {
    if (ruleMatches(rule, tool, input.input)) return answer("allow");
  }
  if (bot.approval === "auto" && !mustAsk(tool, input.input, bot)) return answer("allow");
  return postCard({ ...input, bot });
}

/**
 * A card that always asks, whatever the bot's level: someone on another Gond wants this bot to act
 * (Spaces), and only its owner can say yes to that.
 */
export function askOwner(input: { bot: Bot; threadId: string; input: Record<string, unknown>; summary: string; signal?: AbortSignal }): Promise<Answer> {
  return postCard({ ...input, tool: "ask_approval", strict: true });
}

/** Whether a phone may answer this card from its lock screen: a plain yes or no, never an email, whose card can be read and edited only in full. */
export function answerableOnPhone(approval: Pick<Approval, "tool" | "input">): boolean {
  return !emailDraftOf(approval.tool, approval.input);
}

const buttonLabel = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 24) : fallback);

/** Cards sent to phones with buttons, by id, with the person whose phones have them. */
function onPhones(): Map<string, string> {
  const holder = globalThis as typeof globalThis & { __gondCardsOnPhones?: Map<string, string> };
  holder.__gondCardsOnPhones ??= new Map();
  return holder.__gondCardsOnPhones;
}

/**
 * A card closed (answered, expired, set aside): its buttons come off the phones that had them. A paused
 * card may outlive the process that pushed it, so `card` names whose phones would have it then.
 */
function offPhones(id: string, card?: Pick<Approval, "botId" | "tool" | "input">) {
  const bot = !onPhones().has(id) && card ? getBot(card.botId) : null;
  const person = onPhones().get(id) ?? (bot?.notify && answerableOnPhone(card!) ? personOf(bot.userId) : null);
  if (!person) return;
  onPhones().delete(id);
  void withdrawFromPhones(person, `card-${id}`);
}

/** Paused cards that can't be answered any more read as expired, and come off the phones. How many. */
function unpause(where: Parameters<typeof unpauseApprovals>[0]): number {
  return offPhonesAll(unpauseApprovals(where));
}

function offPhonesAll(cards: Approval[]): number {
  for (const card of cards) offPhones(card.id, card);
  return cards.length;
}

/** The person wrote in the conversation or stopped it: its paused cards can't be answered any more. How many closed. */
export function retirePausedCards(threadId: string): number {
  return unpause({ threadId });
}

/** Paused cards asked more than `LATE_ANSWER_HOURS` ago come off the phones; from the dispatcher's minute. */
export function retireLapsedCards(at = Date.now()): number {
  return offPhonesAll(lapsePausedApprovals(at));
}

/** Whether a conversation holds a card that can still be answered late, so "stop" there has something to stop. */
export function hasPausedCards(threadId: string): boolean {
  return pausedApprovals(threadId).length > 0;
}

/** The bots whose work on this message waits on a paused card: answering it again would only redo that work. */
export function pausedOn(message: Pick<Message, "id" | "threadId">): Set<string> {
  return new Set(pausedApprovals(message.threadId).flatMap((card) => (cardWork(card.id)?.answering === message.id ? [card.botId] : [])));
}

/** `strict`: the card expires in time whatever it asks, as another Gond's request to act does. */
function postCard(input: { bot: Bot; threadId: string; tool: string; input: Record<string, unknown>; summary?: string; signal?: AbortSignal; strict?: boolean }): Promise<Answer> {
  const { bot, threadId, tool } = input;
  const answer = (decision: Decision): Answer => ({ decision, input: input.input, edited: false, send: false, note: null, aside: false });
  const turn = !input.strict && input.signal ? resumable.get(input.signal) : undefined;
  const work = turn && answerableLate(tool, input.input) ? { answering: turn.messageId, done: turn.done().slice(-20) } : undefined;
  // Only a bot's newest card in a conversation can be answered late.
  unpause({ threadId, botId: bot.id });
  const approval = createApproval({ botId: bot.id, threadId, tool, summary: hideSecrets(input.summary ?? summarize(tool, input.input)), input: input.input, revises: redrafting(bot.id, threadId, tool), work });
  postMessage({ threadId, author: bot.id, kind: "approval", body: approval.summary, approvalId: approval.id, answered: true });
  if (bot.notify) {
    const card = answerableOnPhone(approval) ? { id: approval.id, allow: buttonLabel(input.input.allow, "Allow"), deny: buttonLabel(input.input.deny, "Deny") } : undefined;
    if (card) onPhones().set(approval.id, personOf(bot.userId));
    void sendPush({ title: `${bot.name} needs your approval`, body: approval.summary.slice(0, 140), url: `/app/t/${threadId}`, tag: card ? `card-${approval.id}` : threadId, threadId, botId: bot.id, card }, bot.userId);
  }
  return new Promise<Answer>((resolve) => {
    // Nobody answered in time, or the turn that asked was stopped: the card
    // closes, so a late tap can't run something for work that's over.
    const expire = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", expire);
      if (!pending().delete(approval.id)) return;
      // Nobody answered, but the work can start again on a late answer: the turn ends quietly, and the card stays answerable, on the phones too.
      if (!input.signal?.aborted && work && pauseApproval(approval.id)) {
        resolve(answer("expired"));
        enders.get(input.signal!)?.();
        return;
      }
      offPhones(approval.id);
      resolveApproval(approval.id, "expired");
      resolve(answer("expired"));
      // A stopped turn says what stopped on its own; only a card that ran out of time gets the line.
      if (!input.signal?.aborted) cardExpired(bot, threadId, input.signal);
    };
    const timer = setTimeout(expire, approvalTimeoutMs());
    pending().set(approval.id, { resolve: (given) => (input.signal?.removeEventListener("abort", expire), resolve(given)), timer });
    if (input.signal?.aborted) expire();
    else input.signal?.addEventListener("abort", expire, { once: true });
  });
}

/** Why an answer can't apply to this card, or null when it can. */
export function answerProblem(approval: Approval, given: ApprovalAnswer): string | null {
  const email = emailDraftOf(approval.tool, approval.input);
  if (given.send && (given.decision !== "allow" || !sendDraftAction(approval.tool))) return "Only a draft's card can send it";
  if (given.edit && (given.decision === "deny" || !email || !emailEditable(approval.tool))) return "Only an email's card can be edited";
  if (given.edit && ![...given.edit.to, ...given.edit.cc, ...given.edit.bcc].every((who) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailAddressOf(who)))) return "Check the addresses";
  if (given.edit && !given.edit.to.length && !given.edit.cc.length && !given.edit.bcc.length && email?.mode !== "reply" && email?.mode !== "draft") return "Add someone to send it to";
  if (given.note && given.decision !== "deny") return "A note goes with a no";
  if (given.decision === "always" && email) return "An email asks every time";
  return null;
}

const emailAddressOf = (who: string) => /<([^<>]+)>/.exec(who)?.[1]?.trim() ?? who.trim();

/** What an answer does to its card: the rule an Always saves, the letter as the person left it, the note on a no. */
function answerOf(approval: Approval, given: ApprovalAnswer) {
  const { decision } = given;
  const rule = decision === "always" && approval.tool !== "ask_approval" ? ruleFor(approval.tool, approval.input) : null;
  const email = emailDraftOf(approval.tool, approval.input);
  const input = given.edit ? editedEmailInput(approval.tool, approval.input, given.edit) : approval.input;
  const edited = given.edit && JSON.stringify(input) !== JSON.stringify(approval.input) ? input : undefined;
  const note = decision === "deny" ? (given.note?.trim() ?? null) : null;
  const outcome = note ? "changes" : decision === "deny" || email?.mode !== "draft" ? null : given.send ? "sent" : "saved";
  return { status: decision === "deny" ? ("denied" as const) : ("allowed" as const), rule, input, edited, note, outcome } as const;
}

export function decide(id: string, given: ApprovalAnswer): Approval | null {
  const approval = getApproval(id);
  if (!approval) return null;
  if (isPaused(approval)) return decideLate(approval, given);
  if (approval.status !== "pending") return approval;
  const { decision } = given;
  const { status, rule, input, edited, note, outcome } = answerOf(approval, given);
  if (rule) addRule(approval.botId, rule);
  const resolved = resolveApproval(id, status, rule, { outcome, note: note ? hideSecrets(note) : null, input: edited });
  offPhones(id);
  const waiter = pending().get(id);
  if (waiter) {
    clearTimeout(waiter.timer);
    pending().delete(id);
    waiter.resolve({ decision, input, edited: Boolean(edited), send: Boolean(given.send) && decision === "allow", note, aside: false });
  }
  return resolved;
}

/**
 * A late answer to a paused card. Nothing it allowed runs from here, since the price, the recipient or
 * the state may have changed: the bot starts the work again on a hidden prompt that says what it had
 * done and what the person said, checks where things stand, and only the same call goes through once
 * without a new card (`lateYes`).
 */
function decideLate(approval: Approval, given: ApprovalAnswer): Approval | null {
  const work = cardWork(approval.id);
  const { status, rule, input, edited, note, outcome } = answerOf(approval, given);
  const resolved = resolvePaused(approval.id, status, rule, { outcome, note: note ? hideSecrets(note) : null, input: edited });
  if (!resolved) return getApproval(approval.id);
  if (rule) addRule(approval.botId, rule);
  offPhones(approval.id, approval);
  const bot = getBot(approval.botId);
  const thread = getThread(approval.threadId);
  if (!bot || !thread) return resolved;
  const body = hideSecrets(
    lateAnswerText({
      card: approval.summary,
      tool: approval.tool,
      answer: note ? { changes: note } : status === "denied" ? "no" : given.send && outcome === "sent" ? "send" : rule ? "always" : "yes",
      input,
      edited: Boolean(edited),
      working: workingOn(work ? getMessage(work.answering) : null),
      done: work?.done ?? [],
    }),
  );
  // Only a yes carries the card, which is what lets its one call through (`lateYes`).
  postMessage({ threadId: thread.id, author: "system", kind: "prompt", approvalId: status === "allowed" ? approval.id : null, body: thread.kind === "room" ? `@${handleOf(bot.name)} ${body}` : body });
  return resolved;
}

/** The work a paused card stopped, in words for the bot: what it was answering. */
function workingOn(message: Message | null): string | null {
  if (!message) return null;
  const words = plainMarkdown(message.body).replace(/\s+/g, " ").trim();
  const quote = `"${words.length > 300 ? `${words.slice(0, 299).trimEnd()}…` : words}"`;
  if (message.author === "you") return `the person's message ${quote}`;
  if (message.author === "routine") return `your routine "${routineName(message.body) ?? words.slice(0, 80)}"`;
  if (message.kind === "prompt") return `a task from Gond: ${quote}`;
  return `${getBot(message.author)?.name ?? "a teammate"}'s message ${quote}`;
}

export function openApprovals(): Approval[] {
  return listApprovals({ status: "pending" }).reverse();
}
