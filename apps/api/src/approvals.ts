import { posix } from "node:path";
import { QUIET_REPLY, appAction, approvalLine, editedEmailInput, emailDraftOf, emailEditable, emailMode, sendDraftAction, type Approval, type ApprovalAnswer, type ApprovalLevel, type Bot } from "@gond/shared";
import { boxHome } from "./box.ts";
import { approvalTimeoutMs } from "./config.ts";
import { addRule, createApproval, getApproval, listApprovals, listRules, resolveApproval } from "./data/approvals.ts";
import { getBot } from "./data/bots.ts";
import { personOf } from "./data/profiles.ts";
import { botHome } from "./memory.ts";
import { hideSecrets } from "./data/secrets.ts";
import { postMessage } from "./data/threads.ts";
import { withdrawFromPhones } from "./phone-push.ts";
import { sendPush } from "./push.ts";

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

  /*
   * The level as it is right now, not as it was when the turn started: a
   * turn can run for minutes, and changing the level while a bot works is
   * exactly when a person does it.
   */
  const bot = getBot(input.bot.id) ?? input.bot;
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
  return postCard({ ...input, tool: "ask_approval" });
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

/** A card closed (answered, expired, set aside): its buttons come off the phones that had them. */
function offPhones(id: string) {
  const person = onPhones().get(id);
  if (!person) return;
  onPhones().delete(id);
  void withdrawFromPhones(person, `card-${id}`);
}

function postCard(input: { bot: Bot; threadId: string; tool: string; input: Record<string, unknown>; summary?: string; signal?: AbortSignal }): Promise<Answer> {
  const { bot, threadId, tool } = input;
  const answer = (decision: Decision): Answer => ({ decision, input: input.input, edited: false, send: false, note: null, aside: false });
  const approval = createApproval({ botId: bot.id, threadId, tool, summary: hideSecrets(input.summary ?? summarize(tool, input.input)), input: input.input, revises: redrafting(bot.id, threadId, tool) });
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

export function decide(id: string, given: ApprovalAnswer): Approval | null {
  const approval = getApproval(id);
  if (!approval) return null;
  if (approval.status !== "pending") return approval;
  const { decision } = given;
  const rule = decision === "always" && approval.tool !== "ask_approval" ? ruleFor(approval.tool, approval.input) : null;
  if (rule) addRule(approval.botId, rule);
  const email = emailDraftOf(approval.tool, approval.input);
  const input = given.edit ? editedEmailInput(approval.tool, approval.input, given.edit) : approval.input;
  const edited = given.edit && JSON.stringify(input) !== JSON.stringify(approval.input) ? input : undefined;
  const note = decision === "deny" ? (given.note?.trim() ?? null) : null;
  const outcome = note ? "changes" : decision === "deny" || email?.mode !== "draft" ? null : given.send ? "sent" : "saved";
  const resolved = resolveApproval(id, decision === "deny" ? "denied" : "allowed", rule, { outcome, note: note ? hideSecrets(note) : null, input: edited });
  offPhones(id);
  const waiter = pending().get(id);
  if (waiter) {
    clearTimeout(waiter.timer);
    pending().delete(id);
    waiter.resolve({ decision, input, edited: Boolean(edited), send: Boolean(given.send) && decision === "allow", note, aside: false });
  }
  return resolved;
}

export function openApprovals(): Approval[] {
  return listApprovals({ status: "pending" }).reverse();
}
