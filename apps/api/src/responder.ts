import { QUIET_REPLY, handleOf, isClosing, isQuietReply, isStopRequest, mentionsIn, plainMarkdown, replyLine, roomTargets, type Bot, type ChatAttachment, type DesktopDriver, type Message, type Thread, type ToolLabelContext } from "@gond/shared";
import { BoxError, boxConfig, boxHome, ensureBotHome, health, interruptAgent, steerAgent, writeBoxFile, type BoxConfig } from "./box.ts";
import { isUpdating } from "./updater.ts";
import { getAi } from "./data/ai.ts";
import { getBot, getPrimary, listBots } from "./data/bots.ts";
import { type Delegation, finishDelegation, handoffWorkedOn, isDelegationResult, openChildren, openDelegationsFrom, openDelegationsTo } from "./data/delegations.ts";
import { cancelFollowUpsIn } from "./data/follow-ups.ts";
import { finishRoutineRun } from "./data/routines.ts";
import { allSecretValues } from "./data/secrets.ts";
import { userTimezone } from "./data/prefs.ts";
import { listConnections } from "./data/settings.ts";
import { listSkills } from "./data/skills.ts";
import { botLinesSincePerson, closePending, closeSentFrom, dropMessage, getAttachment, getMessage, getThread, listThreads, markAnswered, postMessage, reactionsOf, recentMessages, releaseClaim, threadBusy, unsteer } from "./data/threads.ts";
import { computerTools, secretCommandTool } from "./computer.ts";
import { computerTool } from "./computer-tool.ts";
import { attachmentNote, deliverAttachments, type Delivered } from "./inbox.ts";
import { driversOf, forgetHandBack, handedBack, releaseComputer } from "./desktop.ts";
import { cliTurn } from "./driver.ts";
import { EngineSetupError, engineRun, type EngineRun } from "./engines.ts";
import { getSummary } from "./data/summaries.ts";
import { summarizeThread } from "./summaries.ts";
import { activity } from "./events.ts";
import { boxMcpServers, mcpServersFor } from "./mcp.ts";
import { nativeMcpTools } from "./mcp-client.ts";
import { nativeTurn, readsPdf, SteerQueue } from "./native.ts";
import { botHome, soulPath } from "./memory.ts";
import { sendPush } from "./push.ts";
import { createRedactor } from "./redact.ts";
import { skillsFor, skillsIndex, skillsReady } from "./skills.ts";
import { renderSoul, systemPromptFor } from "./souls.ts";
import { usableBot } from "./toolkits.ts";
import { clearWork, clipOutput, createTurnClock, labelStep, recordStep, timingLine, type StepUpdate } from "./work.ts";
import { boxPermission, endTurnOnExpiry } from "./approvals.ts";
import { noteInterrupted, takeInterrupted, wasInterrupted } from "./resume.ts";
import { turnTiming } from "./config.ts";
import { answerOnCall, closeCallTurn } from "./calls.ts";
import { appTools, baseTools, loadMemory, loadTeamMemory, MAX_CHAIN, MAX_ROOM_LINES, permissionTool, resultDepth, teamTools, TOOL_NOTES, transcript } from "./tools.ts";

const CONTEXT_LINES = 30;
const ROOM_LOOKBACK = 30;

const seenHolder = globalThis as typeof globalThis & { __gondSeen?: Map<string, string> };
/** Per agent, the last message its CLI session was given: the next turn sends only what is newer. */
export function seenBy(): Map<string, string> {
  return (seenHolder.__gondSeen ??= new Map());
}

const TURN_TIMEOUT_MS = 45 * 60 * 1000;

type Active = {
  botId: string;
  threadId: string;
  userId: string;
  messageId: string;
  // Where this turn's answer goes: the person is only ever steered into a turn that answers them.
  route: AnswerRoute;
  controller: AbortController;
  startedAt: number;

  steer: (text: string) => Promise<boolean>;
};
const holder = globalThis as typeof globalThis & { __gondActiveTurns?: Map<string, Active> };

export function activeTurns(): Map<string, Active> {
  return (holder.__gondActiveTurns ??= new Map());
}

