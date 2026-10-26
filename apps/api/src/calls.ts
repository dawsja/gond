import { CALL_MAX_MINUTES, isStopRequest, plainMarkdown, type Bot, type CallEvent, type CallInfo, type Message, type Thread, type VoiceProvider } from "@gond/shared";
import { getBot } from "./data/bots.ts";
import { providerBaseUrl, providerKey } from "./data/providers.ts";
import { getThread, listMessages, postMessage, recentMessages } from "./data/threads.ts";
import { getUser } from "./data/users.ts";
import { getVoice } from "./data/voice.ts";
import { subscribe } from "./events.ts";
import { newId, now } from "./ids.ts";
import { hasWork, stopFromMessage } from "./responder.ts";
import { acknowledge, openVoiceLink, type VoiceLink, type VoiceSignal } from "./voice-link.ts";

// A pause this long ends what one side was saying, and it goes into the chat.
const SETTLE_MS = 1_400;
// A page that stops listening (a reload, a lost connection) ends the call after this.
const ORPHAN_MS = 10_000;
const PROGRESS_EVERY_MS = 5_000;
const HISTORY_LINES = 12;
const GOODBYE_WAIT_MS = 6_000;
const GOODBYE_TAIL_MS = 800;
const SAID_BYE = /\b(bye|goodbye|take care|talk soon|see you|have a good)\b/i;

type Listener = (event: CallEvent) => void;

type Call = {
  info: CallInfo;
  userId: string;
  bot: Bot;
  link: VoiceLink;
  ready: boolean;
  ended: boolean;
  listeners: Set<Listener>;
  heard: string;
  said: string;
  heardTimer: ReturnType<typeof setTimeout> | null;
  saidTimer: ReturnType<typeof setTimeout> | null;
  // What the person said since the voice last handed something over: the request, for GPT-Live.
  asked: string[];
  // The open hand-overs, by the hidden prompt each became.
  handed: Map<string, string>;
  lastProgress: { line: string; at: number } | null;
  work: { line: string; since: number } | null;
  cardsAfter: string;
  orphan: ReturnType<typeof setTimeout> | null;
  // Set once the person has said goodbye: the call ends after the voice's own goodbye.
  closing: ReturnType<typeof setTimeout> | null;
  // The voice's last settled line, so a goodbye it already said isn't waited for again.
  lastSaid: { text: string; at: number } | null;
  limit: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
};

const holder = globalThis as typeof globalThis & { __gondCalls?: Map<string, Call> };
function calls(): Map<string, Call> {
  return (holder.__gondCalls ??= new Map());
}

export function callOf(userId: string): CallInfo | null {
  return [...calls().values()].find((call) => call.userId === userId && !call.ended)?.info ?? null;
}

export function ownCall(userId: string, id: string): CallInfo | null {
  const call = calls().get(id);
  return call && call.userId === userId && !call.ended ? call.info : null;
}

/** Fragments of speech, joined: two sentences said apart still read as two ("Hang on. I'm looking"). */
export function joinSpeech(sofar: string, next: string): string {
  return /[.!?]$/.test(sofar) && /^[^\s.,!?]/.test(next) ? `${sofar} ${next}` : sofar + next;
}

/** How a call reads in the chat once it's over. */
export function callLength(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "under a minute" : minutes === 1 ? "1 min" : `${minutes} min`;
}

const CLOSERS = String.raw`that'?s all|that'?s it|that is all|that'?s everything|i'?m done|we'?re done|all done|bye|bye bye|goodbye|good bye|see you|see ya|later|talk (?:to you )?(?:later|soon)|have a good (?:one|day|night|evening)|hang up|end (?:the |this )?call`;
const LEADERS = String.raw`ok|okay|alright|all right|cool|great|perfect|awesome|sounds good|got it|thanks|thank you|thanks so much|thank you so much|perfect thanks|okay thanks|ok thanks|please`;

/** A line that only closes the call ("that's all", "ok thanks, bye", "bye Patch"), never one that asks for more. */
export function endsCall(text: string, botName = ""): boolean {
  const words = text.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!words || words.length > 80) return false;
  const name = botName.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim();
  const trailers = [String.raw`for now|then|thanks|thank you|bye|goodbye|now|please|again`, name].filter(Boolean).join("|");
  return new RegExp(`^(?:(?:${LEADERS}) )*(?:${CLOSERS})(?: (?:${CLOSERS}|${trailers}))*$`).test(words);
}

