import { AI_SETUP_CARD, ENGINE_LABELS, QUIET_REPLY, addressedIn, handleOf, isClosing, isStopRequest, mentionsIn, plainMarkdown, replyLine, roomTargets, withoutQuietReply, type Bot, type ChatAttachment, type DesktopDriver, type Message, type Thread, type ToolLabelContext } from "@gond/shared";
import { createHash } from "node:crypto";
import { BoxError, boxConfig, boxHome, closeAgent, ensureBotHome, health, interruptAgent, steerAgent, writeBoxFile, type BoxConfig } from "./box.ts";
import { isUpdating } from "./updater.ts";
import { offerCheckIns, stopCheckIn } from "./check-ins.ts";
import { getAi } from "./data/ai.ts";
import { getBot, getPrimary, listBots } from "./data/bots.ts";
import { type Delegation, finishDelegation, handoffWorkedOn, isDelegationResult, openChildren, openDelegationsFrom, openDelegationsTo } from "./data/delegations.ts";
import { cancelFollowUpsIn } from "./data/follow-ups.ts";
import { finishRoutineRun } from "./data/routines.ts";
import { allSecretValues, listSecrets } from "./data/secrets.ts";
import { userTalk, userTimezone } from "./data/prefs.ts";
import { listConnections } from "./data/settings.ts";
import { listSkills } from "./data/skills.ts";
import { answeringOf, awaitsReport, botLinesSincePerson, closePending, closeSentFrom, dropMessage, getAttachment, getMessage, getThread, markAnswered, openedExchange, postMessage, reactionsOf, recentMessages, markSteered, releaseClaim, setSentTo, stillRouting, threadBusy, threadRefs, unsteer } from "./data/threads.ts";
import { computerTools, secretCommandTool } from "./computer.ts";
import { computerTool } from "./computer-tool.ts";
import { attachmentNote, deliverAttachments, type Delivered } from "./inbox.ts";
import { driversOf, forgetHandBack, handedBack, releaseComputer } from "./desktop.ts";
import { cliTurn } from "./driver.ts";
import { EngineSetupError, engineRun, type EngineRun } from "./engines.ts";
import { getSummary } from "./data/summaries.ts";
import { summarizeThread } from "./summaries.ts";
import { lookTurnEnded, stopTeachingsIn, teachingIn } from "./teach.ts";
import { activity, emit, threadChanged } from "./events.ts";
import { canRoute, routeLine } from "./router.ts";
import { createWriting } from "./writing.ts";
import { answerOnCall, closeCallTurn, handedOnCall } from "./calls.ts";
import { boxMcpServers, mcpServersFor } from "./mcp.ts";
import { nativeMcpTools } from "./mcp-client.ts";
import { nativeTurn, readsPdf, SteerQueue } from "./native.ts";
import { botHome, soulPath } from "./memory.ts";
import { sendPush } from "./push.ts";
import { createRedactor } from "./redact.ts";
import { skillsFor, skillsIndex, skillsReady } from "./skills.ts";
import { renderSoul, skillsInUse, systemPromptFor, talkReminder } from "./souls.ts";
import { clearWork, clipOutput, createTurnClock, labelStep, recordStep, timingLine, type StepUpdate } from "./work.ts";
import { boxPermission, endTurnOnExpiry, setAside } from "./approvals.ts";
import { noteInterrupted, takeInterrupted, wasInterrupted } from "./resume.ts";
import { turnTiming } from "./config.ts";
import { appTools, baseTools, MAX_CHAIN, MAX_ROOM_LINES, permissionTool, resultDepth, teamTools, TOOL_NOTES } from "./tools.ts";
import { guestWorkers, hasGuestWork, isSpace, keepHere, memoryAllowed, postInSpace, SPACE_TURN, spaceNote, spaceTargets, stopGuestWork } from "./spaces.ts";
import { saveClaudeLimits, usageRecorder } from "./usage.ts";
import { loadMemory, loadTeamMemory, transcript } from "./transcript.ts";

const CONTEXT_LINES = 30;
const ROOM_LOOKBACK = 30;

/** What an agent's last turn ran on (`runKey`), and the last message its CLI session was given, if one was. */
type Seen = { run: string; at: string | null };

const seenHolder = globalThis as typeof globalThis & { __gondSeen?: Map<string, Seen> };
/** Per agent, what its last turn ran on and saw: the next turn on the same run sends only what is newer. */
export function seenBy(): Map<string, Seen> {
  return (seenHolder.__gondSeen ??= new Map());
}

/** The engine and account a turn runs on, as far as a CLI session's history goes: a model change within one keeps it. */
export function runKey(run: Pick<EngineRun, "engine" | "access" | "native">): string {
  if (run.native) return `native:${run.native.kind}`;
  if (run.access.kind === "plan") return `${run.engine}:plan`;
  return `${run.engine}:api:${createHash("sha256").update(`${run.access.baseUrl}\n${run.access.token}`).digest("hex").slice(0, 16)}`;
}

/**
 * How a CLI session picks the conversation up. One whose agent last ran on another engine or account
 * (a ChatGPT plan, a key) missed what was said there, so it starts `fresh` on the full prompt. One on the
 * same run hears only what is new since `at`, unless more came than the window holds (`window`, the
 * conversation's last `size` lines, oldest first): then the full prompt's summary covers what the window drops.
 */
export function pickUp(seen: Seen | undefined, run: string, window: Pick<Message, "createdAt">[], size: number): { fresh: boolean; since: string | null } {
  if (seen && seen.run !== run) return { fresh: true, since: null };
  const since = seen?.at ?? null;
  if (!since) return { fresh: false, since: null };
  const reaches = window.length < size || window[0]!.createdAt <= since;
  return { fresh: false, since: reaches ? since : null };
}

const TURN_TIMEOUT_MS = 45 * 60 * 1000;

type Active = {
  botId: string;
  threadId: string;
  userId: string;
  messageId: string;
  // Where this turn's answer goes: the person's line reaches a turn that doesn't answer them as an aside (`asideText`).
  route: AnswerRoute;
  controller: AbortController;
  startedAt: number;

  steer: (text: string) => Promise<boolean>;
};
const holder = globalThis as typeof globalThis & { __gondActiveTurns?: Map<string, Active> };

export function activeTurns(): Map<string, Active> {
  return (holder.__gondActiveTurns ??= new Map());
}

function agentIdFor(bot: Bot, thread: Thread) {
  return `${bot.id}--${thread.id}`;
}

export function isBusy(botId: string, threadId?: string) {
  for (const turn of activeTurns().values()) {
    if (turn.botId === botId && (!threadId || turn.threadId === threadId)) return true;
  }
  return false;
}

export type StopCause = "stopped" | "updating" | "expired";

export function stopCauseOf(signal: AbortSignal): StopCause | null {
  if (!signal.aborted) return null;
  return signal.reason === "updating" || signal.reason === "expired" ? signal.reason : "stopped";
}

export function unansweredEnding(name: string, cause: StopCause | null, failure: string, setupError = false): { event: string | null; incident: boolean } {
  if (cause === "stopped") return { event: `${name} was stopped.`, incident: false };
  // A card that timed out already said so in the bot's own line (`cardExpired`).
  if (cause === "updating" || cause === "expired") return { event: null, incident: false };
  return { event: failure, incident: !setupError };
}