export function agentIdFor(bot: Bot, thread: Thread) {
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

export class TurnNotStarted extends Error {}

// The computer went away (restarting, updating, down): the messages it cut off wait, and new ones
// aren't started until it answers, checked again this often; one waiting this long is given up on.
const AWAY_RETRY_MS = 15_000;
export const AWAY_GIVE_UP_MS = 30 * 60_000;
const away = globalThis as typeof globalThis & { __gondComputerAway?: number };

export function computerAway(): boolean {
  return Date.now() < (away.__gondComputerAway ?? 0);
}

async function computerAnswers(box: BoxConfig): Promise<boolean> {
  const answers = await health(box).then((h) => h.ok && !h.updating, () => false);
  if (!answers) away.__gondComputerAway = Date.now() + AWAY_RETRY_MS;
  return answers;
}

export async function interrupt(threadId: string) {
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
export type StopReport = { stopped: number; dropped: number; tasks: string[]; screen: boolean; teammates: string[]; sent: number; followUps: number };

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
  };
  if (options.quiet) quietStops.add(threadId);
  try {
    report.stopped = await interrupt(threadId);
    if (report.stopped) await settled(threadId);
  } finally {
    quietStops.delete(threadId);
  }
  report.dropped = closePending(threadId);
  await stopWorkFrom(threadId, null, new Set([threadId]), report);

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
  if (!lines.length) return "Nothing was running, so there was nothing to stop.";
  return ["Stopped.", lines.map((line) => `- ${line}`).join("\n"), "I won't pick it back up unless you ask."].join("\n\n");
}

/** Whether a stop in this conversation would halt anything. */
export function hasWork(threadId: string): boolean {
  return [...activeTurns().values()].some((turn) => turn.threadId === threadId) || openDelegationsFrom(threadId).length > 0 || threadBusy(threadId);
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
  for (const thread of listThreads({ userId })) {
    const one = await stopThread(thread.id);
    total.stopped += one.stopped;
    total.dropped += one.dropped;
  }
  return total;
}

export async function interruptMessage(messageId: string): Promise<boolean> {
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

export function steerText(body: string): string {
  return `The person sent this while you were working:\n\n${body}\n\nIf it changes what you're doing, adjust course; otherwise keep it in mind and carry on. Don't start over: this is part of the same piece of work, and your answer at the end covers it.`;
}

export function steerableTurns(thread: Thread, message: Pick<Message, "author" | "body">): Active[] {
  const targets = targetsFor(message, thread, listBots({ includeHidden: true, userId: thread.userId }), roomBefore(thread));
  const running = [...activeTurns().values()].filter((turn) => turn.threadId === thread.id);
  const turns = targets.map((bot) => running.find((turn) => turn.botId === bot.id));
  return targets.length && turns.every((turn) => turn?.route === "person") ? (turns as Active[]) : [];
}

export async function steer(turns: Active[], body: string): Promise<boolean> {
  const taken = await Promise.all(turns.map((turn) => turn.steer(steerText(body)).catch(() => false)));
  return taken.some(Boolean);
}

export async function postFromPerson(thread: Thread, input: { body: string; attachments?: ChatAttachment[]; after?: boolean; replyTo?: string | null }): Promise<Message> {
  if (!input.attachments?.length && !input.replyTo && isStopRequest(input.body) && hasWork(thread.id)) return stopFromMessage(thread, input.body);
  const turns = !input.after && !input.attachments?.length ? steerableTurns(thread, { author: "you", body: input.body }) : [];
  const message = postMessage({ threadId: thread.id, author: "you", body: input.body, attachments: input.attachments, steered: turns.length > 0, replyTo: input.replyTo });
  if (turns.length && !(await steer(turns, `${replyLine(message.replyTo, (author) => (author === "you" ? "you" : (getBot(author)?.name ?? author)))}${input.body}`))) unsteer(message.id);
  return getMessage(message.id) ?? message;
}

// "stop" in the chat is Stop: everything halts, nothing reads the message as
// a task, and the bot that was working says what it stopped.
export async function stopFromMessage(thread: Thread, body: string, options: { spoken?: boolean } = {}): Promise<Message> {
  const message = postMessage({ threadId: thread.id, author: "you", body, answered: true, spoken: options.spoken });
  const working = [...activeTurns().values()].find((turn) => turn.threadId === thread.id)?.botId;
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const author = working ?? targetsFor({ author: "you", body }, thread, bots, roomBefore(thread))[0]?.id;
  const report = await stopThread(thread.id, { quiet: true });
  if (author) postMessage({ threadId: thread.id, author, body: stoppedReply(report), answered: true });
  else postMessage({ threadId: thread.id, author: "system", kind: "event", body: "Stopped.", answered: true });
  return getMessage(message.id) ?? message;
}

/**
 * Who a message wakes. In a room the person is read like a group chat
 * (`roomTargets`: whom they name, else whom they were talking with); a bot's
 * line wakes only the teammates it @mentions, since bots name each other in
 * passing. `before` is the room's messages ahead of this one (`roomBefore`).
 */
export function targetsFor(message: Pick<Message, "author" | "body">, thread: Thread, bots: Bot[], before: Pick<Message, "author" | "kind" | "body">[] = []): Bot[] {
  const members = thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b) && !b!.hidden);
  if (thread.kind === "bot") return members.filter((b) => b.id !== message.author);
  if (message.author === "you") return roomTargets(message.body, members, before);
  const mentioned = mentionsIn(message.body);
  if (mentioned.includes("everyone") || mentioned.includes("all")) return members.filter((b) => b.id !== message.author);
  return members.filter((b) => mentioned.includes(handleOf(b.name)) && b.id !== message.author);
}

