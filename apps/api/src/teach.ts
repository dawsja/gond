import { handleOf, type Bot, type TeachDraft, type Teaching, type TeachStep, type Thread } from "@gond/shared";
import { BoxError, boxConfig, changeRecording, desktopControl, discardRecording, followRecording, recordingFrame, recordingStatus, startRecording, type BoxRecording, type BoxRecordingEvent } from "./box.ts";
import { getBot } from "./data/bots.ts";
import { createSkill } from "./data/skills.ts";
import {
  deleteTeaching,
  deleteTeachingFrames,
  deleteTeachingsOf,
  getTeaching,
  openTeaching,
  promptDone,
  saveTeachingFrame,
  teachingAskedBy,
  teachingById,
  teachingFrame,
  teachingsIn,
  unfinishedTeachings,
  updateTeaching,
  createTeaching,
} from "./data/teachings.ts";
import { getThread, postMessage, storeAttachment } from "./data/threads.ts";
import { emitDesktop, tookControl } from "./desktop.ts";
import { skillsChanged } from "./events.ts";
import { now } from "./ids.ts";
import { tellHandedBack } from "./responder.ts";
import { syncSkills } from "./skills.ts";

/** Something about "Show me how" the person can't do right now, in words they can act on. */
export class TeachError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// The pictures a bot is shown of a recording: the key moments, as few as tell the story.
const LOOK_FRAMES = 16;
const SAVE_EVERY_MS = 350;
// While the computer is away (an update takes minutes), a recording waits for it rather than losing its pictures.
const FOLLOW_RETRIES = 90;
const FINISH_RETRIES = 24;
const FINISH_RETRY_MS = 5_000;

type Followers = { follow: Map<string, AbortController>; saves: Map<string, ReturnType<typeof setTimeout>>; steps: Map<string, Map<number, TeachStep>>; finishing: Set<string>; retries: Map<string, number> };
const holder = globalThis as typeof globalThis & { __gondTeach?: Followers };
const state = (): Followers => (holder.__gondTeach ??= { follow: new Map(), saves: new Map(), steps: new Map(), finishing: new Set(), retries: new Map() });

const unreachable = (error: unknown) => error instanceof BoxError && (error.status === 0 || error.status === 502 || error.status === 503);

const boxOf = (userId: string) => {
  const box = boxConfig(userId);
  if (!box) throw new TeachError("Gond isn't connected to its computer, so it can't record. Whoever runs this Gond can fix it.", 503);
  return box;
};

function startFailure(error: unknown): TeachError {
  if (error instanceof TeachError) return error;
  if (error instanceof BoxError) {
    if (error.code === "screens_full") return new TeachError("All three of your screens are in use. Close one, then tap Start again.", 429);
    if (error.code === "recording_busy") return new TeachError("Someone is already showing this bot something.", 409);
    if (error.status === 503) return new TeachError("The computer is updating. Try again in a minute.", 503);
    if (error.status === 0) return new TeachError("Can't reach the computer right now. Try again in a minute.", 502);
  }
  return new TeachError("Couldn't start recording. Try again in a moment.", 502);
}

/** A bot offers to be shown how, with a card the person starts it from. */
export function offerTeaching(bot: Bot, thread: Thread): string {
  const id = createTeaching({ userId: bot.userId, botId: bot.id, threadId: thread.id, status: "offered" });
  postCard(id, bot, thread.id);
  return id;
}

function postCard(id: string, bot: Bot, threadId: string) {
  const card = postMessage({ threadId, author: bot.id, kind: "teach", body: `Show ${bot.name} how`, approvalId: id, answered: true });
  updateTeaching(id, { messageId: card.id });
}

/**
 * Starts recording: from an offered card, or from a bot's screen (which posts the card in the
 * bot's own conversation first, so the chat says what happened). The screen is the person's
 * while it records, so no bot's batch lands in the middle of what they show.
 */