export function voiceInstructions(bot: Bot, person: string): string {
  const job = bot.title || bot.description ? ` (${[bot.title, bot.description].filter(Boolean).join(": ").slice(0, 300)})` : "";
  return [
    `You are the voice of ${bot.name}${job}, on a call with ${person}. You only talk. ${bot.name}'s real work (its memory, files, tools, the computer, connected apps) happens when you hand a request over.`,
    "Hand over anything past small talk: any question that needs facts, memory or a look-up, and any task. Never guess, and never make up an answer.",
    "While the work runs, say once, in a few words, that you're on it, then keep the conversation natural. If asked how it's going, use what you know of its progress.",
    "When an answer comes back, say it plainly and briefly, in your own words, keeping names, numbers and codes exact. Never say something is done, sent, booked or bought unless an answer says so.",
    "A decision shows on the person's screen as a card. Tell them to tap it; nothing is approved by voice.",
    "When the person is done (they say bye, that's all, they're done), say a short goodbye and nothing else; the call hangs up after it.",
    "Speak in short, natural sentences. No lists, markdown or links.",
  ].join("\n");
}

function greetingFor(bot: Bot): string {
  return `Pick up the call as ${bot.name}: one short, friendly line, in the language of the chat so far (English if there is none), then listen.`;
}

/** The hidden prompt a hand-over becomes: the bot's own turn, whose answer goes back to the voice. */
export function callPrompt(request: string): string {
  const said = request.trim() ? `"${request.trim().slice(0, 2000)}"` : "(what they just said is at the end of the chat above)";
  return [
    `The person is on a voice call with you. Your voice, a separate model that only talks, heard this from them and handed it to you to do:\n\n${said}`,
    "Do it as you would if they'd typed it; their spoken lines are in the chat above. Your answer goes back to your voice, which tells them in its own words, so answer the way you'd say it: the facts and where things stand in two to four short sentences, with no markdown, tables, lists or links, and names, numbers and codes exact.",
    "Don't post in the chat (no post_message) unless they ask you to put something there; when something is better read than heard (a link, a command, a long list), say so and offer to post it. A decision goes on a card as always, and your answer says it's on their screen. Never say something is done unless it is.",
  ].join("\n\n");
}

function historyOf(thread: Thread, bot: Bot): string {
  const lines = recentMessages(thread.id, HISTORY_LINES)
    .filter((m) => m.kind === "message" && !m.fromThreadId && (m.author === "you" || m.author === bot.id))
    .map((m) => `${m.author === "you" ? "Person" : bot.name}: ${plainMarkdown(m.body).slice(0, 400)}`)
    .filter((line) => !line.endsWith(": "));
  return lines.length ? `The chat with ${bot.name} before this call (newest last), for context:\n${lines.join("\n")}` : "";
}

function emitTo(call: Call, event: CallEvent) {
  for (const listener of [...call.listeners]) listener(event);
}

export type StartCall = { ok: true; call: CallInfo } | { ok: false; status: 400 | 409; error: string };

/** Only the primary bot takes calls: it is the one that knows the team and hands work on to the rest. */
export function callableBot(thread: Thread): Bot | null {
  const bot = thread.kind === "bot" && thread.botId ? getBot(thread.botId) : null;
  return bot?.primary ? bot : null;
}

export function startCall(thread: Thread, userId: string): StartCall {
  const bot = callableBot(thread);
  if (!bot) return { ok: false, status: 400, error: "You can only call your primary bot, from its own chat." };
  const voiceSettings = getVoice(userId);
  const provider = voiceSettings.using;
  const baseUrl = provider ? providerBaseUrl(userId, provider) : null;
  const key = provider ? providerKey(userId, provider) : null;
  if (!provider || !baseUrl || !key) return { ok: false, status: 409, error: "A call needs an xAI or OpenAI key. Add one in Settings → AI." };

  const previous = callOf(userId);
  if (previous) endCall(previous.id, null);

  const info: CallInfo = { id: newId("call"), threadId: thread.id, botId: bot.id, provider, startedAt: now() };
  const person = getUser(userId)?.name?.split(/\s+/)[0] || "the person";
  const call: Call = {
    info,
    userId,
    bot,
    link: null as unknown as VoiceLink,
    ready: false,
    ended: false,
    listeners: new Set(),
    heard: "",
    said: "",
    heardTimer: null,
    saidTimer: null,
    asked: [],
    handed: new Map(),
    lastProgress: null,
    work: null,
    cardsAfter: info.startedAt,
    orphan: null,
    closing: null,
    lastSaid: null,
    limit: setTimeout(() => endCall(info.id, `Calls end after ${CALL_MAX_MINUTES} minutes.`), CALL_MAX_MINUTES * 60_000),
    unsubscribe: () => {},
  };
  calls().set(info.id, call);
  call.unsubscribe = subscribe((event) => {
    if (event.topic === "activity" && event.threadId === thread.id && event.botId === bot.id) workChanged(call, event.line);
    if (event.topic === "thread" && event.threadId === thread.id) announceCards(call);
  });
  call.link = openVoiceLink(provider, {
    baseUrl,
    key,
    instructions: voiceInstructions(bot, person),
    history: historyOf(thread, bot),
    greeting: greetingFor(bot),
    botName: bot.name,
    voice: voiceSettings.callVoice[provider],
    on: (signal) => onSignal(call, provider, signal),
  });
  call.orphan = setTimeout(() => endCall(info.id, null), ORPHAN_MS);
  return { ok: true, call: info };
}