/** A room's recent messages ahead of `message` (all of them for one not posted yet), oldest first; nothing for a 1:1. */
export function roomBefore(thread: Thread, message?: Pick<Message, "id" | "createdAt">): Message[] {
  if (thread.kind !== "room") return [];
  const recent = recentMessages(thread.id, ROOM_LOOKBACK);
  return message ? recent.filter((m) => m.id !== message.id && m.createdAt <= message.createdAt) : recent;
}

export async function syncSoul(bot: Bot) {
  const box = boxConfig(bot.userId);
  if (!box) return;
  try {
    await ensureBotHome(box, bot.id);
    await writeBoxFile(box, soulPath(bot.id), renderSoul(bot));
  } catch (error) {
    console.warn(`[gond] could not write SOUL.md for ${bot.name}: ${error instanceof Error ? error.message : error}`);
  }
}

function textAttachments(message: Message): string {
  const parts: string[] = [];
  for (const meta of message.attachments) {
    if (!meta.mediaType.startsWith("text/") && meta.mediaType !== "application/json" && meta.mediaType !== "image/svg+xml") continue;
    const file = getAttachment(meta.id);
    if (!file) continue;
    const text = Buffer.from(file.data).toString("utf8").slice(0, 60_000);
    parts.push(`<attachment name="${meta.name}">\n${text}\n</attachment>`);
  }
  return parts.join("\n");
}

export type PromptOptions = {
  // The last message a resumed session already saw: only what is newer goes in.
  since?: string | null;
  // The conversation's running summary, for a prompt that starts from nothing.
  summary?: string | null;
};