export async function startTeaching(userId: string, input: { teachingId: string } | { botId: string }): Promise<Teaching> {
  const box = boxOf(userId);
  let id: string;
  let bot: Bot | null;
  if ("teachingId" in input) {
    const found = teachingById(input.teachingId);
    if (!found || found.userId !== userId) throw new TeachError("Couldn't find that recording", 404);
    if (found.status === "recording" || found.status === "paused") return getTeaching(found.id, userId)!;
    if (found.status !== "offered") throw new TeachError(found.endedWhy === "expired" ? "This card expired. Ask again to show it how." : "This one is already done.", 409);
    id = found.id;
    bot = getBot(found.botId);
  } else {
    bot = getBot(input.botId);
    if (!bot || bot.userId !== userId) throw new TeachError("Couldn't find that bot", 404);
    const thread = getThread(bot.threadId);
    if (!thread) throw new TeachError("Couldn't find that bot's conversation", 404);
    const open = openTeaching(userId);
    if (open) throw busy(open);
    // Its card is posted once the computer is recording, so a start that fails leaves nothing behind.
    id = createTeaching({ userId, botId: bot.id, threadId: thread.id, status: "offered" });
  }
  const fromScreen = !("teachingId" in input);
  if (!bot) throw new TeachError("Couldn't find that bot", 404);
  const open = openTeaching(userId);
  if (open && open.id !== id) throw busy(open);

  let recording: BoxRecording;
  try {
    recording = await startRecording(box, bot.id, { width: 1280, height: 800, primary: bot.primary, name: bot.name, color: bot.color, id, replace: true });
  } catch (error) {
    if (fromScreen) deleteTeaching(id);
    throw startFailure(error);
  }
  try {
    await desktopControl(box, bot.id, { holder: "person" });
  } catch (error) {
    // Recording a screen the person doesn't hold would mix in a bot's clicks: it goes, and Start can be tried again.
    await discardRecording(box, bot.id, id).catch(() => undefined);
    if (fromScreen) deleteTeaching(id);
    throw startFailure(error);
  }
  if (fromScreen) postCard(id, bot, bot.threadId);
  tookControl(userId, bot.id);
  void emitDesktop(userId);
  updateTeaching(id, { status: "recording", startedAt: now(), steps: recording.steps, activeMs: recording.activeMs }, { from: ["offered"] });
  const teaching = teachingById(id)!;
  postMessage({ threadId: teaching.threadId, author: bot.id, body: "Go ahead, I'm watching.", answered: true });
  follow(id);
  return getTeaching(id, userId)!;
}

function busy(open: Teaching): TeachError {
  const name = getBot(open.botId)?.name ?? "a bot";
  return new TeachError(open.status === "looking" ? `${name} is still looking at what you showed it. Try again in a moment.` : `You're already showing ${name} something. Finish or discard that first.`, 409);
}