/**
 * What isn't set up when a turn couldn't run, as one sentence for the person's card: no AI picked or
 * signed in, the CLI missing from the computer (the box's 424) or signed out there. Null for any other failure.
 */
function setupProblem(failure: unknown, engine = ENGINE_LABELS.claude.name): string | null {
  if (failure instanceof EngineSetupError) return failure.message;
  if (failure instanceof BoxError && failure.status === 424) return `${engine} isn't set up on the computer.`;
  if (failure && typeof failure === "object" && "signedOut" in failure && failure.signedOut === true) return `${engine} isn't signed in on the computer.`;
  return null;
}

class TurnNotStarted extends Error {}

// The computer went away (restarting, updating, down): the messages it cut off wait, and new ones
// aren't started until it answers, checked again this often; one waiting this long is given up on.
const AWAY_RETRY_MS = 15_000;
const AWAY_GIVE_UP_MS = 30 * 60_000;
const away = globalThis as typeof globalThis & { __gondComputerAway?: number };

export function computerAway(): boolean {
  return Date.now() < (away.__gondComputerAway ?? 0);
}

async function computerAnswers(box: BoxConfig): Promise<boolean> {
  const answers = await health(box).then((h) => h.ok && !h.updating, () => false);
  if (!answers) away.__gondComputerAway = Date.now() + AWAY_RETRY_MS;
  return answers;
}

async function interrupt(threadId: string) {
  let stopped = 0;
  for (const [agentId, turn] of activeTurns()) {
    if (turn.threadId !== threadId) continue;
    turn.controller.abort("stopped" satisfies StopCause);
    const box = boxConfig(turn.userId);
    if (box) await interruptAgent(box, agentId).catch(() => undefined);
    stopped += 1;
  }
  return stopped;
}

const STOP_SETTLE_MS = 5_000;