const ROOM_TURN = `This is a room. If the last message isn't for you (another member's question, or an option from their message), answer exactly ${QUIET_REPLY}, and nothing is posted. Otherwise also read what the person asked the room since you last spoke here: if an earlier question was meant for everyone or for you and your part isn't answered yet, answer it too. When part of a question is another member's (by their job), @mention them in your answer with what to look at, so they answer too; never tell the person to ask them.`;

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
  const room = thread.kind === "room" ? `\n\n${ROOM_TURN}` : "";

  if (message.kind === "prompt") {
    return [earlier, `${heading}\n${history || (since ? "(nothing new)" : "(nothing yet)")}`, `Gond, not the person, asks you this; nobody else sees it. Do it, and address your answer to the person:\n${message.body}${toPerson}`].filter(Boolean).join("\n\n");
  }
  const sender = names.get(message.author) ?? "a teammate";
  const result = message.fromThreadId && !PEOPLE_AND_GOND.has(message.author) && isDelegationResult(message.id);
  const from = !message.fromThreadId || PEOPLE_AND_GOND.has(message.author)
    ? ""
    : result && route === "chain"
      ? `\n\nThis is ${sender}'s result for part of the task you were handed. Once every part is in, your answer is the result of your whole task: it goes back to whoever handed it to you, not to ${sender} and not to the person.`
      : result
        ? `\n\nThis is the result of the task you handed ${sender}. Your answer goes to the person, in this chat: tell them what came of it. Don't thank or address ${sender}; to tell ${sender} anything, use message_bot.`
        : `\n\nThis message came from ${sender}. Do the work it asks for and answer with the result; your answer goes back to them, not to the person. If it brings something the person should hear (a result, a change, a question for them), tell them with post_message, which posts in your chat with them, then answer ${sender} in a line.`;
  return [
    earlier,
    `${heading}\n${history}`,
    files,
    `Now answer the last message, which is from ${who}.${from}${toPerson}${room}\n${message.author === "routine" ? "This is a scheduled routine: do the job and report, addressing the person." : ""}`,
    message.author === "you" && isClosing(message.body) ? `It reads as the person closing the exchange (a thanks, an "I will", a goodbye). Unless it answers a question you asked, react to it with the react tool (👍 or ❤️) and answer with exactly ${QUIET_REPLY}, so nothing more is posted.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function botTurn(bot: Bot, thread: Thread, message: Message, parent?: AbortSignal): Promise<string> {
  const box = boxConfig(thread.userId);
  if (!box) {
    postMessage({ threadId: thread.id, author: "system", kind: "event", body: "No box is running, so no bot can work. Start the box container and set GOND_BOX_URL.", answered: true });
    if (message.author === "routine") finishRoutineRun(message.id, false);
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
  const context = { box, bot, thread, message, askBot, syncSoul, stopWork: interruptMessage, isWorking: isBusy, signal: controller.signal };
  let reply = "";
  let quiet = false;
  let stopped = false;
  let summaryRun: EngineRun | null = null;

  let broke: string | null = null;
  // Cut off by the computer (an update, or it went away), not by anything wrong with the work: the
  // message goes back to wait and is answered again once the computer is back.
  let again = false;

  let failed = false;

  const endUnanswered = async (failure: string, detail: string, setupError: boolean) => {
    failed = true;
    const cause = stopCauseOf(controller.signal);
    stopped = cause === "stopped";
    if (cause === "updating" || (!cause && box && !(await computerAnswers(box)))) {
      if (Date.now() - Date.parse(message.createdAt) < AWAY_GIVE_UP_MS) {
        again = true;
        return;
      }
      postMessage({ threadId: thread.id, author: "system", kind: "event", body: `The computer didn't come back in time, so ${bot.name} couldn't answer. Send it again once it's up.`, answered: true });
      return;
    }
    const ending = unansweredEnding(bot.name, cause, failure, setupError);
    if (ending.event && !(cause === "stopped" && quietStops.has(thread.id))) postMessage({ threadId: thread.id, author: "system", kind: "event", body: ending.event, answered: true });
    if (!ending.incident) return;
    if (handoffWorkedOn(message.id)) broke = detail;
    else await raiseIncident(bot, thread, message, detail);
  };

  const secrets = allSecretValues();
  const hide = createRedactor(secrets);

  const scrub = createRedactor(secrets, Infinity);

  const ownerHome = boxHome(thread.userId);
  const labels: ToolLabelContext = { home: ownerHome ? `${ownerHome}/${botHome(bot.id)}` : null, servers: mcpServersFor(bot).map((server) => ({ name: server.name })) };

  const clock = createTurnClock();
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
    await syncSoul(bot);
    const [memory, teamMemory] = await Promise.all([loadMemory(box, bot.id), loadTeamMemory(box, bot.userId)]);
    const skills = listSkills(bot.userId);
    await skillsReady(bot.userId);

    const usable = usableBot(bot);
    const mcpServers = boxMcpServers(usable);

    const ai = getAi(thread.userId);
    const run = engineRun(ai, thread.userId);

    active.steer = run.native ? async (text) => steers.push(text) : async (text) => (await steerAgent(box, agentId, text).catch(() => ({ steered: false }))).steered;

    const nativeMcp = run.native ? await nativeMcpTools({ bot: usable, thread, signal: controller.signal }) : null;
    const tools = {
      ...(nativeMcp?.tools ?? {}),
      ...baseTools(context),
      ...teamTools(context),
      ...(await appTools(context)),
      ...(run.native ? computerTools(context) : { permission: permissionTool(context) }),
      ...computerTool(context),
      ...secretCommandTool(context),
    };
    const instructions = systemPromptFor(usable, {
      bots,
      thread,
      memory: memory.text,
      memoryTruncated: memory.truncated,
      teamMemory,
      connections: listConnections(bot.userId),
      toolNotes: TOOL_NOTES,
      timezone: userTimezone(thread.userId),
      skillsIndex: skillsIndex(skills),
      skills: skillsFor(message.body, skills),

      mcpServers: nativeMcp?.servers ?? mcpServersFor(usable).map((m) => ({ name: m.name, note: m.authStatus === "needed" ? `not attached yet: it waits for the person to sign in, from its card or Settings → Apps → MCP servers → ${m.name} → Sign in, and its tools arrive on your next reply after that` : m.authStatus === "error" ? `sign-in problem (${m.authError ?? "unknown"}); its tools may fail` : undefined })),
    });

    const delivered = message.attachments.length ? await deliverAttachments(box, bot, message, controller.signal, { pdf: !run.native || readsPdf(run.native) }) : { files: [], inline: [] };
    controller.signal.throwIfAborted();
    const resumeNote = resumed ? `\n\n${resumed}` : "";
    const prompt = promptFor(bot, thread, message, bots, delivered.files, { summary: getSummary(thread.id)?.summary }) + resumeNote;
    const since = run.native ? null : (seenBy().get(agentId) ?? null);
    const followUp = since ? promptFor(bot, thread, message, bots, delivered.files, { since }) + resumeNote : undefined;
    summaryRun = run;
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
    });
    if (result.ok) seenBy().set(agentId, message.createdAt);
    else seenBy().delete(agentId);
    if (result.ok && message.author === "routine" && isQuietReply(result.text)) {
      quiet = true;
    } else if (result.ok && reactedOnly(bot, message, result.text)) {
      // The reaction was the whole answer, as a thumbs up is between people.
    } else if (result.ok && isQuietReply(result.text) && active.route === "person") {
      // Nothing for the person (in a room, often a line meant for another bot): nothing is posted.
    } else if (result.ok && result.text.trim()) {
      reply = scrub(result.text.trim());
      if (!answerOnCall(message.id, reply)) {
        deliverReply(bot, thread, message, reply);

        if (bot.notify && (message.author === "you" || message.author === "routine")) {
          void sendPush({ title: bot.name, body: plainMarkdown(reply).slice(0, 140), url: `/app/t/${thread.id}`, tag: thread.id, threadId: thread.id }, thread.userId);
        }
      }
    } else {
      const detail = hide(result.error ?? (result.stopReason ? `stopped (${result.stopReason})` : "no reply"));
      await endUnanswered(`${bot.name} couldn't finish: ${detail.slice(0, 500)}`, detail, false);
    }
  } catch (error) {
    seenBy().delete(agentId);
    if (error instanceof BoxError && error.status === 409 && Date.now() - Date.parse(message.createdAt) < AWAY_GIVE_UP_MS) {
      // The computer is still ending a turn of this bot's that Gond lost (it restarted just now): try again shortly.
      again = true;
    } else {
      const detail = hide(error instanceof Error ? error.message : "unknown error");
      await endUnanswered(`${bot.name} hit a problem: ${detail.slice(0, 500)}`, detail, error instanceof EngineSetupError);
    }
  } finally {
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
    } else markAnswered(message.id);
    if (summaryRun && turnTiming()) console.log(timingLine(bot.name, `${summaryRun.engine}${summaryRun.model ? ` ${summaryRun.model}` : ""}`, clock.timing()));
  }
  if (again) return "";
  if (!reply) closeCallTurn(message.id, stopped ? "stopped" : failed ? "failed" : "quiet");
  await reportBack(bot, message, reply, stopped, broke);
  if (message.author === "routine") finishRoutineRun(message.id, Boolean(reply) || quiet);
  if (quiet) dropMessage(message.id);
  if (reply && summaryRun) void summarizeThread({ box, bot, thread, bots, run: summaryRun, window: CONTEXT_LINES });
  return reply;
}