function onSignal(call: Call, provider: VoiceProvider, signal: VoiceSignal) {
  if (call.ended) return;
  switch (signal.kind) {
    case "ready":
      if (call.ready) return;
      call.ready = true;
      emitTo(call, { type: "ready" });
      return;
    case "audio":
      emitTo(call, { type: "audio", data: signal.data });
      return;
    case "interrupt":
      emitTo(call, { type: "interrupt" });
      return;
    case "heard":
      if (call.said) settleSaid(call);
      call.heard = joinSpeech(call.heard, signal.text);
      if (call.heardTimer) clearTimeout(call.heardTimer);
      if (signal.final) settleHeard(call);
      else call.heardTimer = setTimeout(() => settleHeard(call), SETTLE_MS);
      return;
    case "said":
      if (call.heard) settleHeard(call);
      call.said = joinSpeech(call.said, signal.text);
      if (call.saidTimer) clearTimeout(call.saidTimer);
      call.saidTimer = setTimeout(() => settleSaid(call), SETTLE_MS);
      return;
    case "said-end":
      settleSaid(call);
      return;
    case "delegate":
      settleHeard(call);
      handOver(call, provider, signal.id, signal.request);
      return;
    case "status":
      call.link.status(signal.id, statusLine(call));
      return;
    case "hang-up":
      wrapUp(call);
      return;
    case "error":
      if (!call.ready) endCall(call.info.id, `${provider === "openai" ? "OpenAI" : "xAI"} didn't take the call: ${signal.message}`);
      else console.warn(`[gond] call ${call.info.id}: ${signal.message}`);
      return;
    case "closed":
      endCall(call.info.id, call.ready ? null : `The call couldn't start${signal.reason ? `: ${signal.reason}` : "."}`);
      return;
  }
}

function settleHeard(call: Call) {
  if (call.heardTimer) clearTimeout(call.heardTimer);
  call.heardTimer = null;
  // Full duplex: the voice can answer before the person finishes, and the rest of their line starts at a stop.
  const text = call.heard.replace(/\s+/g, " ").trim().replace(/^[.,!?\s]+/, "");
  call.heard = "";
  if (!text) return;
  const thread = getThread(call.info.threadId);
  if (!thread) return;
  if (endsCall(text, call.bot.name)) {
    postMessage({ threadId: thread.id, author: "you", body: text, answered: true, spoken: true });
    wrapUp(call);
    return;
  }
  if (isStopRequest(text) && hasWork(thread.id)) {
    void stopFromMessage(thread, text, { spoken: true }).then(() => call.link.tell(`The person said stop, so everything ${call.bot.name} was doing has stopped. Say so in a few words.`));
  } else {
    postMessage({ threadId: thread.id, author: "you", body: text, answered: true, spoken: true });
    call.asked.push(text);
  }
}

function settleSaid(call: Call) {
  if (call.saidTimer) clearTimeout(call.saidTimer);
  call.saidTimer = null;
  const text = call.said.replace(/\s+/g, " ").trim().replace(/^[.,!?\s]+/, "");
  call.said = "";
  if (!text) return;
  postMessage({ threadId: call.info.threadId, author: call.bot.id, body: text, answered: true, spoken: true });
  call.lastSaid = { text, at: Date.now() };
  if (call.closing) {
    clearTimeout(call.closing);
    call.closing = setTimeout(() => endCall(call.info.id, null), GOODBYE_TAIL_MS);
  }
}

/** The person said goodbye: give the voice a moment to say its own, then hang up. */
function wrapUp(call: Call) {
  if (call.closing) return;
  const saidBye = call.lastSaid && Date.now() - call.lastSaid.at < GOODBYE_WAIT_MS && SAID_BYE.test(call.lastSaid.text);
  call.closing = setTimeout(() => endCall(call.info.id, null), saidBye && !call.said ? GOODBYE_TAIL_MS : GOODBYE_WAIT_MS);
}

function handOver(call: Call, provider: VoiceProvider, id: string, request: string | null) {
  const asked = request ?? call.asked.join(" ");
  call.asked = [];
  const prompt = postMessage({ threadId: call.info.threadId, author: "system", kind: "prompt", body: callPrompt(asked) });
  call.handed.set(prompt.id, id);
  acknowledge(call.link, provider, id, call.bot.name);
}

/** A turn answering a hand-over speaks its answer, so nothing streams into the chat for it. */
export function handedOnCall(messageId: string): boolean {
  return callHanding(messageId) !== null;
}