async function settled(threadId: string, ms = STOP_SETTLE_MS) {
  const until = Date.now() + ms;
  while ([...activeTurns().values()].some((turn) => turn.threadId === threadId) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** What a stop halted: the turns and what they were answering, and everything they had set going. */
type StopReport = { stopped: number; dropped: number; tasks: string[]; screen: boolean; teammates: string[]; sent: number; followUps: number; recordings: number };

async function stopWorkFrom(threadId: string, since: string | null, seen: Set<string>, report: StopReport) {
  for (const handoff of openDelegationsFrom(threadId, since)) {
    finishDelegation(handoff.id, "cancelled", "Stopped by the person.");
    const name = getBot(handoff.toBotId)?.name;
    if (name && !report.teammates.includes(name)) report.teammates.push(name);
    if (!(await interruptMessage(handoff.messageId))) markAnswered(handoff.messageId);
    if (seen.has(handoff.toThreadId)) continue;
    seen.add(handoff.toThreadId);
    await settled(handoff.toThreadId);
    await stopWorkFrom(handoff.toThreadId, handoff.createdAt, seen, report);
  }
  report.sent += closeSentFrom(threadId, since);
  report.followUps += cancelFollowUpsIn(threadId, since);
}

// Conversations stopped by a message: the bot says what it stopped, so the
// turn's own "was stopped" line would only repeat it.
const quietStops = new Set<string>();

export async function stopThread(threadId: string, options: { quiet?: boolean } = {}): Promise<StopReport> {
  const owner = getThread(threadId)?.userId;
  const running = [...activeTurns().values()].filter((turn) => turn.threadId === threadId);
  const report: StopReport = {
    stopped: 0,
    dropped: 0,
    tasks: running.map((turn) => getMessage(turn.messageId)?.body ?? "").filter(Boolean),
    screen: Boolean(owner && driversOf(owner).some((driver) => driver.threadId === threadId)),
    teammates: [],
    sent: 0,
    followUps: 0,
    recordings: 0,
  };
  if (options.quiet) quietStops.add(threadId);
  try {
    report.stopped = await interrupt(threadId);
    if (report.stopped) await settled(threadId);
  } finally {
    quietStops.delete(threadId);
  }
  // A space's answers to another Gond's lines run outside the turns, each with its own stop.
  const guests = stopGuestWork(threadId);
  report.stopped += guests.stopped;
  report.tasks.push(...guests.tasks);
  report.dropped = closePending(threadId) + guests.dropped;
  report.recordings = await stopTeachingsIn(threadId);
  await stopWorkFrom(threadId, null, new Set([threadId]), report);

  if (owner && getPrimary(owner)?.threadId === threadId && stopCheckIn(owner)) report.stopped += 1;
  if (owner) forgetHandBack(owner, threadId);
  for (const handoff of openDelegationsTo(threadId)) closeStopped(handoff, getBot(handoff.toBotId)?.name ?? "The teammate");
  if (report.dropped && !options.quiet) postMessage({ threadId, author: "system", kind: "event", body: `Stopped. ${report.dropped} waiting message${report.dropped === 1 ? " was" : "s were"} dropped.`, answered: true });
  return report;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count === 1 ? "one" : count} ${count === 1 ? one : many}`;
}

function names(list: string[]) {
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** The bot's own account of a stop, written from the report so it is exact. */
export function stoppedReply(report: StopReport): string {
  const lines: string[] = [];
  if (report.stopped) {
    const task = report.tasks[0] ? plainMarkdown(report.tasks[0]) : "";
    const what = task ? `working on "${task.length > 80 ? `${task.slice(0, 79).trimEnd()}…` : task}"` : "what I was doing";
    lines.push(`I stopped ${what}${report.screen ? ", and what I was doing in the browser" : ""}.`);
  }
  if (report.teammates.length) lines.push(`I called off what I handed to ${names(report.teammates)}.`);
  if (report.sent) lines.push(`I closed ${plural(report.sent, "message")} to teammates that ${report.sent === 1 ? "was" : "were"} still waiting.`);
  if (report.followUps) lines.push(`I cancelled ${plural(report.followUps, "follow-up")} I had planned.`);
  if (report.dropped) lines.push(`I dropped ${plural(report.dropped, "waiting message")}.`);
  if (report.recordings) lines.push("I stopped watching and threw away the recording.");
  if (!lines.length) return "Nothing was running, so there was nothing to stop.";
  return ["Stopped.", lines.map((line) => `- ${line}`).join("\n"), "I won't pick it back up unless you ask."].join("\n\n");
}

/** Whether a stop in this conversation would halt anything. */
export function hasWork(threadId: string): boolean {
  return [...activeTurns().values()].some((turn) => turn.threadId === threadId) || openDelegationsFrom(threadId).length > 0 || threadBusy(threadId) || teachingIn(threadId) || hasGuestWork(threadId);
}

export async function stopBot(bot: Bot) {
  await stopThread(bot.threadId);
  for (const [agentId, turn] of activeTurns()) {
    if (turn.botId !== bot.id) continue;
    turn.controller.abort("stopped" satisfies StopCause);
    const box = boxConfig(turn.userId);
    if (box) await interruptAgent(box, agentId).catch(() => undefined);
  }
}

export async function stopAll(userId: string): Promise<{ stopped: number; dropped: number }> {
  const total = { stopped: 0, dropped: 0 };
  for (const thread of threadRefs(userId)) {
    const one = await stopThread(thread.id);
    total.stopped += one.stopped;
    total.dropped += one.dropped;
  }
  return total;
}

async function interruptMessage(messageId: string): Promise<boolean> {
  for (const [agentId, turn] of activeTurns()) {
    if (turn.messageId !== messageId) continue;
    turn.controller.abort("stopped" satisfies StopCause);
    const box = boxConfig(turn.userId);
    if (box) await interruptAgent(box, agentId).catch(() => undefined);
    return true;
  }
  return false;
}

const HANDED_BACK_STEER =
  "The person took control of the screen while you were working and has now given it back. They may have changed things, so take a screenshot before your next step and carry on from what you see, not from where you were; don't redo what they did.";
const HANDED_BACK_PROMPT =
  "The person took control of the screen while you were working on it and has now given it back. Take a screenshot to see what they did, then carry on with the work from there, without redoing their part. If it is already finished, tell them in a line.";

const DESKTOP_FREE_STEER = "Your screen you were waiting for is free now: take a screenshot and carry on with what you were going to do on it.";
const DESKTOP_FREE_PROMPT =
  "Your screen was busy with your work in another conversation when you needed it, and it is free now. Take a screenshot and carry on with what you were going to do on it. If it is already done or no longer needed, tell the person in a line.";

/** The person gave a bot's screen back: each reply it was taken from carries on, in its running turn or a new one. */
export async function tellHandedBack(userId: string, botId: string): Promise<void> {
  await carryOn(userId, handedBack(userId, botId), HANDED_BACK_STEER, HANDED_BACK_PROMPT);
}

async function carryOn(userId: string, drivers: DesktopDriver[], steerWith: string, prompt: string): Promise<void> {
  for (const driver of drivers) {
    const thread = getThread(driver.threadId);
    const bot = getBot(driver.botId);
    if (!thread || !bot || thread.userId !== userId) continue;
    const turn = [...activeTurns().values()].find((t) => t.botId === bot.id && t.threadId === thread.id);
    if (turn && (await turn.steer(steerWith).catch(() => false))) continue;
    const body = thread.kind === "bot" ? prompt : `@${handleOf(bot.name)} ${prompt}`;
    postMessage({ threadId: thread.id, author: "system", kind: "prompt", body });
  }
}

/** A teammate's note handed to every turn of the bot running now; false when none took it. */
async function tellWorking(bot: Bot, text: string): Promise<boolean> {
  const turns = [...activeTurns().values()].filter((turn) => turn.botId === bot.id);
  const taken = await Promise.all(turns.map((turn) => turn.steer(text).catch(() => false)));
  return taken.some(Boolean);
}

export function steerText(body: string): string {
  return `The person sent this while you were working:\n\n${body}\n\nIf it changes what you're doing, adjust course; otherwise keep it in mind and carry on. Don't start over: this is part of the same piece of work, and your answer at the end covers it.`;
}

/** The bots answering in a conversation right now. */
function workingIn(threadId: string): string[] {
  return [...activeTurns().values()].filter((turn) => turn.threadId === threadId).map((turn) => turn.botId);
}

/**
 * The person's line reaching a turn whose answer goes to a teammate or up a chain (a handoff, an
 * `ask_bot`): the person hears from it through post_message, since its final answer isn't theirs.
 */
export function asideText(body: string, teammate: string): string {
  return `The person wrote to you in your chat with them while you work on what ${teammate} asked of you:\n\n${body}\n\nYour final answer goes to ${teammate}, not to the person, so answer them now with post_message. If they ask for something else, do it too and tell them with post_message; if it has to wait, say so, finish ${teammate}'s task, then do it and tell them before your final answer. Keep what is theirs out of your final answer, and carry on with the task.`;
}

/**
 * The person's line goes into the running answers of the bots it is for, as a
 * message in a group chat reaches those mid-reply; `all` when every one of
 * them took it, so nobody needs a new turn for it. A bot on a teammate's task
 * hears it as an aside (`asideText`), so it never sits unanswered behind the task.
 */
function steerableTurns(thread: Thread, message: Pick<Message, "author" | "body">, targets = targetsFor(message, thread, listBots({ includeHidden: true, userId: thread.userId }), roomBefore(thread), workingIn(thread.id))): { turns: Active[]; all: boolean } {
  const running = [...activeTurns().values()].filter((turn) => turn.threadId === thread.id);
  const turns = targets.flatMap((bot) => running.find((turn) => turn.botId === bot.id) ?? []);
  return { turns, all: targets.length > 0 && turns.length === targets.length };
}

/**
 * A person's line into running turns. A turn that took it while waiting on a card can't read it until
 * the card is answered, so the card is set aside once the line is in, and the turn reads it next. A
 * line replying to a message (a tap on its choices, or a quote) answers that message, not the card:
 * the card stays for its own answer, and the turn reads the line after it.
 */
export async function steer(turns: Active[], body: string, { keepCards = false } = {}): Promise<boolean[]> {
  return Promise.all(
    turns.map(async (turn) => {
      const taken = await turn.steer(turn.route === "person" ? steerText(body) : asideText(body, teammateOf(turn))).catch(() => false);
      if (taken && !keepCards) setAside(turn.botId, turn.threadId);
      return taken;
    }),
  );
}

function teammateOf(turn: Active): string {
  const author = getMessage(turn.messageId)?.author;
  return (author && getBot(author)?.name) || "a teammate";
}

type PersonLine = { body: string; attachments?: ChatAttachment[]; after?: boolean; replyTo?: string | null };

export async function postFromPerson(thread: Thread, input: PersonLine): Promise<Message> {
  if (!input.attachments?.length && !input.replyTo && isStopRequest(input.body) && hasWork(thread.id)) return stopFromMessage(thread, input.body);
  // In a space people talk to each other too: a line that names none of the person's bots is only said.
  const inSpace = spaceTargets(thread, input.body);
  if (inSpace && !inSpace.length) return postInSpace(thread, input, []);
  if (forTheRouter(thread, input.body)) return postForRouter(thread, input);
  const { turns, all } = !input.after && !input.attachments?.length ? steerableTurns(thread, { author: "you", body: input.body }) : { turns: [], all: false };
  // Taken by every bot it is for, the line needs no turn of its own; else the idle ones answer it as usual, while those mid-answer already have it.
  const message = postMessage({ threadId: thread.id, author: "you", body: input.body, attachments: input.attachments, steered: all, replyTo: input.replyTo });
  if (turns.length) {
    const taken = await steer(turns, `${replyLine(message.replyTo, (author) => (author === "you" ? "you" : (getBot(author)?.name ?? author)))}${input.body}`, { keepCards: Boolean(message.replyTo) });
    if (all && !taken.some(Boolean)) unsteer(message.id);
  }
  return getMessage(message.id) ?? message;
}

/** A room line that names nobody, with words to judge and bots to choose from, is the router's to place; a thanks isn't worth a call. */
function forTheRouter(thread: Thread, body: string): boolean {
  if (thread.kind !== "room" || !body.trim() || isClosing(body)) return false;
  const members = visibleMembers(thread, listBots({ includeHidden: true, userId: thread.userId }));
  return members.length > 1 && addressedIn(body, members).length === 0 && canRoute(thread.userId);
}

/**
 * Posts a room line held back from the dispatcher (`routing`) and returns at once, so the composer
 * never waits on the model; then the router names whom it is for, the line steers their running
 * answers as any other would, and what is left is released for the dispatcher.
 */
function postForRouter(thread: Thread, input: PersonLine): Message {
  const message = postMessage({ threadId: thread.id, author: "you", body: input.body, attachments: input.attachments, replyTo: input.replyTo, routing: true });
  void routeAndDeliver(thread, message, input).catch((error: unknown) => {
    console.error(`[gond] routing a line in ${thread.id} failed:`, error);
    releaseClaim(message.id);
    threadChanged(thread.id);
  });
  return message;
}

async function routeAndDeliver(thread: Thread, message: Message, input: PersonLine) {
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const { targets, routed } = await routeLine(thread, message, visibleMembers(thread, bots), bots, roomBefore(thread, message));
  if (!stillRouting(message.id)) return;
  if (routed) setSentTo(message.id, targets.map((b) => b.id));
  const { turns, all } = !input.after && !input.attachments?.length ? steerableTurns(thread, message, targets) : { turns: [], all: false };
  const taken = turns.length ? await steer(turns, `${replyLine(message.replyTo, (author) => (author === "you" ? "you" : (getBot(author)?.name ?? author)))}${input.body}`, { keepCards: Boolean(message.replyTo) }) : [];
  if (all && taken.some(Boolean)) markSteered(message.id);
  else releaseClaim(message.id);
  threadChanged(thread.id);
}

// "stop" in the chat is Stop: everything halts, nothing reads the message as
// a task, and the bot that was working says what it stopped. In a space both
// stay on this Gond: they're said to its own bots, not to the room.
export async function stopFromMessage(thread: Thread, body: string, options: { spoken?: boolean } = {}): Promise<Message> {
  const message = keepHere(() => postMessage({ threadId: thread.id, author: "you", body, answered: true, spoken: options.spoken }));
  const working = [...activeTurns().values()].find((turn) => turn.threadId === thread.id)?.botId ?? guestWorkers(thread.id)[0];
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const author = working ?? targetsFor({ author: "you", body }, thread, bots, roomBefore(thread))[0]?.id;
  const report = await stopThread(thread.id, { quiet: true });
  if (author) keepHere(() => postMessage({ threadId: thread.id, author, body: stoppedReply(report), answered: true }));
  else postMessage({ threadId: thread.id, author: "system", kind: "event", body: "Stopped.", answered: true });
  return getMessage(message.id) ?? message;
}

/**
 * Who a message wakes. In a room the person is read like a group chat
 * (`roomTargets`: whom they name, else the bot that spoke last, else the primary); a bot's
 * line wakes only the teammates it @mentions, since bots name each other in
 * passing. `before` is the room's messages ahead of this one (`roomBefore`).
 */
export function targetsFor(message: Pick<Message, "author" | "body"> & { sentTo?: string[] | null }, thread: Thread, bots: Bot[], before: Pick<Message, "author" | "kind" | "body" | "sentTo">[] = [], working: readonly string[] = []): Bot[] {
  const members = visibleMembers(thread, bots);
  if (thread.kind === "bot") return members.filter((b) => b.id !== message.author);
  if (message.author === "you") {
    const routed = message.sentTo ? members.filter((b) => message.sentTo!.includes(b.id)) : [];
    return routed.length ? routed : roomTargets(message.body, members, before, working);
  }
  const mentioned = mentionsIn(message.body);
  if (mentioned.includes("everyone") || mentioned.includes("all")) return members.filter((b) => b.id !== message.author);
  return members.filter((b) => mentioned.includes(handleOf(b.name)) && b.id !== message.author);
}

function visibleMembers(thread: Thread, bots: Bot[]): Bot[] {
  return thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b) && !b!.hidden);
}