function reactedOnly(bot: Bot, message: Message, text: string): boolean {
  return message.author === "you" && (!text.trim() || isQuietReply(text)) && reactionsOf(message.id).some((r) => r.author === bot.id);
}

const PEOPLE_AND_GOND = new Set(["you", "system", "routine"]);

export type AnswerRoute = "person" | "teammate" | "chain";

/**
 * Where a turn's answer goes, the one decision both the prompt and the
 * delivery read: up a chain of handoffs (a brief, or a result inside one),
 * back to the teammate who wrote, or to the person, in this conversation. A
 * result coming back to the bot that handed the task out is the person's.
 */
export function answerGoesTo(message: Pick<Message, "id" | "author" | "fromThreadId">): AnswerRoute {
  if (handoffWorkedOn(message.id)) return "chain";
  if (message.fromThreadId && !PEOPLE_AND_GOND.has(message.author) && !isDelegationResult(message.id)) return "teammate";
  return "person";
}

/*
 * A reply to a teammate belongs to the exchange between the two bots, never
 * the person's chat with the one answering: it lands in the sender's
 * conversation (where it shows as "Message from …" and opens the exchange)
 * and wakes nobody, so two bots can't bounce replies forever. A handoff's
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
    postMessage({ threadId: sender.id, author: bot.id, body: reply, depth: message.depth + 1, fromThreadId: thread.id, answered: true });
    return;
  }
  postReply(bot, thread, message, reply);
}

function postReply(bot: Bot, thread: Thread, message: Message, reply: string) {
  const mentioned = thread.kind === "room" ? mentionsIn(reply) : [];
  const members = thread.kind === "room" ? thread.members.filter((id) => id !== bot.id) : [];
  const names = mentioned.includes("everyone") || mentioned.includes("all");
  const wakes = members.some((id) => {
    const member = getBot(id);
    return member && !member.hidden && (names || mentioned.includes(handleOf(member.name)));
  });
  if (!wakes) {
    postMessage({ threadId: thread.id, author: bot.id, body: reply, depth: message.depth + 1, answered: true });
    return;
  }
  const room = botLinesSincePerson(thread.id) < MAX_ROOM_LINES;
  postMessage({ threadId: thread.id, author: bot.id, body: reply, depth: message.depth, answered: !room, wake: room });
  if (!room) postMessage({ threadId: thread.id, author: "system", kind: "event", body: `The bots have said ${MAX_ROOM_LINES} things since you last wrote here, so the room waits for you. Write to carry on.`, answered: true });
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

export function failedResult(name: string, broke: string | null): string {
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
  const answeredAlready = wasInterrupted(message.id) ? new Set(recentMessages(thread.id, CONTEXT_LINES).filter((m) => m.createdAt > message.createdAt && m.kind === "message").map((m) => m.author)) : new Set<string>();
  const owed = targetsFor(message, thread, bots, before).filter((b) => !answeredAlready.has(b.id));
  if (answeredAlready.size && !owed.length) {
    markAnswered(message.id);
    return;
  }
  const targets = owed.filter((b) => !isBusy(b.id, thread.id));
  if (targets.length === 0) {
    const anyTarget = targetsFor(message, thread, bots, before);
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

export function botById(id: string) {
  return getBot(id);
}

export type { BoxConfig };