function callHanding(messageId: string): { call: Call; id: string } | null {
  for (const call of calls().values()) {
    const id = call.handed.get(messageId);
    if (id) return { call, id };
  }
  return null;
}

/**
 * A turn that answers a request handed over on a call gives its answer to the voice instead of the
 * chat. False when no call is waiting for it any more (it ended), so the answer is posted as usual.
 */
export function answerOnCall(messageId: string, reply: string): boolean {
  const handing = callHanding(messageId);
  if (!handing || handing.call.ended) return false;
  handing.call.handed.delete(messageId);
  handing.call.link.result(handing.id, plainMarkdown(reply) || reply);
  return true;
}

/** A hand-over whose turn ended with nothing for the voice to say still gets an answer, so it never waits on it. */
export function closeCallTurn(messageId: string, ending: "stopped" | "failed" | "quiet") {
  const handing = callHanding(messageId);
  if (!handing) return;
  handing.call.handed.delete(messageId);
  if (handing.call.ended) return;
  const name = handing.call.bot.name;
  handing.call.link.result(handing.id, ending === "stopped" ? "That was stopped." : ending === "quiet" ? `${name} has nothing to add on that.` : `${name} couldn't finish that. What went wrong is in the chat.`);
}

function statusLine(call: Call): string {
  if (!call.work) return call.handed.size ? `${call.bot.name} is about to start on it.` : `${call.bot.name} isn't working on anything right now.`;
  const seconds = Math.round((Date.now() - call.work.since) / 1000);
  return `${call.bot.name} is working, for ${seconds < 60 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`} so far. Right now: ${call.work.line}`;
}

function workChanged(call: Call, line: string | null) {
  call.work = line ? { line, since: call.work?.since ?? Date.now() } : null;
  if (!line || call.handed.size === 0) return;
  const last = call.lastProgress;
  if (last && (last.line === line || Date.now() - last.at < PROGRESS_EVERY_MS)) return;
  call.lastProgress = { line, at: Date.now() };
  const id = [...call.handed.values()].at(-1)!;
  call.link.progress(id, `Progress, not finished yet: ${line}`);
}

const CARD_KINDS = new Set<Message["kind"]>(["approval", "secret", "signin", "teach", "control"]);

function announceCards(call: Call) {
  if (call.ended) return;
  const fresh = listMessages(call.info.threadId, { after: call.cardsAfter, limit: 50 });
  if (!fresh.length) return;
  call.cardsAfter = fresh.at(-1)!.createdAt;
  for (const card of fresh.filter((m) => CARD_KINDS.has(m.kind) && m.author === call.bot.id)) {
    const what = plainMarkdown(card.body).slice(0, 160);
    call.link.tell(`A card just came up on the person's screen from ${call.bot.name}${what ? `: "${what}"` : ""}. Tell them it's there and to tap it to answer; you can't answer it by voice.`);
  }
}

export function listen(id: string, listener: Listener): () => void {
  const call = calls().get(id);
  if (!call || call.ended) {
    listener({ type: "ended", reason: null });
    return () => {};
  }
  call.listeners.add(listener);
  if (call.orphan) clearTimeout(call.orphan);
  call.orphan = null;
  if (call.ready) listener({ type: "ready" });
  return () => {
    call.listeners.delete(listener);
    if (!call.ended && call.listeners.size === 0) call.orphan = setTimeout(() => endCall(id, null), ORPHAN_MS);
  };
}

export function sendAudio(id: string, audio: Uint8Array) {
  const call = calls().get(id);
  if (call && !call.ended && call.ready && audio.length) call.link.sendAudio(Buffer.from(audio).toString("base64"));
}

export function muteCall(id: string, muted: boolean) {
  const call = calls().get(id);
  if (call && !call.ended) call.link.mute(muted);
}

export function endCall(id: string, reason: string | null) {
  const call = calls().get(id);
  if (!call || call.ended) return;
  settleHeard(call);
  settleSaid(call);
  call.ended = true;
  clearTimeout(call.limit);
  if (call.closing) clearTimeout(call.closing);
  if (call.orphan) clearTimeout(call.orphan);
  call.unsubscribe();
  call.link.close();
  // One line per call, once it's over: while it runs, the header and the composer say so.
  if (call.ready) postMessage({ threadId: call.info.threadId, author: "system", kind: "event", body: `Call · ${callLength(Date.now() - Date.parse(call.info.startedAt))}`, answered: true });
  emitTo(call, { type: "ended", reason });
  call.listeners.clear();
  calls().delete(id);
}

/** Ends a person's call, as deleting them or stopping everything does. */
export function endCallsOf(userId: string) {
  for (const call of [...calls().values()]) if (call.userId === userId) endCall(call.info.id, null);
}