/** The other bots a room's message wakes along with `bot`: their turns run beside its own, so neither sees the other's answer yet. */
function answeringAlongside(bot: Pick<Bot, "id">, thread: Thread, message: Message, bots: Bot[]): Bot[] {
  if (thread.kind !== "room") return [];
  const answering = getBot(message.author) ? answeringOf(message.id) : null;
  const woken = answering ? wokenBy(message, thread, answering, bots) : targetsFor(message, thread, bots, roomBefore(thread, message));
  return woken.filter((b) => b.id !== bot.id);
}

/** A room's recent messages ahead of `message` (all of them for one not posted yet), oldest first; nothing for a 1:1. */
function roomBefore(thread: Thread, message?: Pick<Message, "id" | "createdAt">): Message[] {
  if (thread.kind !== "room") return [];
  const recent = recentMessages(thread.id, ROOM_LOOKBACK);
  return message ? recent.filter((m) => m.id !== message.id && m.createdAt <= message.createdAt) : recent;
}

// Each bot's SOUL.md as last written to the computer, so a turn writes it only when it changed.
const soulsWritten = new Map<string, string>();

export function forgetSouls() {
  soulsWritten.clear();
}

export async function syncSoul(bot: Bot) {
  const box = boxConfig(bot.userId);
  if (!box) return;
  const soul = renderSoul(bot);
  if (soulsWritten.get(bot.id) === soul) return;
  try {
    await ensureBotHome(box, bot.id);
    await writeBoxFile(box, soulPath(bot.id), soul);
    soulsWritten.set(bot.id, soul);
  } catch (error) {
    console.warn(`[gond] could not write SOUL.md for ${bot.name}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * A file's words for the prompt, when it is text by its type and by its bytes; null for anything else, so
 * a document, archive or program the person sent stays in the inbox for the bot's own tools.
 */
export function attachmentText(mediaType: string, data: Uint8Array): string | null {
  if (!isTextType(mediaType)) return null;
  // A browser can call any file text: a NUL byte says it isn't.
  if (data.subarray(0, 8192).includes(0)) return null;
  return Buffer.from(data).toString("utf8").slice(0, 60_000);
}

const isTextType = (mediaType: string) => mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "image/svg+xml";

function textAttachments(message: Message): string {
  const parts: string[] = [];
  for (const meta of message.attachments) {
    const file = isTextType(meta.mediaType) ? getAttachment(meta.id) : null;
    const text = file ? attachmentText(meta.mediaType, file.data) : null;
    if (text === null) continue;
    parts.push(`<attachment name="${meta.name}">\n${text}\n</attachment>`);
  }
  return parts.join("\n");
}

type PromptOptions = {
  // The last message a resumed session already saw: only what is newer goes in.
  since?: string | null;
  // The conversation's running summary, for a prompt that starts from nothing.
  summary?: string | null;
};

const ROOM_TURN = `This is a room. If the last message isn't for you (another member's question, or an option from their message), answer exactly ${QUIET_REPLY}, and nothing is posted. Also read what the person asked the room since you last spoke here: if an earlier question was meant for everyone or for you and your part isn't answered yet, answer it too. When part of a question is another member's (by their job), @mention them in your answer with what to look at, so they answer too; never tell the person to ask them. If a member's line only asks you for what you already said here since the person last wrote, answer exactly ${QUIET_REPLY}.`;

const ROOM_UNNAMED = `The person named nobody in this line, so it came to you alone (Gond judged it yours from the bots' jobs and the talk so far): answer it, never ${QUIET_REPLY}, since nobody else sees it. If it is plainly another member's area (by their job), say so in a line and @mention them with what to look at, so they answer.`;

export function promptFor(bot: Bot, thread: Thread, message: Message, bots: Bot[], delivered: Delivered[] = [], options: PromptOptions = {}): string {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const who =
    message.author === "you"
      ? "the person"
      : message.author === "routine"
        ? "a scheduled routine"
        : message.author === "system"
          ? "Gond itself (a system report, not the person)"
          : `${names.get(message.author) ?? message.author}, a teammate`;
  const since = options.since ?? null;
  const history = transcript(thread, bots, bot, message, CONTEXT_LINES, { after: since });
  const heading = since ? "New in the conversation since your last turn (newest last):" : "The conversation so far (newest last):";
  const earlier = !since && options.summary ? `Earlier in this conversation, summarized (it comes before the messages below):\n${options.summary}` : "";
  const files = [attachmentNote(delivered), textAttachments(message)].filter(Boolean).join("\n\n");

  const route = answerGoesTo(message);
  // A session a teammate woke was told to answer it in its final line; every turn in the same
  // session whose answer reaches the person must hear that it only ever reaches the person.
  const teammates = route === "person" ? [...new Set(recentMessages(thread.id, CONTEXT_LINES).filter((m) => m.id !== message.id && m.fromThreadId && !PEOPLE_AND_GOND.has(m.author) && m.author !== bot.id).map((m) => names.get(m.author) ?? "a teammate"))] : [];
  const toPerson = teammates.length
    ? `\n\nYour answer goes to the person only, in this chat, like anything you post with post_message. ${teammates.join(" and ")} wrote here as a teammate and was answered already; to tell a teammate something now (a result, a reply), call message_bot, or delegate_bot for new work, then answer the person.`
    : "";
  const alongside = answeringAlongside(bot, thread, message, bots).map((b) => b.name);
  const together = alongside.length
    ? ` ${alongside.join(" and ")} ${alongside.length > 1 ? "are" : "is"} answering this same message at the same time and can't see your answer yet, nor you theirs. Cover your own part only, and don't @mention them for theirs: they're already on it.`
    : "";
  const members = bots.filter((b) => thread.members.includes(b.id));
  const alone = thread.kind === "room" && message.author === "you" && !alongside.length && !addressedIn(message.body, members).length && !isClosing(message.body);
  const room = thread.kind === "room" ? `\n\n${ROOM_TURN}${together}${alone ? ` ${ROOM_UNNAMED}` : ""}${isSpace(thread) ? `\n\n${SPACE_TURN}` : ""}` : "";
  const talk = route === "person" ? talkReminder(userTalk(thread.userId)) : "";

  if (message.kind === "prompt") {
    return [earlier, `${heading}\n${history || (since ? "(nothing new)" : "(nothing yet)")}`, `Gond, not the person, asks you this; nobody else sees it. Do it, and address your answer to the person:\n${message.body}${toPerson}`, isSpace(thread) ? SPACE_TURN : "", talk].filter(Boolean).join("\n\n");
  }
  const sender = names.get(message.author) ?? "a teammate";
  const result = message.fromThreadId && !PEOPLE_AND_GOND.has(message.author) && isDelegationResult(message.id);
  const from = !message.fromThreadId || PEOPLE_AND_GOND.has(message.author)
    ? ""
    : result && route === "chain"
      ? `\n\nThis is ${sender}'s result for part of the task you were handed. Once every part is in, your answer is the result of your whole task: it goes back to whoever handed it to you, not to ${sender} and not to the person.`
      : result
        ? `\n\nThis is the result of the task you handed ${sender}. Your answer goes to the person, in this chat: tell them what came of it. Don't thank or address ${sender}; to tell ${sender} anything, use message_bot.`
        : route === "person"
          ? `\n\nThis is ${sender} answering what you asked it while working on the person's request. Your answer goes to the person, in this chat: carry on with their request (if you said you'd do your part once it reported, do it now) and tell them what came of it. If you still wait on another teammate before there's anything to do or tell, answer exactly ${QUIET_REPLY}. Don't thank or address ${sender}; to tell ${sender} anything, use message_bot.`
          : message.note === "action"
            ? `\n\nThis is an action from ${sender}: it needs you to do something. Act on it now: do the work it asks for (don't just acknowledge it or say you will), then answer with what you did and what came of it. Your answer goes back to ${sender} as information, not to the person; if ${sender} must then do something itself, also tell it with message_bot as an action. If it brings something the person should hear (a result, a change, a question for them), tell them with post_message, which posts in your chat with them.`
            : `\n\nThis message came from ${sender}. Do the work it asks for and answer with the result; your answer goes back to them, not to the person. If it brings something the person should hear (a result, a change, a question for them), tell them with post_message, which posts in your chat with them, then answer ${sender} in a line.`;
  return [
    earlier,
    `${heading}\n${history}`,
    files,
    `Now answer the last message, which is from ${who}.${from}${toPerson}${room}\n${message.author === "routine" ? "This is a scheduled routine: do the job and report, addressing the person." : ""}`,
    message.author === "you" && isClosing(message.body) ? `It reads as the person closing the exchange (a thanks, an "I will", a goodbye). Unless it answers a question you asked, react to it with the react tool (👍 or ❤️) and answer with exactly ${QUIET_REPLY}, so nothing more is posted.` : "",
    talk,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function botTurn(bot: Bot, thread: Thread, message: Message, parent?: AbortSignal): Promise<string> {
  const box = boxConfig(thread.userId);
  if (!box) {
    postMessage({ threadId: thread.id, author: "system", kind: "event", body: "Gond isn't connected to its computer, so no bot can answer. Whoever runs this Gond can fix it.", answered: true });
    if (message.author === "routine") finishRoutineRun(message.id, false);
    closeCallTurn(message.id, "failed");
    return "";
  }
  if (isUpdating()) throw new TurnNotStarted("The computer is updating; the bots answer when it's back.");
  const agentId = agentIdFor(bot, thread);
  if (activeTurns().has(agentId)) throw new TurnNotStarted("already answering");
  const controller = new AbortController();

  const follow = () => controller.abort(parent?.reason);
  if (parent?.aborted) follow();
  else parent?.addEventListener("abort", follow, { once: true });
  const active: Active = { botId: bot.id, threadId: thread.id, userId: thread.userId, messageId: message.id, route: answerGoesTo(message), controller, startedAt: Date.now(), steer: async () => false };
  activeTurns().set(agentId, active);
  if (active.route === "person") endTurnOnExpiry(controller.signal, () => controller.abort("expired" satisfies StopCause));
  const steers = new SteerQueue();
  clearWork(thread.id, bot.id);
  activity(thread.id, bot.id, "Thinking…");
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const askBot = async (target: Bot, prompt: string, depth: number): Promise<string> => {
    if (depth > MAX_CHAIN) return "(too many bot-to-bot hops)";
    const targetThread = getThread(target.threadId);
    if (!targetThread) return "(no conversation)";
    const posted = postMessage({ threadId: target.threadId, author: bot.id, body: prompt, depth, fromThreadId: thread.id, answered: true });

    return botTurn(target, targetThread, posted, controller.signal).catch((error: unknown) => `(${target.name} could not answer: ${error instanceof Error ? error.message : "error"})`);
  };
  const context = { box, bot, thread, message, askBot, syncSoul, stopWork: interruptMessage, isWorking: isBusy, tellWorking, reportTo, signal: controller.signal };
  let reply = "";
  let quiet = false;
  let stopped = false;
  let summaryRun: EngineRun | null = null;
  let ranOn: string | null = null;
  let engineName: string = ENGINE_LABELS.claude.name;

  let broke: string | null = null;
  // Why a turn ended without an answer, for a Show me how card that waited on it.
  let unanswered: string | null = null;
  // Cut off by the computer (an update, or it went away), not by anything wrong with the work: the
  // message goes back to wait and is answered again once the computer is back.
  let again = false;

  // A failure line names the person's message it failed to answer, so Try again can send it again.
  const retryable = message.author === "you" && message.kind === "message";
  const answering = retryable ? message.id : null;
  const failedLine = (body: string) => {
    if (retryable) noteInterrupted(message.id, done, true);
    postMessage({ threadId: thread.id, author: "system", kind: "event", body, answered: true, answering });
  };
  /** `setup`: what isn't set up (`setupProblem`), posted as a card to fix it rather than an incident. */
  const endUnanswered = async (failure: string, detail: string, setup: string | null) => {
    unanswered = detail;
    const cause = stopCauseOf(controller.signal);
    stopped = cause === "stopped";
    if (cause === "updating" || (!cause && box && !(await computerAnswers(box)))) {
      if (Date.now() - Date.parse(message.createdAt) < AWAY_GIVE_UP_MS) {
        again = true;
        return;
      }
      failedLine(`The computer didn't come back in time, so ${bot.name} couldn't answer. Send it again once it's up.`);
      return;
    }
    const ending = unansweredEnding(bot.name, cause, failure, Boolean(setup));
    if (setup && !cause) {
      if (retryable) noteInterrupted(message.id, done, true);
      // One setup card per bot and conversation: the one tied to the person's message, which can be tried again, wins.
      const open = recentMessages(thread.id, 30).filter((m) => m.kind === "signin" && m.approvalId === AI_SETUP_CARD && m.author === bot.id);
      if (!answering && open.length) return;
      for (const old of open) if (!old.answering) dropMessage(old.id);
      postMessage({ threadId: thread.id, author: bot.id, kind: "signin", approvalId: AI_SETUP_CARD, body: setup, answered: true, answering });
      return;
    }
    if (ending.event && !(cause === "stopped" && quietStops.has(thread.id))) {
      if (cause === "stopped") postMessage({ threadId: thread.id, author: "system", kind: "event", body: ending.event, answered: true });
      else failedLine(ending.event);
    }
    if (!ending.incident) return;
    if (handoffWorkedOn(message.id)) broke = detail;
    else await raiseIncident(bot, thread, message, detail);
  };

  const secrets = allSecretValues();
  const hide = createRedactor(secrets);

  const scrub = createRedactor(secrets, Infinity);

  const ownerHome = boxHome(thread.userId);
  const labels: ToolLabelContext = { home: ownerHome ? `${ownerHome}/${botHome(bot.id)}` : null, servers: mcpServersFor(bot).map((server) => ({ name: server.name })) };

  const clock = createTurnClock(Date.now, Date.parse(message.createdAt));
  // Only an answer bound for the person is shown as it is written; one for a teammate or up a chain isn't theirs to read.
  const writing = active.route === "person" && !handedOnCall(message.id) ? createWriting((text) => emit({ topic: "writing", threadId: thread.id, botId: bot.id, text }), scrub) : null;
  const onText = (text: string | null) => {
    if (text) clock.firstText();
    writing?.text(text);
  };
  // What this turn finished, in words, for the turn that answers again if this one is cut off.
  const done: string[] = [];
  const resumed = takeInterrupted(message.id);
  const step = (raw: StepUpdate) => {
    clock.step(raw);
    const update = labelStep(raw, labels);
    if (update.status === "done" && update.title && !update.quiet) done.push(hide(update.title));
    recordStep(thread.id, bot.id, {
      ...update,
      ...(update.title !== undefined ? { title: hide(update.title) } : {}),
      ...(update.detail ? { detail: clipOutput(scrub(update.detail)) } : {}),
      ...(update.output ? { output: scrub(update.output) } : {}),
    });
  };
  try {
    const mcpServers = boxMcpServers(bot);
    const skills = listSkills(bot.userId);
    const run = engineRun(getAi(thread.userId), thread.userId);
    engineName = ENGINE_LABELS[run.engine].name;
    const onUsage = usageRecorder(thread.userId, bot.id, thread.id, run);

    active.steer = run.native ? async (text) => steers.push(text) : async (text) => (await steerAgent(box, agentId, text).catch(() => ({ steered: false }))).steered;

    // None of these wait on another, and each is a round trip to the computer or a service.
    const [memory, teamMemory, nativeMcp, apps] = await Promise.all([
      syncSoul(bot).then(() => loadMemory(box, bot.id)),
      loadTeamMemory(box, bot.userId),
      run.native ? nativeMcpTools({ bot: bot, thread, signal: controller.signal }) : null,
      appTools(context),
      skillsReady(bot.userId),
    ]);
    const tools = {
      ...(nativeMcp?.tools ?? {}),
      ...baseTools(context),
      ...teamTools(context),
      ...apps,
      ...(run.native ? computerTools(context) : { permission: permissionTool(context) }),
      ...computerTool(context),
      ...secretCommandTool(context),
    };
    const inSpace = spaceNote(thread);
    const instructions = systemPromptFor(bot, {
      bots,
      thread,
      memory,
      teamMemory,
      connections: listConnections(bot.userId),
      toolNotes: TOOL_NOTES,
      timezone: userTimezone(thread.userId),
      skillsIndex: skillsIndex(skills),
      talk: userTalk(thread.userId),
      logins: [...new Set(listSecrets(bot.userId).flatMap((s) => (s.site ? [s.site] : [])))],
      space: inSpace ? { note: inSpace, memoryLeftOut: !memoryAllowed(thread, bot) } : null,
      mcpServers: nativeMcp?.servers ?? mcpServersFor(bot).map((m) => ({ name: m.name, note: m.authStatus === "needed" ? `not attached yet: it waits for the person to sign in, from its card or Settings → Apps → MCP servers → ${m.name} → Sign in, and its tools arrive on your next reply after that` : m.authStatus === "error" ? `sign-in problem (${m.authError ?? "unknown"}); its tools may fail` : undefined })),
    });

    const delivered = message.attachments.length ? await deliverAttachments(box, bot, message, controller.signal, { pdf: !run.native || readsPdf(run.native) }) : { files: [], inline: [] };
    controller.signal.throwIfAborted();
    const inUse = skillsInUse(skillsFor(message.body, skills));
    const turnNotes = `${inUse ? `\n\n${inUse}` : ""}${resumed ? `\n\n${resumed}` : ""}`;
    const prompt = promptFor(bot, thread, message, bots, delivered.files, { summary: getSummary(thread.id)?.summary }) + turnNotes;
    ranOn = runKey(run);
    const pick = run.native ? { fresh: false, since: null } : pickUp(seenBy().get(agentId), ranOn, recentMessages(thread.id, CONTEXT_LINES), CONTEXT_LINES);
    // Forgets the session on the computer, so it starts over instead of resuming history from before the switch.
    if (pick.fresh) await closeAgent(box, agentId).catch(() => undefined);
    const since = pick.since;
    const followUp = since ? promptFor(bot, thread, message, bots, delivered.files, { since }) + turnNotes : undefined;
    summaryRun = run;
    clock.ready();
    const result = run.native
      ? await nativeTurn({
          access: run.native,
          model: run.model,
          instructions,
          prompt,
          attachments: delivered.inline,
          tools,
          signal: controller.signal,
          onLog: (line) => activity(thread.id, bot.id, hide(line)),
          onStep: step,
          steers,
          cacheKey: agentId,
          onText,
          onUsage,
        }).then((native) => ({ ...native, recovered: false }))
      : await cliTurn({
      box,
      agentId,
      botId: bot.id,
      engine: run.engine,
      access: run.access,
      modelId: run.model,
      permission: boxPermission(bot.approval),
      instructions,
      prompt,
      followUp,
      attachments: delivered.inline,
      tools,
      mcpServers,
      home: labels.home,
      timeoutMs: TURN_TIMEOUT_MS,
      signal: controller.signal,
      onLog: (line) => activity(thread.id, bot.id, hide(line)),
      onStep: step,
      onText,
      onUsage,
      onLimits: (limits) => saveClaudeLimits(thread.userId, limits),
    });
    seenBy().set(agentId, { run: ranOn, at: result.ok && !run.native ? message.createdAt : null });
    const said = result.ok ? withoutQuietReply(result.text) : "";
    const silent = result.ok && !said && Boolean(result.text.trim());
    if (silent && message.author === "routine") {
      quiet = true;
    } else if (result.ok && !said && reactedOnly(bot, message)) {
      // The reaction was the whole answer, as a thumbs up is between people.
    } else if (silent && active.route === "person") {
      // Nothing for the person (in a room, often a line meant for another bot): nothing is posted.
    } else if (said) {
      reply = scrub(said);
      if (!answerOnCall(message.id, reply)) {
        deliverReply(bot, thread, message, reply);

        if (bot.notify && (message.author === "you" || message.author === "routine")) {
          void sendPush({ title: bot.name, body: plainMarkdown(reply).slice(0, 140), url: `/app/t/${thread.id}`, tag: thread.id, threadId: thread.id, botId: bot.id }, thread.userId);
        }
      }
    } else {
      const detail = hide(result.error ?? (result.stopReason ? `stopped (${result.stopReason})` : "no reply"));
      await endUnanswered(`${bot.name} couldn't finish: ${detail.slice(0, 500)}`, detail, setupProblem(result, engineName));
    }
  } catch (error) {
    if (ranOn) seenBy().set(agentId, { run: ranOn, at: null });
    if (error instanceof BoxError && error.status === 409 && Date.now() - Date.parse(message.createdAt) < AWAY_GIVE_UP_MS) {
      // The computer is still ending a turn of this bot's that Gond lost (it restarted just now): try again shortly.
      again = true;
    } else {
      const detail = hide(error instanceof Error ? error.message : "unknown error");
      await endUnanswered(`${bot.name} hit a problem: ${detail.slice(0, 500)}`, detail, setupProblem(error, engineName));
    }
  } finally {
    writing?.close();
    parent?.removeEventListener("abort", follow);
    steers.shut();
    const free = await releaseComputer(thread.userId, thread.id, { botId: bot.id });
    if (free.length) void carryOn(thread.userId, free, DESKTOP_FREE_STEER, DESKTOP_FREE_PROMPT);
    activeTurns().delete(agentId);
    clearWork(thread.id, bot.id);
    activity(thread.id, bot.id, null);
    if (again) {
      noteInterrupted(message.id, done);
      releaseClaim(message.id);
    } else {
      markAnswered(message.id);
      if (message.kind === "prompt") lookTurnEnded(message.id, unanswered);
    }
    if (summaryRun && turnTiming()) console.log(timingLine(bot.name, `${summaryRun.engine}${summaryRun.model ? ` ${summaryRun.model}` : ""}`, clock.timing()));
  }
  if (again) return "";
  if (!reply) closeCallTurn(message.id, stopped ? "stopped" : unanswered ? "failed" : "quiet");
  await reportBack(bot, message, reply, stopped, broke);
  if (message.author === "routine") finishRoutineRun(message.id, Boolean(reply) || quiet);
  if (reply && bot.primary && message.author === "you" && thread.id === bot.threadId) offerCheckIns(thread.userId);
  if (quiet) dropMessage(message.id);
  if (reply && summaryRun) void summarizeThread({ box, bot, thread, bots, run: summaryRun, window: CONTEXT_LINES });
  return reply;
}

function reactedOnly(bot: Bot, message: Message): boolean {
  return message.author === "you" && reactionsOf(message.id).some((r) => r.author === bot.id);
}

const PEOPLE_AND_GOND = new Set(["you", "system", "routine"]);

type AnswerRoute = "person" | "teammate" | "chain";

/**
 * Where a turn's answer goes, the one decision both the prompt and the
 * delivery read: up a chain of handoffs (a brief, or a result inside one),
 * back to the teammate who wrote, or to the person, in this conversation. A
 * result coming back to the bot that handed the task out is the person's.
 */
export function answerGoesTo(message: Pick<Message, "id" | "threadId" | "author" | "fromThreadId" | "createdAt">): AnswerRoute {
  if (handoffWorkedOn(message.id)) return "chain";
  if (message.fromThreadId && !PEOPLE_AND_GOND.has(message.author) && !isDelegationResult(message.id) && !answersMyNote(message)) return "teammate";
  return "person";
}

/** A teammate's line back to a bot that wrote to it first, on the person's errand: what comes of it is the person's. */
function answersMyNote(message: Pick<Message, "threadId" | "fromThreadId" | "createdAt">): boolean {
  return Boolean(message.fromThreadId) && openedExchange(message.threadId, message.fromThreadId!, message.createdAt);
}

/**
 * A teammate's line back to a bot that asked it to act on the person's errand wakes that bot, or
 * reaches its turn there by steer, so one that said it would carry on once the others report does.
 * Its answer goes to the person, so the two can't bounce lines; null when it isn't such a report.
 */
export function reportTo(bot: Bot, fromThreadId: string, asker: Bot, body: string, depth: number): Message | null {
  if (depth > MAX_CHAIN || !awaitsReport(asker.threadId, fromThreadId, new Date().toISOString())) return null;
  const turn = [...activeTurns().values()].find((t) => t.botId === asker.id && t.threadId === asker.threadId);
  const message = postMessage({ threadId: asker.threadId, author: bot.id, body, depth, fromThreadId, note: "info", steered: Boolean(turn) });
  if (turn) {
    void turn
      .steer(`${bot.name}, whom you asked to act, reported back while you were working:\n\n${body}\n\nIf it's what you were waiting for, carry on with your part now. Your answer at the end covers it.`)
      .catch(() => false)
      .then((taken) => taken || unsteer(message.id));
  }
  return message;
}

/*
 * A reply to a teammate belongs to the exchange between the two bots, never
 * the person's chat with the one answering: it lands in the sender's
 * conversation (where it shows as "Message from …" and opens the exchange)
 * and wakes nobody but a bot that waits on it as a report (reportTo), so two
 * bots can't bounce replies forever. A handoff's
 * result goes up the chain from reportBack. Only a result coming back to the
 * bot that handed the task out is for the person.
 */
export function deliverReply(bot: Bot, thread: Thread, message: Message, reply: string) {
  const route = answerGoesTo(message);
  const handoff = route === "chain" ? handoffWorkedOn(message.id) : null;
  if (handoff) {
    if (openChildren(handoff.id) > 0) postMessage({ threadId: handoff.fromThreadId, author: bot.id, body: reply, depth: message.depth + 1, fromThreadId: thread.id, answered: true });
    return;
  }
  const sender = route === "teammate" && message.fromThreadId ? getThread(message.fromThreadId) : null;
  if (sender) {
    const asker = getBot(message.author);
    if (asker?.threadId === sender.id && reportTo(bot, thread.id, asker, reply, message.depth + 1)) return;
    postMessage({ threadId: sender.id, author: bot.id, body: reply, depth: message.depth + 1, fromThreadId: thread.id, answered: true, note: "info" });
    return;
  }
  postReply(bot, thread, message, reply);
}

/**
 * Whom a bot's line in a room wakes: the members it names, less those
 * answering the same message beside it, as in a group chat where everyone
 * asked is already on it.
 */
export function wokenBy(line: Pick<Message, "author" | "body">, thread: Thread, answering: Message | null, bots: Bot[]): Bot[] {
  const named = targetsFor(line, thread, bots).filter((b) => !b.hidden);
  if (!answering) return named;
  const alongside = new Set(answeringAlongside({ id: line.author }, thread, answering, bots).map((b) => b.id));
  return named.filter((b) => !alongside.has(b.id));
}

/** Who has written in the conversation since `message`. */
function spokeSince(threadId: string, message: Pick<Message, "createdAt">): Set<string> {
  return new Set(recentMessages(threadId, CONTEXT_LINES).filter((m) => m.createdAt > message.createdAt && m.kind === "message").map((m) => m.author));
}

function roomLineText(name: string, line: string, same = true): string {
  return `${name} just said in the room, ${same ? "answering the same message as you" : "while you were working"}:\n\n${line}\n\nRead it as you would in a group chat: don't repeat what ${name} covered or ask ${name} for it, and if it names you, that's about the part you're already answering, so cover it in your one answer. Don't answer this line on its own: if you already gave your answer, you're done, and never add ${QUIET_REPLY} to an answer.`;
}

function postReply(bot: Bot, thread: Thread, message: Message, reply: string) {
  if (thread.kind !== "room") {
    postMessage({ threadId: thread.id, author: bot.id, body: reply, depth: message.depth + 1, answered: true });
    return;
  }
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const woken = wokenBy({ author: bot.id, body: reply }, thread, message, bots);
  const room = woken.length > 0 && botLinesSincePerson(thread.id) < MAX_ROOM_LINES;
  postMessage({ threadId: thread.id, author: bot.id, body: reply, depth: woken.length ? message.depth : message.depth + 1, answered: !room, wake: room, answering: message.id });
  if (woken.length && !room) postMessage({ threadId: thread.id, author: "system", kind: "event", body: `The bots have said ${MAX_ROOM_LINES} things since you last wrote here, so the room waits for you. Write to carry on.`, answered: true });
  // Every other bot still answering the person here sees this line arrive, as in a group chat, whichever
  // of their messages it answers: so none asks for what was just said, and one it names covers it in the
  // answer it is writing (the dispatcher then skips the turn the mention would start, see `spokeSince`).
  for (const turn of activeTurns().values()) {
    if (turn.threadId === thread.id && turn.botId !== bot.id && turn.route === "person") void turn.steer(roomLineText(bot.name, reply, turn.messageId === message.id)).catch(() => false);
  }
}

export async function reportBack(bot: Bot, message: Message, reply: string, stopped: boolean, broke: string | null = null) {
  const delegation = handoffWorkedOn(message.id);
  if (!delegation) return;

  if (stopped) {
    closeStopped(delegation, bot.name);
    return;
  }

  if (openChildren(delegation.id) > 0) return;
  const home = getThread(delegation.fromThreadId);
  const posted = home
    ? postMessage({
        threadId: home.id,
        author: bot.id,
        body: reply ? `Result for the task you handed me:\n\n${reply}` : failedResult(bot.name, broke),
        depth: resultDepth(getMessage(delegation.messageId)?.depth ?? message.depth),
        fromThreadId: delegation.toThreadId,
      })
    : null;
  finishDelegation(delegation.id, reply ? "done" : "failed", reply || "(no result)", posted?.id ?? null);
}

function failedResult(name: string, broke: string | null): string {
  if (!broke) return "Result for the task you handed me:\n\n(I couldn't finish it; see my conversation for what went wrong.)";
  return `I couldn't finish the task you handed me: my run stopped with: ${broke.slice(0, 600)}\n\nWhat I did so far is in my conversation and my files. Decide: send ${name} a brief to carry on from there, or a corrected one, with delegate_bot; or tell the person plainly what only they can fix.`;
}

function closeStopped(delegation: Delegation, name: string) {
  finishDelegation(delegation.id, "cancelled", "Stopped by the person.");
  postMessage({ threadId: delegation.fromThreadId, author: "system", kind: "event", body: `${name} was stopped by the person, so the task handed to it is closed. Don't hand it out again unless they ask.`, answered: true });
}

async function raiseIncident(bot: Bot, thread: Thread, message: Message, detail: string) {
  const primary = getPrimary(thread.userId);
  if (!primary || primary.id === bot.id || message.depth >= MAX_CHAIN) return;
  if (!getThread(primary.threadId)) return;
  postMessage({
    threadId: primary.threadId,
    author: "system",
    body: `Incident: ${bot.name}'s run in "${thread.name}" stopped with: ${detail.slice(0, 600)}\n\nThe last request there was: "${message.body.slice(0, 400)}". Decide: send ${bot.name} a corrected brief with delegate_bot, or tell the person plainly what only they can fix. This report is from Gond, not the person.`,
    depth: message.depth + 1,
    fromThreadId: thread.id,
  });
}

export async function answerMessage(message: Message): Promise<void> {
  if (isUpdating() || computerAway()) {
    releaseClaim(message.id);
    return;
  }
  const thread = getThread(message.threadId);
  if (!thread) {
    markAnswered(message.id);
    return;
  }
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const before = roomBefore(thread, message);
  // A room's message answered again after a cut skips the bots that had already answered it.
  const answering = thread.kind === "room" && getBot(message.author) ? answeringOf(message.id) : null;
  // A bot's room line that names a member who has spoken here since already reached it, by steer while
  // it was working: waking it again would only repeat what it said.
  const answeredAlready = wasInterrupted(message.id) || answering ? spokeSince(thread.id, message) : new Set<string>();
  const named = answering ? wokenBy(message, thread, answering, bots) : targetsFor(message, thread, bots, before, workingIn(thread.id));
  const owed = named.filter((b) => !answeredAlready.has(b.id));
  if (answeredAlready.size && !owed.length) {
    markAnswered(message.id);
    return;
  }
  const targets = owed.filter((b) => !isBusy(b.id, thread.id));
  if (targets.length === 0) {
    const anyTarget = named;
    if (anyTarget.length === 0) {
      markAnswered(message.id);
      return;
    }

    releaseClaim(message.id);
    return;
  }
  let notStarted = false;
  await Promise.all(
    targets.map((bot) =>
      botTurn(bot, thread, message).catch((error: unknown) => {
        if (error instanceof TurnNotStarted) notStarted = true;
        else console.error(`[gond] ${bot.name} failed:`, error);
      }),
    ),
  );

  if (notStarted) releaseClaim(message.id);
}