/** Hears the box's steps for a recording until it ends, picking the stream up again if it drops. */
function follow(id: string): void {
  const { follow: followers } = state();
  if (followers.has(id)) return;
  const controller = new AbortController();
  followers.set(id, controller);
  void (async () => {
    let tries = 0;
    while (!controller.signal.aborted) {
      const teaching = teachingById(id);
      if (!teaching || (teaching.status !== "recording" && teaching.status !== "paused")) return;
      const box = boxConfig(teaching.userId);
      if (!box) return;
      try {
        for await (const event of followRecording(box, teaching.botId, id, controller.signal)) {
          tries = 0;
          if (await heard(id, event)) return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof BoxError && error.status === 404) {
          await finishTeaching(id, "lost");
          return;
        }
      }
      tries += 1;
      if (tries > FOLLOW_RETRIES) {
        await finishTeaching(id, "lost");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  })().finally(() => {
    if (followers.get(id) === controller) followers.delete(id);
  });
}

function stepsOf(id: string): Map<number, TeachStep> {
  const { steps } = state();
  let known = steps.get(id);
  if (!known) steps.set(id, (known = new Map((teachingById(id)?.steps ?? []).map((step) => [step.n, step]))));
  return known;
}

function saveSoon(id: string) {
  const { saves } = state();
  if (saves.has(id)) return;
  saves.set(
    id,
    setTimeout(() => {
      saves.delete(id);
      flushSteps(id);
    }, SAVE_EVERY_MS),
  );
}

function flushSteps(id: string) {
  const known = state().steps.get(id);
  if (!known) return;
  updateTeaching(id, { steps: [...known.values()].sort((a, b) => a.n - b.n) });
}

/** One event from the box; true once the recording has ended and been finished. */
async function heard(id: string, event: BoxRecordingEvent): Promise<boolean> {
  if (event.type === "snapshot") {
    const known = stepsOf(id);
    for (const step of event.recording.steps) known.set(step.n, step);
    updateTeaching(id, { steps: [...known.values()].sort((a, b) => a.n - b.n), activeMs: event.recording.activeMs, full: event.recording.full });
    if (event.recording.ended) {
      await finishTeaching(id, event.recording.ended);
      return true;
    }
    return false;
  }
  if (event.type === "step") {
    stepsOf(id).set(event.step.n, event.step);
    saveSoon(id);
    return false;
  }
  if (event.type === "status") {
    if (event.ended) {
      await finishTeaching(id, event.ended);
      return true;
    }
    updateTeaching(id, { status: event.paused ? "paused" : "recording", pausedFor: event.paused ? event.pausedFor : null, activeMs: event.activeMs, full: event.full }, { from: ["recording", "paused"] });
  }
  return false;
}

export async function pauseTeaching(userId: string, id: string, pause: boolean): Promise<Teaching> {
  const teaching = getTeaching(id, userId);
  if (!teaching) throw new TeachError("Couldn't find that recording", 404);
  if (teaching.status !== "recording" && teaching.status !== "paused") throw new TeachError("That recording has ended.", 409);
  try {
    const status = await changeRecording(boxOf(userId), teaching.botId, id, pause ? "pause" : "resume");
    updateTeaching(id, { status: status.paused ? "paused" : "recording", pausedFor: status.paused ? (status.pausedFor ?? "person") : null, activeMs: status.activeMs });
  } catch (error) {
    if (error instanceof BoxError && error.status === 404) {
      await finishTeaching(id, "lost");
      throw new TeachError("The recording stopped on the computer. What it caught is in the card.", 409);
    }
    throw new TeachError(pause ? "Couldn't pause. Try again." : "Couldn't resume. Try again.", 502);
  }
  return getTeaching(id, userId)!;
}

/**
 * Ends a recording and takes what it caught: the steps and the screenshots come into Gond, the
 * computer's copy goes, and the screen goes back to the bots. Anything typed outside the browser
 * waits for the person to hide what's private (review) before the bot sees it.
 */
export async function finishTeaching(id: string, why: string): Promise<void> {
  const { finishing, follow: followers, saves } = state();
  if (finishing.has(id)) return;
  finishing.add(id);
  try {
    const teaching = teachingById(id);
    if (!teaching || (teaching.status !== "recording" && teaching.status !== "paused")) return;
    followers.get(id)?.abort();
    const pending = saves.get(id);
    if (pending) clearTimeout(pending);
    saves.delete(id);
    const box = boxConfig(teaching.userId);
    let recording: BoxRecording | null = null;
    if (box) {
      let away = false;
      recording = await changeRecording(box, teaching.botId, id, "finish").catch(() =>
        recordingStatus(box, teaching.botId, id).catch((error: unknown) => {
          away = unreachable(error);
          return null;
        }),
      );
      // The computer is restarting or updating: its copy has the pictures, so come back for them.
      const tries = state().retries.get(id) ?? 0;
      if (!recording && away && tries < FINISH_RETRIES) {
        state().retries.set(id, tries + 1);
        setTimeout(() => void finishTeaching(id, why), FINISH_RETRY_MS);
        return;
      }
      state().retries.delete(id);
      if (recording?.ended === "restart") why = "restart";
      for (const frame of recording?.frames ?? []) {
        const data = await recordingFrame(box, teaching.botId, id, frame.n).catch(() => null);
        if (data) saveTeachingFrame(id, { n: frame.n, step: frame.step, width: frame.width, height: frame.height, data });
      }
      await discardRecording(box, teaching.botId, id).catch(() => undefined);
      await giveScreenBack(teaching.userId, teaching.botId);
    }
    const known = state().steps.get(id);
    state().steps.delete(id);
    const steps = recording?.steps?.length ? recording.steps : known ? [...known.values()].sort((a, b) => a.n - b.n) : teaching.steps;
    const shown = steps.filter((step) => !teaching.steps.find((s) => s.n === step.n)?.skipped);
    const base = { steps, activeMs: recording?.activeMs ?? teaching.activeMs, endedAt: now(), endedWhy: why, pausedFor: null, full: recording?.full ?? teaching.full };
    if (!shown.length) {
      updateTeaching(id, { ...base, status: "discarded", endedWhy: "empty" });
      return;
    }
    const outside = steps.some((step) => step.outside);
    updateTeaching(id, { ...base, status: outside ? "review" : "looking" });
    if (!outside) beginLooking(id);
  } finally {
    finishing.delete(id);
  }
}

async function giveScreenBack(userId: string, botId: string) {
  const box = boxConfig(userId);
  if (!box) return;
  await desktopControl(box, botId, { holder: "free" }).catch(() => undefined);
  void tellHandedBack(userId, botId);
  void emitDesktop(userId);
}

/** Drops a recording, wherever it is, and what it caught. */
export async function discardTeaching(id: string, why = "discarded"): Promise<void> {
  const teaching = teachingById(id);
  if (!teaching || teaching.status === "saved" || teaching.status === "discarded" || teaching.status === "failed") return;
  state().follow.get(id)?.abort();
  state().steps.delete(id);
  const box = boxConfig(teaching.userId);
  if (box) {
    // Whatever stage it reached, the computer's copy goes too (one left by a restart included).
    await discardRecording(box, teaching.botId, id).catch(() => undefined);
    if (teaching.status === "recording" || teaching.status === "paused") await giveScreenBack(teaching.userId, teaching.botId);
  }
  deleteTeachingFrames(id);
  updateTeaching(id, { status: "discarded", endedWhy: why, endedAt: now(), pausedFor: null });
}

/** The person hid what they typed outside the browser and let the bot look. */
export function lookAfterReview(userId: string, id: string, hidden: number[]): Teaching {
  const teaching = getTeaching(id, userId);
  if (!teaching) throw new TeachError("Couldn't find that recording", 404);
  if (teaching.status !== "review") throw new TeachError("That one has moved on already.", 409);
  const outside = new Set(teaching.steps.filter((step) => step.outside).map((step) => step.n));
  updateTeaching(id, { hidden: hidden.filter((n) => outside.has(n)), status: "looking" }, { quiet: true });
  beginLooking(id);
  return getTeaching(id, userId)!;
}

/** The pictures worth showing a bot: the first, each new page or window, and an even spread of the rest. */
export function keyframes(steps: Pick<TeachStep, "n" | "frame" | "kind" | "skipped" | "hidden">[], max = LOOK_FRAMES): { frame: number; step: number }[] {
  const all = steps.filter((step) => step.frame && !step.skipped && !step.hidden).map((step) => ({ frame: step.frame!, step: step.n, key: step.kind === "navigate" || step.kind === "tab_open" }));
  const unique = all.filter((item, index) => all.findIndex((other) => other.frame === item.frame) === index);
  if (unique.length <= max) return unique.map(({ frame, step }) => ({ frame, step }));
  const chosen = new Set<number>([0, unique.length - 1]);
  for (const [index, item] of unique.entries()) if (item.key && chosen.size < max) chosen.add(index);
  // The rest go one at a time into the middle of the widest gap left, so they spread evenly.
  while (chosen.size < max) {
    const sorted = [...chosen].sort((a, b) => a - b);
    let widest = 0;
    for (let i = 1; i < sorted.length; i += 1) if (sorted[i]! - sorted[i - 1]! > sorted[widest + 1]! - sorted[widest]!) widest = i - 1;
    const middle = Math.floor((sorted[widest]! + sorted[widest + 1]!) / 2);
    if (chosen.has(middle)) break;
    chosen.add(middle);
  }
  return [...chosen].sort((a, b) => a - b).map((index) => ({ frame: unique[index]!.frame, step: unique[index]!.step }));
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** The steps as a bot reads them: skipped ones marked, hidden ones left out, notes in their place. */
function stepLines(teaching: Pick<Teaching, "steps" | "notes">): string {
  const lines: string[] = [];
  for (const step of teaching.steps) {
    if (step.hidden) {
      lines.push(`${step.n}. (${clock(step.at)}) Typed something private${step.app ? ` in ${step.app}` : ""} (hidden by the person)`);
    } else {
      lines.push(`${step.n}. (${clock(step.at)}) ${step.label}${step.url ? ` [${step.url}]` : ""}${step.skipped ? " (skipped: a wrong turn, leave it out)" : ""}`);
    }
    for (const note of teaching.notes.filter((n) => n.after === step.n)) lines.push(`   Note from the person: "${note.text}"`);
  }
  for (const note of teaching.notes.filter((n) => n.after === 0)) lines.unshift(`Note from the person, before they started: "${note.text}"`);
  return lines.join("\n");
}

function lookPrompt(teaching: Pick<Teaching, "id" | "steps" | "notes" | "endedWhy">, pictures: number): string {
  const ended = teaching.endedWhy === "limit" ? " It stopped at the ten-minute limit, so it may not show the very end." : teaching.endedWhy === "away" ? " It ended when they left, so it may not show the very end." : teaching.endedWhy === "lost" || teaching.endedWhy === "restart" ? " The computer lost the end of it, so it may stop short." : "";
  return [
    `The person just showed you how to do something on your screen, so you can do it for them from now on.${ended} Below is every step they took, in order, with any notes they added.${pictures === 1 ? " A screenshot of the key moment is attached, named step-N.jpg after the step it follows." : pictures ? ` ${pictures} screenshots of the key moments are attached, named step-N.jpg after the step they follow.` : ""} A password or sign-in code shows only as the kind it was, never the value.`,
    "Work out the task: what it is for, the steps that matter (leave out detours and anything marked skipped), what changes each time it runs (a date, a name, a search), and what it needs from the person (a saved sign-in for a site, a file). Don't do anything on the screen now.",
    `Then call propose_skill once with teaching "${teaching.id}": a short name, one sentence on what it does and when to use it, the steps in plain words (each with the step number whose screenshot shows it best), what changes, what it needs, and the full instructions for the skill: how to do it with your browser and computer tools step by step, what to check on the way, and to ask with ask_approval before anything that pays, sends, submits an order or deletes. If a step needs a sign-in, say to use request_login for that site.`,
    "After that, if one thing about the task is unclear, ask the person about it in one line with ::choices. Otherwise say in one line that the card is ready, and nothing more: the card shows the steps.",
    `Steps:\n${stepLines(teaching)}`,
  ].join("\n\n");
}

/** Posts the hidden prompt that has the bot look at a recording, with its key moments as pictures. */
function beginLooking(id: string, note?: string): void {
  const teaching = teachingById(id);
  if (!teaching) return;
  const bot = getBot(teaching.botId);
  const thread = getThread(teaching.threadId);
  if (!bot || !thread) return;
  const pictures = note
    ? []
    : keyframes(teaching.steps).flatMap(({ frame, step }) => {
        const found = teachingFrame(id, frame);
        return found ? [storeAttachment({ name: `step-${step}.jpg`, mediaType: "image/jpeg", data: found.data })] : [];
      });
  const body = note
    ? `The person says your draft for what they showed you isn't right yet: "${note}"\n\nThe screenshots from before are in your inbox. Call propose_skill again with teaching "${id}", changed to fit, then say in one line what you changed.\n\nSteps:\n${stepLines(teaching)}`
    : lookPrompt(teaching, pictures.length);
  const prompt = postMessage({ threadId: thread.id, author: "system", kind: "prompt", body: thread.kind === "room" ? `@${handleOf(bot.name)} ${body}` : body, attachments: pictures });
  updateTeaching(id, { status: "looking", promptId: prompt.id, error: null });
}

/** A turn asked to look at a recording ended: if it left no draft, the card gets the steps as shown, so nothing is lost. */
export function lookTurnEnded(messageId: string, failure: string | null = null): void {
  const id = teachingAskedBy(messageId);
  if (!id) return;
  const teaching = teachingById(id);
  if (!teaching || teaching.status !== "looking") return;
  const name = getBot(teaching.botId)?.name ?? "The bot";
  updateTeaching(id, {
    status: "ready",
    draft: teaching.draft ?? draftFromSteps(teaching),
    error: failure ? `${name} couldn't look at it (${failure.slice(0, 200)}), so these are the steps as you did them.` : `${name} didn't write it up, so these are the steps as you did them.`,
  });
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** A draft made from the steps themselves, for when the bot couldn't write one. */
function draftFromSteps(teaching: Pick<Teaching, "steps" | "notes">): TeachDraft {
  const kept = teaching.steps.filter((step) => !step.skipped && !step.hidden);
  const site = kept.map((step) => hostOf(step.url)).find(Boolean);
  return {
    name: site ? `What I was shown on ${site}` : "What I was shown",
    description: "Steps recorded with Show me how.",
    steps: kept.slice(0, 40).map((step) => ({ text: step.label, shows: step.frame ? step.n : null })),
    changes: [],
    needs: [],
    instructions: `Do these steps with the browser and computer tools, in order. Ask with ask_approval before anything that pays, sends, submits an order or deletes.\n\n${stepLines({ ...teaching, steps: kept })}`,
  };
}

const LIMITS = { name: 60, description: 300, step: 300, steps: 40, items: 10, item: 200, instructions: 20_000 };

/** A draft from a bot's tool call, cut to what the card and a skill can hold; null when it can't be one. */
export function cleanDraft(input: Record<string, unknown>, stepCount: number): TeachDraft | string {
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const name = text(input.name, LIMITS.name);
  const instructions = typeof input.instructions === "string" ? input.instructions.trim().slice(0, LIMITS.instructions) : "";
  if (!name) return "name is required: a short name for the task.";
  if (!instructions) return "instructions are required: how to do the task, step by step.";
  const list = (value: unknown) => (Array.isArray(value) ? value.map((item) => text(item, LIMITS.item)).filter(Boolean).slice(0, LIMITS.items) : []);
  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .map((item) => {
      const raw = typeof item === "string" ? { text: item } : (item as Record<string, unknown>);
      const shows = Number(raw?.shows);
      return { text: text(raw?.text, LIMITS.step), shows: Number.isInteger(shows) && shows >= 1 && shows <= stepCount ? shows : null };
    })
    .filter((step) => step.text)
    .slice(0, LIMITS.steps);
  if (!steps.length) return "steps are required: the task in plain words, one item per step.";
  return { name, description: text(input.description, LIMITS.description), steps, changes: list(input.changes), needs: list(input.needs), instructions };
}

/** The bot's draft of what it was shown, on the card. */
export function proposeDraft(bot: Bot, input: Record<string, unknown>): string {
  const id = typeof input.teaching === "string" ? input.teaching : "";
  const teaching = teachingById(id);
  if (!teaching || teaching.botId !== bot.id) return "NOT posted: no recording of yours by that id.";
  if (teaching.status !== "looking" && teaching.status !== "ready") return `NOT posted: that recording is ${teaching.status}.`;
  const draft = cleanDraft(input, teaching.steps.length);
  if (typeof draft === "string") return `NOT posted: ${draft}`;
  updateTeaching(id, { draft, previous: teaching.draft ?? teaching.previous, status: "ready", error: null });
  return "The card now shows your draft, with Try it now, Save as skill and Not right. Don't repeat the steps in your reply.";
}

export function editDraft(userId: string, id: string, input: Record<string, unknown>): Teaching {
  const teaching = getTeaching(id, userId);
  if (!teaching) throw new TeachError("Couldn't find that recording", 404);
  if (teaching.status !== "ready") throw new TeachError("That one can't be changed now.", 409);
  const draft = cleanDraft(input, teaching.steps.length);
  if (typeof draft === "string") throw new TeachError("Give it a name, at least one step and its instructions.", 400);
  updateTeaching(id, { draft, previous: teaching.draft });
  return getTeaching(id, userId)!;
}

export async function saveTeaching(userId: string, id: string): Promise<Teaching> {
  const teaching = getTeaching(id, userId);
  if (!teaching) throw new TeachError("Couldn't find that recording", 404);
  if (teaching.status === "saved") return teaching;
  if (teaching.status !== "ready" || !teaching.draft) throw new TeachError("There's nothing to save yet.", 409);
  const skill = createSkill(userId, { name: teaching.draft.name, description: teaching.draft.description, instructions: teaching.draft.instructions }, "bot");
  updateTeaching(id, { status: "saved", skillId: skill.id });
  skillsChanged(userId);
  void syncSkills(userId);
  const bot = getBot(teaching.botId);
  const thread = getThread(teaching.threadId);
  if (bot && thread) {
    const body = `The person saved what they showed you as the skill /${skill.slug}. Offer once, in one line with ::choices, to do it on a schedule that fits the task (like "On the 1st of each month" or "Every Monday", and "Not now"), and make a routine with that skill if they pick one.`;
    postMessage({ threadId: thread.id, author: "system", kind: "prompt", body: thread.kind === "room" ? `@${handleOf(bot.name)} ${body}` : body });
  }
  return getTeaching(id, userId)!;
}

/** Has the bot do the task now, from its draft, with the person watching. */
export function tryTeaching(userId: string, id: string): Teaching {
  const teaching = getTeaching(id, userId);
  if (!teaching?.draft) throw new TeachError("Couldn't find that draft", 404);
  if (teaching.status !== "ready") throw new TeachError("That one can't be tried now.", 409);
  const bot = getBot(teaching.botId);
  const thread = getThread(teaching.threadId);
  if (!bot || !thread) throw new TeachError("Couldn't find that bot", 404);
  const body = `Do "${teaching.draft.name}" now, as a practice the person watches: follow the draft's steps with your browser and computer tools.\n\n${teaching.draft.instructions}\n\nStop before anything that pays, sends, submits an order or deletes, and ask with ask_approval first, whatever your approval level. Afterwards say in a few lines how it went and what differed from what they showed you; if the draft needs a change, call propose_skill again with teaching "${id}".`;
  postMessage({ threadId: thread.id, author: "system", kind: "prompt", body: thread.kind === "room" ? `@${handleOf(bot.name)} ${body}` : body });
  return teaching;
}

export function reviseTeaching(userId: string, id: string, note: string): Teaching {
  const teaching = getTeaching(id, userId);
  if (!teaching) throw new TeachError("Couldn't find that recording", 404);
  if (teaching.status !== "ready") throw new TeachError("That one can't be changed now.", 409);
  const said = note.trim().slice(0, 1000);
  if (!said) throw new TeachError("Say what isn't right, so it can fix it.", 400);
  beginLooking(id, said);
  return getTeaching(id, userId)!;
}

export function skipStep(userId: string, id: string, n: number, skip: boolean): Teaching {
  const teaching = getTeaching(id, userId);
  if (!teaching) throw new TeachError("Couldn't find that recording", 404);
  if (!["recording", "paused", "review"].includes(teaching.status)) throw new TeachError("Steps can only be skipped before the bot looks.", 409);
  const skipped = new Set(teaching.steps.filter((step) => step.skipped).map((step) => step.n));
  if (skip) skipped.add(n);
  else skipped.delete(n);
  updateTeaching(id, { skipped: [...skipped] });
  return getTeaching(id, userId)!;
}

export function addNote(userId: string, id: string, text: string): Teaching {
  const teaching = getTeaching(id, userId);
  if (!teaching) throw new TeachError("Couldn't find that recording", 404);
  if (teaching.status !== "recording" && teaching.status !== "paused") throw new TeachError("Notes go in while you're showing it.", 409);
  const said = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!said) throw new TeachError("Write or say the note first.", 400);
  const after = stepsOf(id).size ? Math.max(...stepsOf(id).keys()) : 0;
  updateTeaching(id, { notes: [...teaching.notes, { after, text: said, at: teaching.activeMs }] });
  return getTeaching(id, userId)!;
}

/** Stop in a conversation drops what is being shown there; how many it dropped. */
export async function stopTeachingsIn(threadId: string): Promise<number> {
  const open = teachingsIn(threadId, ["offered", "recording", "paused", "review", "looking"]);
  for (const teaching of open) await discardTeaching(teaching.id, "stopped");
  return open.filter((teaching) => teaching.status !== "offered").length;
}

/** Whether something is being shown in a conversation, for "stop" to stop. */
export function teachingIn(threadId: string): boolean {
  return teachingsIn(threadId, ["recording", "paused"]).length > 0;
}

export async function forgetBotTeachings(botId: string, userId: string): Promise<void> {
  const open = openTeaching(userId);
  if (open?.botId === botId) await discardTeaching(open.id, "removed");
  deleteTeachingsOf({ botId });
}

/**
 * At start: a recording the box still makes is followed again, one it ended (or lost) is finished
 * with what it kept, and a bot's look whose turn already ended gets the steps as shown.
 */
export async function resumeTeachings(): Promise<void> {
  for (const teaching of unfinishedTeachings()) {
    if (teaching.status === "recording" || teaching.status === "paused") {
      const box = boxConfig(teaching.userId);
      const status = box ? await recordingStatus(box, teaching.botId, teaching.id).catch(() => null) : null;
      if (status && !status.ended) follow(teaching.id);
      else await finishTeaching(teaching.id, status?.ended ?? "restart");
    } else if (teaching.status === "looking" && teaching.promptId) {
      if (promptDone(teaching.promptId)) lookTurnEnded(teaching.promptId);
    }
  }
}

