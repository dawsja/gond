import { AVATAR_MAX_BYTES, IMAGE_ASPECTS, IMAGE_MODELS, MAX_IMAGE_REFERENCES, isImageAspect, ROOM_MAX_BOTS, draftIdOf, emailDraftOf, emailName, sendDraftAction, QUIET_REPLY, REACTIONS, isReaction, BOT_COLORS, BOT_EXPRESSIONS, BOT_SHAPES, LOGIN_FIELD_KINDS, MAX_SENT_FILE_BYTES, SKILL_LIMITS, botInputSchema, composioCard, handleOf, joinCommandLine, mentionsIn, mediaTypeFor, mcpServerInputSchema, hasKeyHeader, pickBotName, plainMarkdown, skillFilePath, type Bot, type BotExpression, type BotShape, type McpServer, type McpServerInput, type Message, type SkillInput, type Thread } from "@gond/shared";
import { askApproval, ENGINE_FILES_TEXT, expiredText, requestApproval, SCRIPTED_SCREEN_TEXT, scriptsTheScreen, summarize, touchesEngine } from "./approvals.ts";
import { boxHome, previewBoxImage, readBoxFileBytes, uploadBoxFile, writeBoxFile, type BoxConfig } from "./box.ts";
import { exactApp, searchIndex } from "./catalog.ts";
import { catalogIndex, composioConfigured, executeAction, isReadOnlyAction, toolsFor, type ComposioTool } from "./composio.ts";
import { clearBotAvatar, createBot, findBot, getBot, listBots, setBotAvatar, updateBot } from "./data/bots.ts";
import { pictureType } from "./images.ts";
import { emit } from "./events.ts";
import { createImage, imageAccess, keepPreview, type ImageReference } from "./pictures.ts";
import { sendPush } from "./push.ts";
import { createDelegation, finishDelegation, getDelegation, handoffWorkedOn, listDelegationsForBot, openChildren, type Delegation } from "./data/delegations.ts";
import { cancelFollowUp, createFollowUp, listFollowUps } from "./data/follow-ups.ts";
import { createMcpServer, getMcpServer, listMcpServers, markMcpRefreshed, updateMcpServer } from "./data/mcp.ts";
import { allSecretValues, containsSecret, hasSecret, hideSecrets, listSecrets, readLogin, secretHider } from "./data/secrets.ts";
import { userTimezone } from "./data/prefs.ts";
import { listConnections } from "./data/settings.ts";
import { createSkill, getSkill, getSkillBySlug, listSkills, skillFiles, updateSkill } from "./data/skills.ts";
import { createRoutine, deleteRoutine, listRoutines, previewRuns, recordRoutineRun, routinePrompt, updateRoutine } from "./data/routines.ts";
import { botLinesSincePerson, createRoom, listMessages, markAnswered, postMessage, recentMessages, searchMessages, setReaction, storeAttachment, threadRefs } from "./data/threads.ts";
import { clipToolResult as clip, type DriverTool } from "./driver.ts";
import { holdLogin, loginFields, loginPrefix, rememberable } from "./logins.ts";
import { checkMcpHeaders, secretNamesIn } from "./mcp.ts";
import { probeMcpServer } from "./mcp-oauth.ts";
import { botHome, kb, memoryPath, MAX_MEMORY_BYTES, MAX_TEAM_MEMORY_BYTES, NEARLY_FULL, teamDir, teamMemoryPath } from "./memory.ts";
import { requestSecret } from "./secret-requests.ts";
import { looksExecutable, nameFromFolder, parseSkillMd, type BundleFile } from "./skill-bundle.ts";
import { readSkillFromBox, skillBrief, skillsReady, syncSkills } from "./skills.ts";


export const MAX_CHAIN = 4;

export function resultDepth(briefDepth: number): number {
  return Math.max(0, briefDepth - 1);
}

export const MAX_ROOM_LINES = 20;

export function roomOpener(text: string, invited: Bot[]): string {
  const named = new Set(mentionsIn(text));
  const missing = invited.filter((b) => !named.has(handleOf(b.name)));
  return missing.length ? `${missing.map((b) => `@${handleOf(b.name)}`).join(" ")} ${text}` : text;
}

const MAX_FOLLOW_UPS = 10;

const MAX_FOLLOW_UP_MINUTES = 7 * 24 * 60;

const HANDOFF_WINDOW_MS = 24 * 60 * 60 * 1000;

export function ago(at: string, from = Date.now()): string {
  const minutes = Math.max(0, Math.round((from - Date.parse(at)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function oneLineOf(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function snippetAround(text: string, query: string, width = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.max(0, [query, ...query.split(/\s+/)].map((part) => (part ? lower.indexOf(part.toLowerCase()) : -1)).find((index) => index >= 0) ?? 0);
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + width).trim()}${start + width < flat.length ? "…" : ""}`;
}

export function plainText(value: string): string {
  return value
    .replace(/&(lt|gt|quot|apos|#39|#x27|nbsp);/gi, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", nbsp: " " })[name.toLowerCase()] ?? "")
    .replace(/&amp;/gi, "&");
}

const SIGNIN_CARD_FRESH_MS = 30 * 60_000;

export const TOOL_NOTES = [
  "set_profile changes your own name, job title, how you work (your SOUL), mascot colour, expression or shape, or your picture. When the person tells you who you are or what you do from now on, update your instructions (the description field; the app calls it Instructions) so your SOUL.md carries it. Use it too when the person gives you a lasting new job. Which bot is their primary one is set in the app, not here.",
  `memory_update replaces MEMORY.md, the notes that load into every turn, up to ${kb(MAX_MEMORY_BYTES)} (its heading says how full it is). Keep it to stable preferences, how the person works and what you learned; detail goes in memory/<topic>.md. You can also edit it, and memory/<topic>.md, with your own file tools; they live in your home folder.`,
  "send_file hands the person a file from the computer as a download in this conversation (a document, an HTML page, an image, a spreadsheet, up to 100 MB). When the person asks for a file, or a teammate made one for them, send it; don't only say where it is on the computer. To show them the screen (a cart before they buy, a confirmation, or whenever they ask to see it), call send_screenshot; never save a screenshot to a file.",
  "create_image makes a picture with the person's own image model and posts it here: a drawing, poster, logo, illustration or photo-like scene, or a change to a picture they sent or you made (from, by path). Write the prompt as a brief to an illustrator: subject, style, colours, composition and any words on it. Use it whenever they ask for a picture; never draw one by writing code or with the screen. The person watches it being made and sees it, so your reply is a line at most, never a description of it. A profile picture (a pfp, an avatar, a new look) for you or a teammate is a square create_image, then picture: its images/… path on set_profile or update_bot; it shows in a circle, so keep the subject centred with room around it. picture: none puts the mascot back.",
  "Your reply is what you write after your last tool call. Make your calls first (handoffs included), then write the whole answer; don't end a turn on a tool call with the answer half written before it.",
  `react puts an emoji on the person's message you are answering, as a person taps one in a chat: 👍 or ❤️ when they thank you, agree or close ("thanks!", "perfect", "that will be all"), the others when they fit. When the reaction says it all, react and answer with exactly ${QUIET_REPLY}: nothing more is posted and nobody is notified. Otherwise react and reply as usual. Most messages need no reaction.`,
  "post_message adds a line to the conversation you are in before your final answer, e.g. to say what you are starting on. Your final answer is posted for you; don't repeat it. Both only ever reach the person: a teammate hears from you through message_bot, ask_bot or delegate_bot, or through your final answer when its own message woke you.",
  "list_bots shows the team with each bot's id, job and whether it is busy.",
  "message_bot sends a teammate a note and returns at once; its answer comes back to your conversation as a message, without starting another turn of yours, and never shows in the person's chat with it. Use it to hand something over without waiting; use ask_bot when you need the answer now. In a room, a member is told in the room: an @mention in your answer, or message_bot, which says it there for everyone to see; never a private note.",
  "delegate_bot hands a teammate a self-contained brief (outcome, sources, constraints, deliverable, review point) in its own conversation and returns immediately. The result comes back to you here as a new message from that teammate; report it to the person then, not before. When you hand on part of a task that was handed to you, it stays open: the results come back to you, and your reply once the last of them is in is what goes back to whoever handed it to you, so don't relay results with message_bot.",
  "list_handoffs is the truth about what you handed out: check it before you tell anyone what is in flight or done, and before you plan the next round. When the plan changes under a brief that is out, amend_handoff replaces it and cancel_handoff withdraws it; don't send a second brief and leave the teammate to guess which one wins.",
  "follow_up wakes you later in this conversation with a note to yourself. Use it when you are waiting on something that doesn't message you (a build, a deadline, a quiet teammate) so the work carries on without the person having to nudge you.",
  "read_conversation reads a teammate's conversation or a room, and search_messages searches everything said in the person's conversations: use them to see where work got to instead of asking.",
  "ask_bot asks a teammate a short question and waits for the answer. Only for a consultation you need before you can reply; never for assigned work.",
  "create_room opens a group chat with teammates (and you and the person) when the person asks for one or a discussion needs several of you at once; its first message @mentions who should answer. For assigned work, delegate_bot is still the way: its result comes back to you, a room's talk doesn't.",
  "create_bot adds a new teammate when the person asks for one: a name, a job title, its instructions in the description field (what it owns, sources, boundaries, what it returns; the app shows them as Instructions and they become its SOUL), and optionally a mascot colour, expression, shape and connected apps. Then brief it with delegate_bot if there is work for it.",
  "update_bot changes a teammate's profile when the person asks you to: its name, title, instructions (the description field, its SOUL), mascot colour, expression, shape or picture. 'Make @Web Designer a Coder' means title: Coder and matching instructions.",
  "Those are every bot's, not only the primary bot's: who adds teammates and hands out work is a matter of the job, not of what you are allowed to call. Unless you are the primary bot, use them when the person asks you to, not on your own.",
  `Routines are yours to make and change: the person can only see them and switch them on or off, so when they want one made, changed, removed or run, you do it. create_routine schedules a prompt for yourself on a cron in the person's time zone, optionally with one of their skills, paused until they turn it on unless they asked for it in this conversation. list_routines shows yours; update_routine changes or pauses one, delete_routine removes it, run_routine runs it once now. When a routine fires (a message that starts [Routine: …] or [Watch: …]) and there is nothing new worth telling the person since its last run, answer with exactly ${QUIET_REPLY} and nothing else: the run then leaves no trace in the chat and nobody is notified. Anything they would want to know, say as usual.`,
  `Speak up before you're asked. A watch is a routine with watch: true that checks something for a change (a calendar clash, a flight, a price, a reply they're waiting on, a status page, a charge on an account) and speaks only when the change matters to the person; its run shows them "<your name> noticed". When the person asks about the same thing a second time, or about anything that will change later, offer once to keep an eye on it, in one line ending with ::choices (like "Want me to watch your calendar for clashes like this?" ::choices[Yes, always | Work only | No thanks]); on a yes, create_routine with watch: true and enabled: true, a cron no more often than the thing changes, and a prompt that says exactly what counts as worth telling. Don't offer again for something they turned down. When a watch speaks, lead with what changed and what it means for them, in a line or two, then the one thing you can do about it (draft the reply and ask_approval to send it, say). A morning briefing is a plain routine, not a watch. "Less like this" on something you noticed means it wasn't worth it: tighten that watch's prompt with update_routine so it won't come up again.`,
  `Something with a date and time is a reminder, not just a note: when the person mentions an appointment, a deadline, a bill, a flight or anything they mustn't miss ("I have the dentist tomorrow at 2"), create_routine with once: true and enabled: true at a sensible time before it (the morning of, or an hour ahead for something later today; earlier for what needs getting ready), a prompt that says what to tell them, and say in a line when you'll remind them. If you can't tell when it is, ask. When it runs, tell them plainly, in a line or two, with anything useful (when to leave, what to bring); it then removes itself. A run of a reminder is never ${QUIET_REPLY}.`,
  "ask_approval posts a decision card and waits for the person. Whenever you need a yes or no before you act, use it rather than asking in a sentence and ending your turn: the question as summary, where and what as why, the rows that matter as details (items and prices, with total; recipients; files), and buttons named for the act (allow \"Place order\", deny \"Not yet\"). Both buttons are about one act: allow does it, deny doesn't, and deny tells you to stop. It is never a way to pick between options (A or B, this host or every host): for that, end your reply with ::choices[A | B], wait for the pick, and only then ask_approval for the act it settled on, if it still needs a yes. On Auto, call it before anything you can't undo or that leaves the computer: sending a message or email as the person, deleting or overwriting files outside your home, a payment or purchase, a forced push, changing settings for other people, typing a password you weren't given, anything they would want to know first. On Always ask the broker already asks; on Always allow it answers at once.",
  "Connected-app tools (names starting with the app, like GMAIL_SEND_EMAIL) act on the person's real accounts. Reads go through; writes may wait for the person's approval. Say what you sent, created or changed.",
  "team_memory_update replaces the team memory (its path is in the Team memory section), shared by every bot of the person. Keep it to what the whole team needs.",
  "use_skill returns a skill's full instructions and its files by slug. save_skill adds one to the person's library: best from a folder you built in your home (SKILL.md with name and description frontmatter, then the Markdown instructions: steps, decision rules, expected output, what to check with the person first, and how to run each script; beside it scripts/, references/, assets/), or a .skill file, or instructions and text files in the call. update_skill changes one. Every one of the person's bots gets it at once, at ~/.skills/<slug>/.",
  "connect_app connects one of the person's own apps (in their Composio project): it checks whether Gond can connect it through Composio, asks for their Composio key with a masked card when there isn't one yet (set_composio_key does that on its own), and posts a Connect card they tap to sign in. When the app isn't there but has an MCP server, use add_mcp_server with its URL (from the person, or its official docs; never guess one): it asks the person to approve, adds the server for every one of their bots, and posts a Sign in card when the server needs one. A server that wants a key or bearer token instead takes it in headers as {{secret:NAME}}, once request_secret has it; never build a local server or wrapper to carry a key. A server that runs as a command on the computer (like `uv run -m some_mcp`) goes in with add_mcp_server too: install it first, check it starts, then give the command and its args with absolute paths or names on PATH (~/.local/bin is on it) and any environment it needs, never a secret. Every bot gets its tools from its next reply.",
  "request_secret asks the person for a secret by name (like STRIPE_API_KEY or ROOT_PASSWORD) with a reason; the value is stored and you never see it. Use a stored one with run_with_secrets (a command that gets it as $NAME, with the output scrubbed), with a type_login action (typed into a field on the screen, once the person allows it), or as {{secret:NAME}} in an MCP server's headers. list_secrets shows the names that exist. set_composio_key asks for their Composio API key the same way and turns connected apps on; never ask for either as plain text in the conversation.",
  "request_login posts a sign-in card for the site open on your screen when it asks for an email, username, phone, password or code; a type_login action then types each detail into the field you clicked, without you seeing it.",
  "browser and computer are your hands on the screen: a list of JSON actions run in order by Gond, answered with the screen as it is after them. browser is a Chrome window that stays open between replies, for every website; its answer lists what is on screen with refs to act on (click, fill, select, check, read, wait_for and the rest, in its description). computer is the whole desktop, for everything else on it. Connected apps, MCP servers, APIs and the shell come first; never script the screen yourself.",
].join("\n");

type Context = {
  box: BoxConfig;
  bot: Bot;
  thread: Thread;
  message: Message;

  askBot: (bot: Bot, prompt: string, depth: number) => Promise<string>;

  syncSoul: (bot: Bot) => Promise<void>;

  stopWork: (messageId: string) => Promise<boolean>;

  isWorking: (botId: string, threadId: string) => boolean;

  signal?: AbortSignal;
};

const MAX_DECISION_ROWS = 12;
const MAX_DECISION_ITEMS = 60;
const DECISION_KINDS = ["purchase", "send", "delete", "publish", "other"] as const;

/** What a decision card shows beyond its question, trimmed and with every stored secret blanked, since the web shows it as written. */
// ask_approval is a yes or no on one act; a model that wants a pick reaches for it anyway and puts
// the options on the buttons, so deny ends up meaning "the other one" and the bot hears "don't".
const OPTION_LABEL = /^\s*(?:(?:option|choice|plan)\s+[a-z0-9]\b|[a-d1-4]\s*[:).-])/i;
const PICK_QUESTION = /^\s*(?:which|what|where|who|how many|how much)\b/i;

export function pickNotYesNo(summary: string, allow?: string, deny?: string): boolean {
  if (PICK_QUESTION.test(summary)) return true;
  if ([allow, deny].some((label) => label && OPTION_LABEL.test(label))) return true;
  return Boolean(allow?.includes(":") && deny?.includes(":"));
}

// A row's value and the line under the title hold a sentence; a long value stacks under its label on the card.
const DECISION_VALUE_CHARS = 240;
const DECISION_WHY_CHARS = 400;

export function decisionCard(input: Record<string, unknown>) {
  let hide: ((text: string) => string) | undefined;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? (hide ??= secretHider())(value.trim().slice(0, max)) : undefined);
  const row = (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const label = text((value as { label?: unknown }).label, 80);
    return label ? { label, value: text((value as { value?: unknown }).value, DECISION_VALUE_CHARS) ?? "" } : null;
  };
  const item = (value: unknown) => {
    const line = row(value);
    const note = line && text((value as { note?: unknown }).note, 24);
    return line && note ? { ...line, note } : line;
  };
  const detail = (value: unknown) => {
    const line = row(value);
    const items = line && Array.isArray((value as { items?: unknown }).items) ? ((value as { items: unknown[] }).items.slice(0, MAX_DECISION_ITEMS).map(item).filter((i) => i !== null)) : [];
    return line && items.length ? { ...line, items } : line;
  };
  const details = Array.isArray(input.details) ? input.details.slice(0, MAX_DECISION_ROWS).map(detail).filter((r) => r !== null) : [];
  const total = row(input.total);
  const kind = DECISION_KINDS.find((k) => k === input.kind);
  return {
    why: text(input.why, DECISION_WHY_CHARS),
    ...(details.length ? { details } : {}),
    ...(total ? { total } : {}),
    allow: text(input.allow, 24),
    deny: text(input.deny, 24),
    ...(kind ? { kind } : {}),
  };
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

function profilePatch(input: Record<string, unknown>): { name?: string; title?: string; description?: string; color?: string; expression?: BotExpression; shape?: BotShape } | { error: string } {
  const patch: { name?: string; title?: string; description?: string; color?: string; expression?: BotExpression; shape?: BotShape } = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = plainText(input.name).trim().slice(0, 40);
  if (typeof input.title === "string") patch.title = plainText(input.title).trim().slice(0, 80);
  if (typeof input.description === "string") patch.description = plainText(input.description).trim().slice(0, 4000);
  if (typeof input.color === "string" && input.color.trim()) {
    const color = input.color.trim().toUpperCase();
    const known = (BOT_COLORS as readonly string[]).find((c) => c.toUpperCase() === color) ?? NAMED_COLORS[input.color.trim().toLowerCase()];
    if (!known) return { error: `NOT changed: colour must be one of ${BOT_COLORS.join(", ")} (or a name: ${Object.keys(NAMED_COLORS).join(", ")}).` };
    patch.color = known;
  }
  if (typeof input.expression === "string" && input.expression.trim()) {
    const expression = input.expression.trim().toLowerCase();
    if (!(BOT_EXPRESSIONS as readonly string[]).includes(expression)) return { error: `NOT changed: expression must be one of ${BOT_EXPRESSIONS.join(", ")}.` };
    patch.expression = expression as BotExpression;
  }
  if (typeof input.shape === "string" && input.shape.trim()) {
    const shape = input.shape.trim().toLowerCase();
    if (!(BOT_SHAPES as readonly string[]).includes(shape)) return { error: `NOT changed: shape must be one of ${BOT_SHAPES.join(", ")}.` };
    patch.shape = shape as BotShape;
  }
  return patch;
}

const NAMED_COLORS: Record<string, string> = { orange: "#E04E0A", blue: "#2F6FD6", red: "#D03A3A", yellow: "#D98A08", amber: "#D98A08", purple: "#7650D8", violet: "#7650D8", pink: "#CF3D85", teal: "#11998A", green: "#189C47", sky: "#0B8EC8", "light blue": "#0B8EC8", coral: "#D8620F" };

export function sharePath(given: string, botId: string, home: string | null = null): string | null {
  const prefix = home ? `${home.replace(/\/+$/, "")}/` : null;
  const raw = given.startsWith("~/") ? given.slice(2) : prefix && given.startsWith(prefix) ? given.slice(prefix.length) : given.startsWith("/") ? null : `${botHome(botId)}/${given}`;
  if (raw === null) return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return null;
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function signInHow(server: McpServer): string {
  return server.oauthRedirect === "localhost"
    ? ` ${server.name} only sends sign-ins back to localhost: the card opens the sign-in in a new tab, and the person pastes the address it ends on into the card (the desktop app finishes it on its own). Don't call connect_app or add_mcp_server for it again.`
    : " Don't call connect_app or add_mcp_server for it again.";
}

function inlineSkillFiles(given: unknown): BundleFile[] | { error: string } {
  if (given === undefined || given === null) return [];
  if (!Array.isArray(given)) return { error: "files must be a list of { path, content }" };
  const files: BundleFile[] = [];
  for (const item of given as { path?: unknown; content?: unknown }[]) {
    const path = skillFilePath(String(item?.path ?? ""));
    if (!path || typeof item?.content !== "string") return { error: `"${String(item?.path ?? "")}" isn't a usable file (a path inside the skill and text content)` };
    const data = new TextEncoder().encode(item.content);
    files.push({ path, data, executable: looksExecutable(data) });
  }
  return files;
}

/**
 * Puts a picture from the person's home on a bot as its profile picture, or the mascot back for "none".
 * `from` is the bot whose home a relative path is in: the one calling, which may be dressing a teammate.
 */
async function setBotPicture(box: BoxConfig, from: Bot, target: Bot, given: string, signal?: AbortSignal): Promise<{ ok: string } | { error: string }> {
  if (/^(none|mascot|remove|clear)$/i.test(given)) {
    clearBotAvatar(target.id);
    return { ok: "picture (back to the mascot)" };
  }
  const relative = sharePath(given, from.id, boxHome(from.userId));
  if (!relative) return { error: `NOT changed: the picture must be inside the person's home on the computer (~), like images/… from create_image.` };
  let data: Uint8Array;
  try {
    data = await readBoxFileBytes(box, relative);
  } catch (error) {
    return { error: `NOT changed: ${given} couldn't be read (${error instanceof Error ? error.message : "no detail"}).` };
  }
  const type = pictureType(data);
  if (!type) return { error: `NOT changed: ${given} isn't a PNG, JPEG, WebP or GIF.` };
  // A GIF goes as it is so it keeps moving; anything else too big goes as the box's JPEG of it.
  if (type !== "image/gif" && data.byteLength > AVATAR_MAX_BYTES) {
    try {
      data = new Uint8Array(Buffer.from((await previewBoxImage(box, relative, type, signal)).data, "base64"));
    } catch {
      return { error: `NOT changed: ${given} is over ${AVATAR_MAX_BYTES / 1024 / 1024} MB and couldn't be made smaller.` };
    }
  }
  if (data.byteLength > AVATAR_MAX_BYTES) return { error: `NOT changed: the picture must be under ${AVATAR_MAX_BYTES / 1024 / 1024} MB.` };
  try {
    setBotAvatar(target.id, data);
  } catch (error) {
    return { error: `NOT changed: ${error instanceof Error ? error.message : "the picture couldn't be saved"}.` };
  }
  return { ok: "picture" };
}

/** A file name from the first words of a picture's prompt. */
export function pictureName(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .slice(0, 6)
      .join("-")
      .slice(0, 60)
      .replace(/-+$/, "") || "picture"
  );
}

export function mcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
}

export function baseTools(context: Context): Record<string, DriverTool> {
  const { box, bot, thread, message } = context;
  const depth = message.depth + 1;

  const skillBundleFrom = async (input: Record<string, unknown>): Promise<{ input: SkillInput; files: BundleFile[]; meta: string } | { error: string }> => {
    const folder = typeof input.folder === "string" ? input.folder.trim() : "";
    let parsed: ReturnType<typeof parseSkillMd> = { name: null, description: "", instructions: "", meta: "" };
    let files: BundleFile[] = [];
    let folderName: string | null = null;
    if (folder) {
      const relative = sharePath(folder, bot.id, boxHome(bot.userId));
      if (!relative) return { error: "the folder must be inside the person's home on the computer (~)" };
      const read = await readSkillFromBox(box, relative);
      if ("error" in read) return { error: read.error };
      if (read.skillMd === null && typeof input.instructions !== "string") return { error: `there's no SKILL.md in ${folder}. Write one (frontmatter with name and description, then the instructions) and try again` };
      if (read.skillMd !== null) parsed = parseSkillMd(read.skillMd);
      files = read.files;
      folderName = read.folder;
    } else {
      const inline = inlineSkillFiles(input.files);
      if ("error" in inline) return inline;
      files = inline;
    }
    if (containsSecret(Buffer.from(JSON.stringify([input.instructions ?? "", parsed.instructions])))) return { error: "the instructions contain a stored secret. Take it out; a skill asks for secrets with request_secret instead" };
    if (files.some((file) => containsSecret(file.data))) return { error: "a file contains a stored secret. Take it out; a skill asks for secrets with request_secret instead" };
    const name = (typeof input.name === "string" && input.name.trim() ? plainText(input.name).trim() : parsed.name ?? (folderName ? nameFromFolder(folderName) : "")).slice(0, SKILL_LIMITS.name);
    const description = (typeof input.description === "string" && input.description.trim() ? input.description.trim() : parsed.description).slice(0, SKILL_LIMITS.description);
    const instructions = (typeof input.instructions === "string" && input.instructions.trim() ? input.instructions.trim() : parsed.instructions).slice(0, SKILL_LIMITS.instructions);
    if (!name || !instructions) return { error: "a skill needs a name and instructions" };
    return { input: { name, description, instructions }, files, meta: parsed.meta };
  };

  const postSignInCard = (server: McpServer) => {
    const recent = recentMessages(thread.id, 30).some((m) => m.kind === "signin" && m.approvalId === server.id && Date.now() - Date.parse(m.createdAt) < SIGNIN_CARD_FRESH_MS);
    if (!recent) postMessage({ threadId: thread.id, author: bot.id, kind: "signin", body: `Sign in to ${server.name}`, approvalId: server.id, depth, answered: true });
  };

  const postConnectCard = (app: { toolkit: string; name: string }) => {
    const id = composioCard(app.toolkit);
    const recent = recentMessages(thread.id, 30).some((m) => m.kind === "signin" && m.approvalId === id && Date.now() - Date.parse(m.createdAt) < SIGNIN_CARD_FRESH_MS);
    if (!recent) postMessage({ threadId: thread.id, author: bot.id, kind: "signin", body: `Connect ${app.name}`, approvalId: id, depth, answered: true });
  };

  const askComposioKey = async (reason: string): Promise<string | null> => {
    const status = await requestSecret({ bot, threadId: thread.id, name: "COMPOSIO_API_KEY", reason, target: "composio", signal: context.signal });
    if (status === "given" || status === "exists") return null;
    if (status === "declined") return "The person declined to give their Composio API key, so connected apps stay off. Say what you can do without them.";
    return expiredText("for their Composio API key");
  };
  const alreadyAttached = (server: McpServer) => `${server.name} is already attached (${server.url ?? joinCommandLine([server.command ?? "", ...server.args])})${server.enabled ? "" : ", but turned off under Settings → Apps → MCP servers"}.`;

  const saveMcpServer = (input: McpServerInput): McpServer | string => {
    try {
      return createMcpServer(input, bot.userId);
    } catch (error) {
      return `NOT added: ${/UNIQUE/.test(String(error)) ? "a server with that name exists" : "the server couldn't be saved"}.`;
    }
  };

  const addCommandServer = async (name: string, command: string, rawArgs: unknown, rawEnv: unknown): Promise<string> => {
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== "string"))) return "NOT added: args is a list of strings, one argument each.";
    if (rawEnv !== undefined && (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv) || Object.values(rawEnv).some((v) => typeof v !== "string"))) return "NOT added: env maps names to string values.";
    const args = (rawArgs ?? []) as string[];
    const env = (rawEnv ?? {}) as Record<string, string>;
    const secrets = allSecretValues().filter((s) => s.length >= 8);
    if ([command, ...args, ...Object.values(env)].some((part) => secrets.some((secret) => part.includes(secret)))) return "NOT added: that holds a stored secret, and a command's arguments and environment are visible on the computer. A server that needs a key should be a remote one with the key in its headers.";
    const line = joinCommandLine([command, ...args]);
    const existing = listMcpServers(bot.userId).find((m) => m.name === name || (m.transport === "stdio" && joinCommandLine([m.command ?? "", ...m.args]) === line));
    if (existing) return alreadyAttached(existing);
    const checked = mcpServerInputSchema.safeParse({ name, transport: "stdio", command, args, env });
    if (!checked.success) return `NOT added: ${checked.error.issues[0]?.message ?? "bad server"}.`;
    const envNote = Object.keys(env).length ? ` with ${Object.keys(env).join(", ")} set` : "";
    const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool: "add_mcp_server", input: { name, command, args, env }, summary: `Add the MCP server ${name} (runs ${line}${envNote}) for all your bots` });
    if (decision === "deny") return "NOT added: the person said no.";
    if (decision === "expired") return expiredText(`to add the MCP server ${name}`);
    const server = saveMcpServer(checked.data);
    if (typeof server === "string") return server;
    return `Added ${name}; every bot gets its tools from its next reply. If they don't appear then, run the command yourself to see why.`;
  };
  const keyNote = (headers: Record<string, string>) => {
    const parts = Object.entries(headers).map(([header, value]) => (secretNamesIn(value).length ? `${secretNamesIn(value).join(", ")} in ${header}` : header));
    return parts.length ? `, sending ${parts.join("; ")}` : "";
  };

  const afterSave = async (server: McpServer, verb: "Added" | "Updated"): Promise<string> => {
    const probe = await probeMcpServer(server.id).catch(() => ({ status: "error" as const, detail: "no answer" }));
    const fresh = getMcpServer(server.id) ?? server;
    if (probe.status === "needed") {
      postSignInCard(fresh);
      return `${verb} ${server.name}. It needs the person to sign in: a Sign in card is in the conversation. Tell them so in a line; once they do, you'll hear about it and every bot gets its tools from its next reply.${signInHow(fresh)}`;
    }
    if (probe.status === "error") {
      const keyHint = hasKeyHeader(fresh.headers) ? "" : " If it wants a key or bearer token, ask for it with request_secret and call add_mcp_server again with the same URL and headers.";
      return `${verb} ${server.name}, but it isn't usable yet: ${fresh.authError ?? probe.detail ?? "the server didn't answer"}.${keyHint} Tell the person in a line.`;
    }
    return `${verb} ${server.name}; it answered ${hasKeyHeader(fresh.headers) ? "with its key" : "without a sign-in"}. Every bot gets its tools from its next reply.`;
  };

  return {
    set_profile: {
      description: "Update your own profile: name, job title, how you work (your SOUL), your mascot's colour, expression and shape, or your profile picture.",
      inputSchema: schema({
        name: { type: "string", description: "A new name, when the person renames you." },
        title: { type: "string", description: "Your job, one line." },
        description: { type: "string", description: "How you work: what you own, sources, boundaries, what you return. Replaces the current one." },
        color: { type: "string", description: `Mascot colour, one of: ${BOT_COLORS.join(", ")}.` },
        expression: { type: "string", description: `Mascot expression, one of: ${BOT_EXPRESSIONS.join(", ")}.` },
        shape: { type: "string", description: `Mascot shape, one of: ${BOT_SHAPES.join(", ")}. The cog is the Gond bot; change it only when the person asks.` },
        picture: { type: "string", description: "A profile picture to wear instead of your mascot: a picture's path on the computer, like images/… from create_image. none puts the mascot back." },
      }),
      execute: async (input) => {
        const patch = profilePatch(input);
        if ("error" in patch) return patch.error;
        const picture = typeof input.picture === "string" ? input.picture.trim() : "";
        if (Object.keys(patch).length === 0 && !picture) return "Nothing to change.";
        const changed: string[] = [];
        if (picture) {
          const worn = await setBotPicture(box, bot, bot, picture, context.signal);
          if ("error" in worn) return worn.error;
          changed.push(worn.ok);
        }
        if (Object.keys(patch).length) {
          const updated = updateBot(bot.id, patch);
          if (!updated) return "NOT changed: your profile is gone.";
          await context.syncSoul(updated);
          changed.push(...Object.keys(patch));
        }
        return `Profile updated (${changed.join(", ")}).`;
      },
    },
    memory_update: {
      description: "Replace MEMORY.md, the notes that load into every one of your turns.",
      inputSchema: schema({ content: { type: "string", description: "The whole new file." } }, ["content"]),
      execute: async (input) => {
        const content = String(input.content ?? "");
        const size = Buffer.byteLength(content.trim(), "utf8");
        if (size > MAX_MEMORY_BYTES) return `NOT saved: that's ${kb(size)} and MEMORY.md loads only ${kb(MAX_MEMORY_BYTES)}. Move detail into memory/<topic>.md and keep this file to what every turn needs.`;
        await writeBoxFile(box, memoryPath(bot.id), content);
        return `MEMORY.md saved, ${kb(size)} of ${kb(MAX_MEMORY_BYTES)}.${size >= MAX_MEMORY_BYTES * NEARLY_FULL ? " It's nearly full: move detail into memory/<topic>.md." : ""}`;
      },
    },
    ask_approval: {
      description: "Ask the person yes or no before one irreversible or outward-facing act. Posts a decision card with your question, the rows they should see and two buttons named for the act, then waits. allow does it, deny means don't: never put two options on the buttons (use ::choices in your reply for a pick). On Always allow it answers at once.",
      inputSchema: schema(
        {
          summary: { type: "string", description: 'The question, short, as the card\'s title: "Place this order?", "Send this email to Dana?"' },
          why: { type: "string", description: 'One line under it: where and what. "Uber Eats, pickup at Angelo\'s Ale House"' },
          details: {
            type: "array",
            maxItems: MAX_DECISION_ROWS,
            items: schema(
              {
                label: { type: "string" },
                value: { type: "string" },
                items: {
                  type: "array",
                  maxItems: MAX_DECISION_ITEMS,
                  items: schema({ label: { type: "string" }, value: { type: "string" }, note: { type: "string", description: 'A word on what changed: "Swapped", "Out of stock".' } }, ["label"]),
                  description: "The lines behind this row, which the person opens with a tap: each grocery and its price, each file. Then the row is their sum (label \"Groceries\", value \"$86.40\"); the card counts the items itself.",
                },
              },
              ["label"],
            ),
            description: "What they should see before deciding, one row each: subtotal, fees, tip, recipients, files. A long list goes in one row's items, not a row each.",
          },
          total: schema({ label: { type: "string" }, value: { type: "string" } }, ["label", "value"]),
          allow: { type: "string", description: 'The yes button, named for the act: "Place order", "Send it". Default "Allow".' },
          deny: { type: "string", description: 'The no button, which means don\'t do it: "Not yet", "Don\'t send". Never another option. Default "Deny".' },
          kind: { type: "string", enum: [...DECISION_KINDS] },
        },
        ["summary"],
      ),
      execute: async (input) => {
        const summary = String(input.summary ?? "").trim();
        if (!summary) return "Say what you want to do in summary.";
        const card = decisionCard(input);
        if (pickNotYesNo(summary, card.allow, card.deny))
          return "Not posted: that is a pick between options, and ask_approval is only a yes or no on one act (allow does it, deny means don't). End your reply with ::choices[First option | Second option] and stop; the person's pick comes back as their message. Then call ask_approval for the act they picked, with a yes-or-no question like \"Copy golem's compose files?\", if it still needs one.";
        const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool: "ask_approval", input: { summary: hideSecrets(summary.slice(0, 300)), ...card }, summary: summary.slice(0, 300) });
        if (decision === "allow" || decision === "always") return card.allow ? `The person chose "${card.allow}". Go ahead.` : "Allowed. Go ahead.";
        if (decision === "expired") return expiredText(`"${summary.slice(0, 120)}"`);
        return card.deny ? `The person chose "${card.deny}": don't do it. Do something else, or say what you would need.` : "Denied: the person said no. Do something else, or say what you would need.";
      },
    },
    post_message: {
      description: "Post to this conversation, your chat with the person, now: a line before your final answer, or, when a teammate's message woke you and your answer goes back to them, what the person should hear. It never reaches a teammate; message_bot does.",
      inputSchema: schema({ text: { type: "string" } }, ["text"]),
      execute: async (input) => {
        const text = String(input.text ?? "").trim();
        if (!text) return "Nothing to post.";
        const body = hideSecrets(text.slice(0, 4000));
        postMessage({ threadId: thread.id, author: bot.id, body, depth, answered: true });
        // The person's own messages and routines push with the final answer; a teammate's never does, so this is the only notice they get.
        const fromTeammate = Boolean(message.fromThreadId) && Boolean(getBot(message.author));
        if (fromTeammate && bot.notify) void sendPush({ title: bot.name, body: plainMarkdown(body).slice(0, 140), url: `/app/t/${thread.id}`, tag: thread.id, threadId: thread.id }, thread.userId);
        return "Posted.";
      },
    },
    react: {
      description: `Put an emoji reaction on the person's message you are answering, one of ${REACTIONS.join(" ")}. Calling it again changes it.`,
      inputSchema: schema({ emoji: { type: "string", enum: [...REACTIONS] } }, ["emoji"]),
      execute: async (input) => {
        if (!isReaction(input.emoji)) return `NOT reacted: the emoji is one of ${REACTIONS.join(" ")}.`;
        if (message.author !== "you" || message.kind !== "message") return "NOT reacted: only a message from the person takes a reaction.";
        setReaction(message, bot.id, input.emoji);
        return "Reacted.";
      },
    },
    send_file: {
      description: "Hand the person a file from the computer: it appears in this conversation with a download button. Paths are relative to your home folder, or start with ~/ for the person's home on the computer (like ~/.team/<team>/report.html).",
      inputSchema: schema({ path: { type: "string", description: "The file, like report.pdf or ~/.team/<team>/hello-world.html." }, note: { type: "string", description: "A line to go with it, optional." } }, ["path"]),
      execute: async (input) => {
        const given = String(input.path ?? "").trim();
        if (!given) return "NOT sent: which file?";
        const relative = sharePath(given, bot.id, boxHome(bot.userId));
        if (!relative) return "NOT sent: the file must be inside the person's home on the computer (~). To show them the screen, call send_screenshot instead.";
        let data: Uint8Array;
        try {
          data = await readBoxFileBytes(box, relative);
        } catch (error) {
          return `NOT sent: ${error instanceof Error ? error.message : "the file couldn't be read"}.`;
        }
        if (data.byteLength > MAX_SENT_FILE_BYTES) return `NOT sent: the file is larger than ${MAX_SENT_FILE_BYTES / 1024 / 1024} MB.`;
        if (containsSecret(data)) return "NOT sent: the file contains a stored secret. Take it out first.";
        const name = relative.split("/").pop() || "file";
        const file = storeAttachment({ name: name.slice(0, 200), mediaType: mediaTypeFor(name), data });
        const note = hideSecrets(String(input.note ?? "").trim().slice(0, 4000));
        postMessage({ threadId: thread.id, author: bot.id, body: note, attachments: [file], depth, answered: true });
        return `Sent ${name} to the person; it's in the conversation with a download button. Don't repeat the path.`;
      },
    },
    create_image: {
      description: `Make a picture with the person's own image model and post it in this conversation: a drawing, poster, logo, illustration or photo-like scene, or a change to pictures you have. It takes up to a few minutes; the person watches it being made.`,
      inputSchema: schema(
        {
          prompt: { type: "string", description: "What the picture shows, in detail: subject, style, colours, composition, any words on it. For a change, what to change." },
          aspect: { type: "string", enum: [...IMAGE_ASPECTS], description: "square (the default), portrait or landscape. A change to one picture keeps its shape." },
          from: { type: "array", items: { type: "string" }, description: `Pictures to change or work from, up to ${MAX_IMAGE_REFERENCES}: paths like inbox/… (what the person sent) or images/… (what you made).` },
          note: { type: "string", description: "A line to go with it, optional." },
        },
        ["prompt"],
      ),
      execute: async (input) => {
        const prompt = String(input.prompt ?? "").trim().slice(0, 4000);
        if (!prompt) return "NOT made: what should the picture show?";
        const aspect = isImageAspect(input.aspect) ? input.aspect : "square";
        const given = Array.isArray(input.from) ? input.from.map((path) => String(path ?? "").trim()).filter(Boolean) : [];
        if (given.length > MAX_IMAGE_REFERENCES) return `NOT made: at most ${MAX_IMAGE_REFERENCES} pictures in from.`;
        const access = await imageAccess(bot.userId);
        if (!access) return "NOT made: the person has no way to make pictures yet. Tell them to sign in to Grok with SuperGrok, or add an xAI or OpenAI key, in Settings → AI. A ChatGPT plan can't make pictures here.";

        const references: ImageReference[] = [];
        for (const path of given) {
          const relative = sharePath(path, bot.id, boxHome(bot.userId));
          if (!relative) return `NOT made: ${path} must be inside the person's home on the computer (~).`;
          const name = relative.split("/").pop() || "picture";
          const type = mediaTypeFor(name);
          if (!type.startsWith("image/") || type === "image/svg+xml") return `NOT made: ${path} isn't a picture.`;
          try {
            const shrunk = await previewBoxImage(box, relative, type, context.signal);
            references.push({ name: `${name.replace(/\.[^.]+$/, "")}.jpg`, mediaType: shrunk.mediaType, data: new Uint8Array(Buffer.from(shrunk.data, "base64")) });
          } catch (error) {
            return `NOT made: ${path} couldn't be read (${error instanceof Error ? error.message : "no detail"}).`;
          }
        }

        const id = crypto.randomUUID();
        const tell = (state: "making" | "preview" | "done" | "failed", preview: string | null = null, file: string | null = null) => emit({ topic: "picture", threadId: thread.id, botId: bot.id, id, aspect, state, preview, file });
        tell("making");
        let previews = 0;
        try {
          const picture = await createImage(access, {
            prompt,
            aspect,
            references,
            signal: context.signal,
            onPreview: (rough) => {
              keepPreview(id, { threadId: thread.id, data: rough.data, mediaType: rough.mediaType });
              previews += 1;
              tell("preview", `/api/threads/${thread.id}/pictures/${id}?v=${previews}`);
            },
          });
          const extension = picture.mediaType === "image/png" ? "png" : picture.mediaType === "image/webp" ? "webp" : "jpg";
          const name = pictureName(prompt);
          const saved = `images/${name}-${Date.now().toString(36)}.${extension}`;
          const kept = await uploadBoxFile(box, `${botHome(bot.id)}/${saved}`, picture.data, context.signal).then(
            () => true,
            () => false,
          );
          const file = storeAttachment({ name: `${name}.${extension}`, mediaType: picture.mediaType, data: picture.data });
          postMessage({ threadId: thread.id, author: bot.id, body: hideSecrets(String(input.note ?? "").trim().slice(0, 4000)), attachments: [file], depth, answered: true });
          tell("done", null, file.id);
          return `Made with ${IMAGE_MODELS[picture.source].label} and posted; the person can see it${kept ? `. It's also at ${saved} in your home: Read it to look at it again, or pass it in from for changes` : ""}. Don't describe it.`;
        } catch (error) {
          tell("failed");
          if (context.signal?.aborted) return "NOT made: stopped.";
          return `NOT made: ${error instanceof Error ? error.message : "the picture couldn't be made."}`;
        } finally {
          keepPreview(id, null);
        }
      },
    },
    list_bots: {
      description: "The team: every bot with its id, job, and which is the person's primary bot.",
      inputSchema: schema({}),
      execute: async () =>
        listBots({ userId: bot.userId })
          .map((b) => `- ${b.id} · ${b.name} (@${handleOf(b.name)})${b.title ? ` · ${b.title}` : ""}${b.primary ? " · primary bot" : ""}${b.id === bot.id ? " · (you)" : ""}`)
          .join("\n") || "No bots.",
    },
    message_bot: {
      description: "Send a teammate a note and return at once. Its answer comes back to your conversation without waking you. In a room, a note to another member is said in the room, with an @mention, for everyone to see.",
      inputSchema: schema({ bot: { type: "string", description: "The teammate's id, name or @handle." }, text: { type: "string" } }, ["bot", "text"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT sent: too many bot-to-bot hops. Bring the person in.";
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT sent: no bot called "${String(input.bot ?? "")}". Use list_bots.`;
        if (target.id === bot.id) return "NOT sent: that's you.";
        const text = String(input.text ?? "").trim();
        if (!text) return "NOT sent: empty message.";
        if (thread.kind === "room" && thread.members.includes(target.id)) {
          // A group chat, like the person's: what one member tells another there is said where everyone sees it.
          const body = hideSecrets((mentionsIn(text).includes(handleOf(target.name)) ? text : `@${handleOf(target.name)} ${text}`).slice(0, 8000));
          const wake = botLinesSincePerson(thread.id) < MAX_ROOM_LINES;
          postMessage({ threadId: thread.id, author: bot.id, body, depth, answered: !wake, wake });
          return wake ? `${target.name} is in this room, so it was said here, where the person sees it too; ${target.name} answers here. Don't repeat it in your answer.` : `Said here, but the room is waiting for the person before any bot answers. Don't repeat it in your answer.`;
        }
        postMessage({ threadId: target.threadId, author: bot.id, body: hideSecrets(text.slice(0, 8000)), depth, fromThreadId: thread.id });
        return `Sent to ${target.name}. Its answer will come back here.`;
      },
    },
    team_memory_update: {
      description: `Replace ~/${teamMemoryPath(bot.userId)}, the memory shared by every bot on your person's team.`,
      inputSchema: schema({ content: { type: "string", description: "The whole new file." } }, ["content"]),
      execute: async (input) => {
        const content = String(input.content ?? "");
        const size = Buffer.byteLength(content.trim(), "utf8");
        if (size > MAX_TEAM_MEMORY_BYTES) return `NOT saved: that's ${kb(size)} and the team memory loads only ${kb(MAX_TEAM_MEMORY_BYTES)}. Keep it to what everyone needs; longer notes go in ~/${teamDir(bot.userId)}/<topic>.md.`;
        await writeBoxFile(box, teamMemoryPath(bot.userId), content);
        return `${teamMemoryPath(bot.userId)} saved for the whole team, ${kb(size)} of ${kb(MAX_TEAM_MEMORY_BYTES)}.${size >= MAX_TEAM_MEMORY_BYTES * NEARLY_FULL ? ` It's nearly full: move detail into ~/${teamDir(bot.userId)}/<topic>.md.` : ""}`;
      },
    },
    use_skill: {
      description: "Read a skill from the person's library by its slug (see the Skills list): its instructions and the files in its folder.",
      inputSchema: schema({ slug: { type: "string" } }, ["slug"]),
      execute: async (input) => {
        const skill = getSkillBySlug(bot.userId, String(input.slug ?? "").replace(/^\//, "").trim());
        if (!skill) return `No skill called "${String(input.slug ?? "")}". The library: ${listSkills(bot.userId).map((s) => `/${s.slug}`).join(", ") || "(empty)"}.`;
        await skillsReady(bot.userId);
        return clip(`# ${skill.name} (/${skill.slug})\n${skill.description}\n\n${skillBrief(skill)}`);
      },
    },
    save_skill: {
      description:
        "Save a skill to the person's library, for all of their bots to reuse, from a folder you built on the computer (SKILL.md plus scripts/, references/, assets/…), from a .skill file, or from instructions (and optional text files) given here. Use it when the person asks you to make something into a skill.",
      inputSchema: schema({
        folder: { type: "string", description: "The skill's folder on the computer, relative to your home (like skills/weekly-report) or ~/…, with SKILL.md in it; or a .skill / .zip file. Everything in it but hidden files, caches and virtualenvs is saved." },
        name: { type: "string", description: "Short, like 'Weekly pipeline review'. Taken from SKILL.md when a folder is given and this is left out." },
        description: { type: "string", description: "What it does and when to use it, one or two sentences." },
        instructions: { type: "string", description: "Markdown, when no folder is given: the steps, decision rules, expected output, what to check with the person first, and how to run each file." },
        files: {
          type: "array",
          description: "Text files to go with the instructions when no folder is given, like scripts/report.py.",
          items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
        },
      }),
      execute: async (input) => {
        const bundle = await skillBundleFrom(input);
        if ("error" in bundle) return `NOT saved: ${bundle.error}.`;
        try {
          const skill = createSkill(bot.userId, bundle.input, "bot", { files: bundle.files, meta: bundle.meta });
          await syncSkills(bot.userId);
          return `Saved as /${skill.slug}${skill.files.length ? ` with ${skill.files.length} file${skill.files.length === 1 ? "" : "s"} (${skill.files.map((f) => f.path).join(", ")}), now in ~/.skills/${skill.slug}/` : ""}. The person can hand it to any of their bots by typing /${skill.slug}, and edit or download it as a .skill under Settings → Skills. Tell them so in a line.`;
        } catch (error) {
          return `NOT saved: ${error instanceof Error ? error.message : "the skill couldn't be saved"}`;
        }
      },
    },
    update_skill: {
      description: "Change a skill in the person's library by its slug: new instructions, name or description, or its whole folder again from the computer. Only when the person asks, or to fix a skill you just saved.",
      inputSchema: schema(
        {
          slug: { type: "string" },
          folder: { type: "string", description: "A folder or .skill file to replace the skill with entirely (SKILL.md and every file)." },
          name: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string", description: "New Markdown instructions; the files stay unless a folder or files are given." },
          files: {
            type: "array",
            description: "Text files to add or replace, like scripts/report.py; the others stay.",
            items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
          },
        },
        ["slug"],
      ),
      execute: async (input) => {
        const skill = getSkillBySlug(bot.userId, String(input.slug ?? "").replace(/^\//, "").trim());
        if (!skill) return `No skill called "${String(input.slug ?? "")}".`;
        try {
          if (typeof input.folder === "string" && input.folder.trim()) {
            const bundle = await skillBundleFrom({ ...input, name: input.name ?? skill.name });
            if ("error" in bundle) return `NOT changed: ${bundle.error}.`;
            updateSkill(skill.id, { ...bundle.input, files: bundle.files, meta: bundle.meta });
          } else {
            const patch: { name?: string; description?: string; instructions?: string } = {};
            if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, SKILL_LIMITS.name);
            if (typeof input.description === "string") patch.description = input.description.trim().slice(0, SKILL_LIMITS.description);
            if (typeof input.instructions === "string" && input.instructions.trim()) patch.instructions = input.instructions.trim().slice(0, SKILL_LIMITS.instructions);
            const files = inlineSkillFiles(input.files);
            if ("error" in files) return `NOT changed: ${files.error}.`;
            if (files.length) {
              const byPath = new Map(skillFiles(skill.id).map((f) => [f.path, f]));
              for (const file of files) byPath.set(file.path, file);
              updateSkill(skill.id, { ...patch, files: [...byPath.values()] });
            } else updateSkill(skill.id, patch);
          }
        } catch (error) {
          return `NOT changed: ${error instanceof Error ? error.message : "the skill couldn't be saved"}`;
        }
        await syncSkills(bot.userId);
        const next = getSkill(skill.id)!;
        return `Updated /${next.slug}${next.files.length ? ` (files: ${next.files.map((f) => f.path).join(", ")})` : ""}.`;
      },
    },
    request_secret: {
      description: "Ask the person for a secret (an API key, a token) by name. It is stored for injection; you never see it.",
      inputSchema: schema({ name: { type: "string", description: "UPPER_SNAKE_CASE, like STRIPE_API_KEY." }, reason: { type: "string", description: "What it's for, in one line." } }, ["name", "reason"]),
      execute: async (input) => {
        const name = String(input.name ?? "").trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) return "NOT asked: name it in UPPER_SNAKE_CASE, like STRIPE_API_KEY.";
        const status = await requestSecret({ bot, threadId: thread.id, name, reason: String(input.reason ?? "").trim().slice(0, 300), signal: context.signal });
        if (status === "exists") return `${name} is already stored. Use it with run_with_secrets ($${name} in a command), a type_login action (typed into a field on the screen), or {{secret:${name}}} in an MCP server's headers.`;
        if (status === "given") return `${name} is stored; you never see the value. Use it with run_with_secrets ($${name} in a command), a type_login action, or {{secret:${name}}} in an MCP server's headers (add_mcp_server), and carry on.`;
        if (status === "declined") return `The person declined to give ${name}. Say what you can do without it.`;
        return expiredText(`for ${name}`);
      },
    },
    request_login: {
      description:
        "Sign in to a website you have open on the computer. Call it when the page asks for an email, username, phone number, password or a code: it posts one card with those fields, the person fills it in, and you never see what they typed. Then click into each field and send a type_login action (to the browser or computer tool) with the name this returns. When the person saved their details for the site, they're used without a card once the person allows it.",
      inputSchema: schema(
        {
          site: { type: "string", description: "The site as the person knows it, like Uber Eats or amazon.com." },
          fields: {
            type: "array",
            description: "What the page asks for right now, in its order.",
            items: { type: "object", properties: { kind: { type: "string", enum: [...LOGIN_FIELD_KINDS] }, label: { type: "string", description: "The page's own words for it when they differ, like 'Mobile number or email'." } }, required: ["kind"], additionalProperties: false },
          },
          reason: { type: "string", description: "What it's for, in one line, like 'to order your Dr Pepper'." },
        },
        ["site", "fields"],
      ),
      execute: async (input) => {
        const site = plainText(String(input.site ?? "")).trim().slice(0, 60);
        const prefix = loginPrefix(site);
        if (!prefix) return "NOT asked: name the site, like Uber Eats.";
        const fields = loginFields(prefix, input.fields);
        if ("error" in fields) return `NOT asked: ${fields.error}.`;
        const next = `Click into each field and send a type_login action with its name: ${fields.map((f) => f.name).join(", ")}. Never read what you typed back off the screen.`;
        if (fields.every((f) => rememberable(f) && readLogin(bot.userId, f.name) !== null)) {
          const decision = await requestApproval({ bot, threadId: thread.id, tool: "request_login", input: { site }, summary: `Sign in to ${site} with your saved details`, signal: context.signal });
          if (decision === "allow" || decision === "always") {
            for (const f of fields) holdLogin(thread.id, f.name, readLogin(bot.userId, f.name)!);
            return `The saved details for ${site} are ready. ${next}`;
          }
          if (decision === "expired") return expiredText(`to sign in to ${site}`);
        }
        const status = await requestSecret({ bot, threadId: thread.id, name: prefix, reason: String(input.reason ?? "").trim().slice(0, 200) || `to sign you in to ${site}`, target: "login", site, fields, signal: context.signal });
        if (status === "given" || status === "exists") return `The person filled it in. ${next}`;
        if (status === "declined") return `The person chose not to sign in to ${site}. Say what you can do without it.`;
        return expiredText(`to sign in to ${site}`);
      },
    },
    set_composio_key: {
      description: "Ask the person for their Composio API key and store it as their Composio project key, which turns on connected apps (Gmail, GitHub, Notion and the rest). A masked card asks for it; you never see the value. Use this when they have no key yet and want their apps connected.",
      inputSchema: schema({ reason: { type: "string", description: "What they asked for, in one line, like 'to connect your Gmail'." } }),
      execute: async (input) => {
        if (composioConfigured(bot.userId)) return "A Composio key is already in place. Connect an app with connect_app.";
        const failed = await askComposioKey(String(input.reason ?? "").trim().slice(0, 200) || "to connect your apps");
        if (failed) return failed;
        return "Stored. Connected apps are on. Connect one with connect_app; a free key comes from dashboard.composio.dev if they need another.";
      },
    },
    list_secrets: {
      description: "The names of the stored secrets (never their values).",
      inputSchema: schema({}),
      execute: async () => listSecrets(bot.userId).map((s) => `- ${s.name}${s.site ? ` (saved sign-in for ${s.site}; use it through request_login)` : ""}`).join("\n") || "No secrets stored.",
    },
    connect_app: {
      description: "Connect one of the person's apps: looks it up among the apps Gond can connect (Composio); starts the connection and returns the sign-in link, or says how to attach it as an MCP server when it isn't there.",
      inputSchema: schema({ app: { type: "string", description: "The app, like gmail, github, notion, googlecalendar." } }, ["app"]),
      execute: async (input) => {
        const wanted = String(input.app ?? "").trim().toLowerCase();
        if (!wanted) return "Which app?";
        const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
        const already = listConnections(bot.userId).find((c) => squash(c.toolkit) === squash(wanted) || squash(c.name) === squash(wanted));
        if (already?.status === "active") return `${already.name} is already connected, and every bot of the person's gets its tools. If you don't see them yet, they arrive on your next reply.`;
        const mcp = listMcpServers(bot.userId).find((m) => squash(m.name) === squash(wanted));
        if (mcp) {
          if (mcp.authStatus === "needed" && mcp.enabled) {
            postSignInCard(mcp);
            return `${mcp.name} is attached as an MCP server but needs the person to sign in; a Sign in card is in the conversation.${signInHow(mcp)}`;
          }
          return `${mcp.name} is attached as an MCP server${mcp.enabled ? "" : " but turned off (Settings → Apps → MCP servers)"}; its tools reach every bot.`;
        }

        const catalog = await catalogIndex(bot.userId);
        const entry = exactApp(catalog, wanted) ?? searchIndex(catalog, wanted)[0];
        if (entry) {
          if (!composioConfigured(bot.userId)) {
            const key = await askComposioKey(`to connect ${entry.name} and your other apps`);
            if (key) return key;
          }
          postConnectCard(entry);
          return `A Connect card for ${entry.name} is in the conversation; the person taps it to sign in to ${entry.name}. Once they do, every bot of theirs gets ${entry.name}'s tools from its next reply.`;
        }
        return `${wanted} isn't among the apps Gond can connect through Composio. If it offers an MCP server, add it with add_mcp_server and its URL (the one the person gave you, or from the app's official docs; don't guess). A server that runs as a command on the computer goes in with add_mcp_server too, once it is installed. If it has neither, use the browser on the computer.`;
      },
    },
    add_mcp_server: {
      description: "Attach an MCP server, for an app connect_app can't connect: a remote one by its HTTP URL, or one that runs as a command on the computer (install it first and check it starts). The person approves it first; every one of their bots gets its tools from its next reply. When a remote server wants a sign-in, a Sign in card goes into the conversation. When it wants a key or bearer token instead, get it with request_secret, then give headers like {\"Authorization\": \"Bearer {{secret:CURA_TOKEN}}\"}: the API fills the key in on every request, so it never reaches you or the computer. Calling it again for an attached server with new headers updates them. Never write a local server or proxy to carry a key.",
      inputSchema: schema(
        {
          name: { type: "string", description: "What to call it, like robinhood or aseprite." },
          url: { type: "string", description: "A remote server's URL, exactly as the person or the app's docs give it, like https://mcp.example.com/mcp. Leave out for a command." },
          command: { type: "string", description: "A command server's program: an absolute path or a name on PATH, like /home/agent/.local/bin/uv or npx. Leave out for a URL." },
          args: { type: "array", items: { type: "string" }, description: "The command's arguments, one per item, unquoted; use absolute paths, since it starts in your folder." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Environment the command needs, like ASEPRITE_PATH. It is visible on the computer, so never a secret." },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "A remote server's headers. A key goes in only by name, {{secret:NAME}}, once request_secret has stored it." },
        },
        ["name"],
      ),
      execute: async (input) => {
        const name = mcpServerName(String(input.name ?? ""));
        const url = String(input.url ?? "").trim();
        const command = String(input.command ?? "").trim();
        if (url && command) return "NOT added: give a URL or a command, not both.";
        if (!url && !command) return "NOT added: give the server's URL, or the command that starts it.";
        if (!name) return "NOT added: give the server a name, like the app's.";
        if (command && input.headers !== undefined) return "NOT added: headers are for a remote server. A command server gets no secrets.";
        if (command) return addCommandServer(name, command, input.args, input.env);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return "NOT added: that isn't a URL. Ask the person for the server's address.";
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "NOT added: an MCP server's URL starts with https://.";
        if (parsed.username || parsed.password) return "NOT added: leave credentials out of the URL. When the server needs a key, ask for it with request_secret and give it in headers as {{secret:NAME}}.";
        const headers = checkMcpHeaders(input.headers, (secret) => hasSecret(bot.userId, secret), allSecretValues());
        if (typeof headers === "string") return `NOT added: ${headers}`;
        const existing = listMcpServers(bot.userId).find((m) => m.name === name || m.url === parsed.href || m.url === url);
        if (existing && existing.transport === "http" && Object.keys(headers).length && JSON.stringify(existing.headers) !== JSON.stringify(headers)) {
          const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool: "add_mcp_server", input: { name: existing.name, url: existing.url, headers }, summary: `Change the MCP server ${existing.name}'s headers${keyNote(headers)}` });
          if (decision === "deny") return "NOT changed: the person said no.";
          if (decision === "expired") return expiredText(`to change the MCP server ${existing.name}`);
          const updated = updateMcpServer(existing.id, { headers });
          if (!updated) return "NOT changed: the server is gone.";
          markMcpRefreshed(existing.id);
          return afterSave(updated, "Updated");
        }
        if (existing) {
          if (existing.authStatus === "needed" && existing.enabled) {
            postSignInCard(existing);
            return `${existing.name} is already attached and needs the person to sign in; a Sign in card is in the conversation.${signInHow(existing)}`;
          }
          return alreadyAttached(existing);
        }
        const checked = mcpServerInputSchema.safeParse({ name, transport: "http", url: parsed.href, headers });
        if (!checked.success) return `NOT added: ${checked.error.issues[0]?.message ?? "bad server"}.`;
        const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool: "add_mcp_server", input: { name, url: parsed.href, ...(Object.keys(headers).length ? { headers } : {}) }, summary: `Add the MCP server ${name} (${parsed.href})${keyNote(headers)} for all your bots` });
        if (decision === "deny") return "NOT added: the person said no.";
        if (decision === "expired") return expiredText(`to add the MCP server ${name}`);
        const server = saveMcpServer(checked.data);
        if (typeof server === "string") return server;
        return afterSave(server, "Added");
      },
    },
    list_routines: {
      description: "Your scheduled routines.",
      inputSchema: schema({}),
      execute: async () =>
        listRoutines(bot.id)
          .map((r) => `- ${r.id} · ${r.name}${r.watch ? " (watch)" : ""} · ${r.cron} (${r.timezone})${r.skillId ? ` · /${getSkill(r.skillId, bot.userId)?.slug ?? "a removed skill"}` : ""} · ${r.enabled ? `next ${r.nextRunAt ?? "?"}` : "paused"}`)
          .join("\n") || "No routines yet.",
    },
    create_routine: {
      description: "Schedule a prompt for yourself on a five-field cron in the person's time zone.",
      inputSchema: schema(
        {
          name: { type: "string" },
          cron: { type: "string", description: "minute hour day-of-month month day-of-week" },
          prompt: { type: "string", description: "What to do each time." },
          enabled: { type: "boolean", description: "True only when the person asked for it now." },
          watch: { type: "boolean", description: `True for a watch: it checks for a change and answers ${QUIET_REPLY} unless there is one worth telling.` },
          once: { type: "boolean", description: 'True for a reminder: it runs the next time the cron matches (minute, hour, day and month set, like "0 8 24 10 *"), then removes itself.' },
          skill: { type: "string", description: "Optional: the slug of one of the person's skills to use each time; the prompt then carries its inputs." },
        },
        ["name", "cron", "prompt"],
      ),
      execute: async (input) => {
        const timezone = userTimezone(bot.userId);
        const cron = String(input.cron ?? "").trim();
        let preview: string[];
        try {
          preview = previewRuns(cron, timezone, 3);
        } catch (error) {
          return `NOT created: bad cron (${error instanceof Error ? error.message : "invalid"}).`;
        }
        const skill = routineSkill(input.skill);
        if (skill === undefined) return `NOT created: the person has no skill "${String(input.skill)}".`;
        const once = input.once === true;
        const routine = createRoutine(bot.id, { name: String(input.name ?? "Routine").slice(0, 80), cron, timezone, prompt: String(input.prompt ?? "").slice(0, 4000), enabled: input.enabled === true, watch: input.watch === true && !once, once, skillId: skill });
        const status = routine.enabled ? "on" : "paused; the person can turn it on under Routines";
        if (once) return `Created the reminder "${routine.name}" (${status}). It runs once, at ${preview[0]}, then removes itself.`;
        return `Created ${routine.watch ? "the watch " : ""}"${routine.name}" (${status}). Next runs: ${preview.join(", ")}.`;
      },
    },
    update_routine: {
      description: "Change one of your routines: its name, cron, prompt, skill, whether it is a watch, or whether it is on.",
      inputSchema: schema(
        {
          routine: { type: "string", description: "Its id or name (list_routines)." },
          name: { type: "string" },
          cron: { type: "string", description: "minute hour day-of-month month day-of-week" },
          prompt: { type: "string" },
          enabled: { type: "boolean", description: "Turn it on only when the person asked for that; pause it freely." },
          watch: { type: "boolean" },
          skill: { type: "string", description: "The slug of one of the person's skills to use, or an empty string for none." },
        },
        ["routine"],
      ),
      execute: async (input) => {
        const routine = ownRoutine(String(input.routine ?? ""));
        if (!routine) return `NOT changed: you have no routine "${String(input.routine ?? "")}". Use list_routines.`;
        const patch: { name?: string; cron?: string; prompt?: string; enabled?: boolean; watch?: boolean; skillId?: string | null } = {};
        if (typeof input.skill === "string") {
          const skill = routineSkill(input.skill);
          if (skill === undefined) return `NOT changed: the person has no skill "${input.skill}".`;
          patch.skillId = skill;
        }
        if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 80);
        if (typeof input.prompt === "string" && input.prompt.trim()) patch.prompt = input.prompt.trim().slice(0, 4000);
        if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
        if (typeof input.watch === "boolean") patch.watch = input.watch;
        if (typeof input.cron === "string" && input.cron.trim()) {
          try {
            previewRuns(input.cron.trim(), routine.timezone, 1);
          } catch (error) {
            return `NOT changed: bad cron (${error instanceof Error ? error.message : "invalid"}).`;
          }
          patch.cron = input.cron.trim();
        }
        if (Object.keys(patch).length === 0) return "Nothing to change.";
        const updated = updateRoutine(routine.id, patch)!;
        return `Updated "${updated.name}" (${Object.keys(patch).join(", ")}): ${updated.enabled ? `on, next run ${updated.nextRunAt ?? "?"}` : "paused"}.`;
      },
    },
    delete_routine: {
      description: "Delete one of your routines for good. To stop it for a while, pause it with update_routine instead.",
      inputSchema: schema({ routine: { type: "string", description: "Its id or name (list_routines)." } }, ["routine"]),
      execute: async (input) => {
        const routine = ownRoutine(String(input.routine ?? ""));
        if (!routine) return `NOT deleted: you have no routine "${String(input.routine ?? "")}". Use list_routines.`;
        deleteRoutine(routine.id);
        return `Deleted "${routine.name}".`;
      },
    },
    run_routine: {
      description: "Run one of your routines now, once, whether it is on or paused. It runs in your own conversation after this reply.",
      inputSchema: schema({ routine: { type: "string", description: "Its id or name (list_routines)." } }, ["routine"]),
      execute: async (input) => {
        const routine = ownRoutine(String(input.routine ?? ""));
        if (!routine) return `NOT run: you have no routine "${String(input.routine ?? "")}". Use list_routines.`;
        const posted = postMessage({ threadId: bot.threadId, author: "routine", body: routinePrompt(routine) });
        recordRoutineRun(routine.id, posted.id);
        return `"${routine.name}" is queued in your own conversation; it runs once you're free there.`;
      },
    },
    follow_up: {
      description: "Wake yourself later in this conversation: 'check on Bolt's build in 45 minutes'. When it is due you get a prompt with your note and carry on. With cancel, drops one you set.",
      inputSchema: schema({
        minutes: { type: "number", description: `How long from now, 1 to ${MAX_FOLLOW_UP_MINUTES}.` },
        note: { type: "string", description: "What to check or do then, for your future self." },
        cancel: { type: "string", description: "The id of a follow-up to drop instead." },
      }),
      execute: async (input) => {
        if (typeof input.cancel === "string" && input.cancel.trim()) {
          return cancelFollowUp(input.cancel.trim(), bot.id) ? "Dropped that follow-up." : "NOT dropped: you have no such follow-up waiting.";
        }
        const minutes = Number(input.minutes);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_FOLLOW_UP_MINUTES) return `NOT set: minutes must be between 1 and ${MAX_FOLLOW_UP_MINUTES}.`;
        const note = String(input.note ?? "").trim();
        if (!note) return "NOT set: say what to check then.";
        const waiting = listFollowUps(bot.id);
        if (waiting.length >= MAX_FOLLOW_UPS) return `NOT set: you already have ${waiting.length} follow-ups waiting (list_handoffs shows them). Drop one with cancel first.`;

        const where = thread.kind === "room" ? bot.threadId : thread.id;
        const followUp = createFollowUp({ botId: bot.id, threadId: where, note: `${note.slice(0, 2000)}${thread.kind === "room" ? ` (set in the room "${thread.name}")` : ""}`, dueAt: new Date(Date.now() + Math.round(minutes) * 60_000) });
        return `Set (id ${followUp.id}): you'll be woken at ${followUp.dueAt}${where !== thread.id ? " in your own conversation" : ""}.`;
      },
    },
    read_conversation: {
      description: "Read the latest messages in one of the person's conversations: a teammate's (by its name) or a room (by its name or id). Read-only.",
      inputSchema: schema({
        conversation: { type: "string", description: "A teammate's id, name or @handle, or a room's name or id." },
        limit: { type: "number", description: "How many messages, newest last; 20 when left out, at most 60." },
      }, ["conversation"]),
      execute: async (input) => {
        const ref = String(input.conversation ?? "").trim();
        const bots = listBots({ includeHidden: true, userId: bot.userId });
        const threads = threadRefs(bot.userId);
        const teammate = findBot(ref, bots);
        const target =
          (teammate ? threads.find((t) => t.id === teammate.threadId) : undefined) ??
          threads.find((t) => t.id === ref) ??
          threads.find((t) => t.kind === "room" && t.name.toLowerCase() === ref.toLowerCase());
        if (!target) return `NOT found: no conversation "${ref}". Name a teammate, or a room (${threads.filter((t) => t.kind === "room").map((t) => `"${t.name}"`).join(", ") || "there are none"}).`;
        const limit = Math.min(Math.max(Math.round(Number(input.limit) || 20), 1), 60);
        const names = new Map(bots.map((b) => [b.id, b.name]));
        const lines = listMessages(target.id, { limit: limit * 2 })
          .filter((m) => m.kind !== "prompt" && m.kind !== "activity")
          .slice(-limit)
          .map((m) => {
            const who = m.author === "you" ? "Person" : m.author === "routine" ? "Routine" : m.author === "system" ? "Gond" : `${names.get(m.author) ?? m.author}${m.author === bot.id ? " (you)" : ""}`;
            const body = m.body.length > 3000 ? `${m.body.slice(0, 3000)} [… ${m.body.length - 3000} more characters]` : m.body;
            return `[${ago(m.createdAt)}] ${who}: ${m.kind === "approval" ? `(asked for approval: ${body})` : body}`;
          });
        return clip(`${target.kind === "room" ? `Room "${target.name}"` : `${target.name}'s conversation`}, last ${lines.length} message${lines.length === 1 ? "" : "s"}:\n${lines.join("\n\n") || "(nothing said yet)"}`);
      },
    },
    search_messages: {
      description: "Search everything said in the person's conversations, yours and your teammates' and the rooms', newest first.",
      inputSchema: schema({ query: { type: "string" }, limit: { type: "number", description: "At most 30; 10 when left out." } }, ["query"]),
      execute: async (input) => {
        const query = String(input.query ?? "").trim().slice(0, 200);
        if (query.length < 2) return "NOT searched: give at least two characters.";
        const limit = Math.min(Math.max(Math.round(Number(input.limit) || 10), 1), 30);
        const names = new Map(listBots({ includeHidden: true, userId: bot.userId }).map((b) => [b.id, b.name]));
        const threads = new Map(threadRefs(bot.userId).map((t) => [t.id, t]));
        const found = searchMessages(query, bot.userId, limit);
        if (found.length === 0) return `Nothing said matches "${query}".`;
        return clip(
          found
            .map((m) => {
              const where = threads.get(m.threadId);
              const who = m.author === "you" ? "Person" : m.author === "routine" ? "Routine" : m.author === "system" ? "Gond" : (names.get(m.author) ?? m.author);
              return `- [${ago(m.createdAt)}] in ${where?.kind === "room" ? `the room "${where.name}"` : `${where?.name ?? "a conversation"}'s conversation`}, ${who}: ${snippetAround(m.body, query)}`;
            })
            .join("\n"),
        );
      },
    },
  };

  function ownRoutine(ref: string) {
    const mine = listRoutines(bot.id);
    return mine.find((r) => r.id === ref) ?? mine.find((r) => r.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;
  }

  /** A skill named for a routine: its id, null for none, undefined when the person has no such skill. */
  function routineSkill(ref: unknown): string | null | undefined {
    const slug = typeof ref === "string" ? ref.trim().replace(/^\//, "") : "";
    if (!slug) return null;
    return getSkillBySlug(bot.userId, slug)?.id;
  }
}

export function teamTools(context: Context): Record<string, DriverTool> {
  const { bot, thread, message, askBot } = context;
  const depth = message.depth + 1;
  const team = () => listBots({ includeHidden: true, userId: bot.userId });

  const handOver = (target: Bot, given: string, parentId = handoffWorkedOn(message.id)?.id ?? null) => {
    const brief = hideSecrets(given);
    const posted = postMessage({ threadId: target.threadId, author: bot.id, body: brief.slice(0, 12_000), depth, fromThreadId: thread.id });
    return createDelegation({ fromBotId: bot.id, fromThreadId: thread.id, toBotId: target.id, toThreadId: target.threadId, messageId: posted.id, brief, parentId });
  };

  const openHandoff = (ref: string): Delegation | string => {
    const byId = getDelegation(ref.trim());
    if (byId) return byId.fromBotId === bot.id && byId.status === "open" ? byId : byId.fromBotId === bot.id ? `that handoff is already ${byId.status}.` : "that handoff isn't yours.";
    const target = findBot(ref, team());
    if (!target) return `no handoff or teammate "${ref}". Use list_handoffs.`;
    const open = listDelegationsForBot(bot.id, new Date().toISOString()).filter((d) => d.fromBotId === bot.id && d.toBotId === target.id && d.status === "open");
    if (open.length === 0) return `you have no open handoff to ${target.name}.`;
    if (open.length > 1) return `you have ${open.length} open handoffs to ${target.name}; name one by id (list_handoffs).`;
    return open[0]!;
  };

  const withdraw = async (handoff: Delegation, why: string) => {
    finishDelegation(handoff.id, "cancelled", why);

    if (!(await context.stopWork(handoff.messageId))) markAnswered(handoff.messageId);
    const to = getBot(handoff.toBotId);
    postMessage({ threadId: handoff.toThreadId, author: bot.id, body: `I've withdrawn the task I handed you ${ago(handoff.createdAt)} ("${oneLineOf(handoff.brief, 120)}"): ${why}`, depth, fromThreadId: thread.id, answered: true });
    return to;
  };

  return {
    delegate_bot: {
      description: "Hand a teammate a self-contained brief in its own conversation. Returns at once; the result comes back to you here.",
      inputSchema: schema({ bot: { type: "string", description: "The teammate's id, name or @handle." }, brief: { type: "string" } }, ["bot", "brief"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT delegated: too many bot-to-bot hops, so nothing was sent. Tell the person the handoff didn't go out and ask them to send it on.";
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT delegated: no bot called "${String(input.bot ?? "")}". Use list_bots.`;
        if (target.id === bot.id) return "NOT delegated: that's you.";
        const brief = String(input.brief ?? "").trim();
        if (!brief) return "NOT delegated: empty brief.";
        const handoff = handOver(target, brief);
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} handed a task to ${target.name}.`, answered: true });
        return `Assigned to ${target.name} (handoff ${handoff.id}). Its result will arrive here as a message from ${target.name}. When your handoffs are out, finish with your reply to the person; say what went to whom.`;
      },
    },
    list_handoffs: {
      description: "What you handed out and what was handed to you: open ones, and those finished in the last day with their results. Also your follow-ups still to come. With id, one handoff's full brief and result.",
      inputSchema: schema({ id: { type: "string", description: "A handoff's id, for its full brief and result." } }),
      execute: async (input) => {
        const names = new Map(team().map((b) => [b.id, b.name]));
        if (typeof input.id === "string" && input.id.trim()) {
          const one = getDelegation(input.id.trim());
          if (!one || (one.fromBotId !== bot.id && one.toBotId !== bot.id)) return "NOT found: no such handoff of yours.";
          return clip(`Handoff ${one.id}, ${names.get(one.fromBotId) ?? "?"} → ${names.get(one.toBotId) ?? "?"}, ${one.status}, handed over ${ago(one.createdAt)}${one.finishedAt ? `, closed ${ago(one.finishedAt)}` : ""}.\n\nBrief:\n${one.brief}${one.result ? `\n\nResult:\n${one.result}` : ""}`);
        }
        const all = listDelegationsForBot(bot.id, new Date(Date.now() - HANDOFF_WINDOW_MS).toISOString());
        const waitingOn = (d: Delegation) => {
          const n = openChildren(d.id);
          return n ? `, waiting on ${n} handed on` : "";
        };
        const describe = (d: Delegation, other: string) => {
          const state =
            d.status === "open"
              ? `open, handed over ${ago(d.createdAt)}${context.isWorking(d.toBotId, d.toThreadId) ? ", being worked on now" : ""}${waitingOn(d)}${d.nudgedAt ? ", chased once" : ""}`
              : `${d.status === "cancelled" ? "withdrawn" : d.status} ${ago(d.finishedAt ?? d.createdAt)}`;
          const result = d.status === "done" && d.result ? `\n  result: ${oneLineOf(d.result, 300)}` : "";
          return `- ${d.id} · ${other} · ${state}\n  brief: ${oneLineOf(d.brief, 160)}${result}`;
        };
        const out = all.filter((d) => d.fromBotId === bot.id).map((d) => describe(d, `to ${names.get(d.toBotId) ?? "a removed bot"}`));
        const given = all.filter((d) => d.toBotId === bot.id).map((d) => describe(d, `from ${names.get(d.fromBotId) ?? "a removed bot"}`));
        const followUps = listFollowUps(bot.id).map((f) => `- ${f.id} · due ${f.dueAt} · ${oneLineOf(f.note, 160)}`);
        return clip(
          [
            `Handed out by you:\n${out.join("\n") || "(none in the last day)"}`,
            `Handed to you:\n${given.join("\n") || "(none in the last day)"}`,
            `Your follow-ups:\n${followUps.join("\n") || "(none)"}`,
          ].join("\n\n"),
        );
      },
    },
    cancel_handoff: {
      description: "Withdraw a brief you handed out that is no longer wanted: the teammate stops if it is working on it, hears why, and nothing comes back.",
      inputSchema: schema({ handoff: { type: "string", description: "Its id (list_handoffs), or the teammate when you have one open handoff to it." }, reason: { type: "string" } }, ["handoff", "reason"]),
      execute: async (input) => {
        const handoff = openHandoff(String(input.handoff ?? ""));
        if (typeof handoff === "string") return `NOT withdrawn: ${handoff}`;
        const reason = String(input.reason ?? "").trim().slice(0, 2000) || "it isn't needed any more.";
        const to = await withdraw(handoff, reason);
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} withdrew a task from ${to?.name ?? "a teammate"}.`, answered: true });
        return `Withdrawn from ${to?.name ?? "the teammate"}; it has been told why.`;
      },
    },
    amend_handoff: {
      description: "Replace a brief you handed out with a corrected one when the plan changed: the teammate stops the old one and gets the new brief, which replaces it in list_handoffs. Its work so far stays in its session and files.",
      inputSchema: schema({ handoff: { type: "string", description: "Its id (list_handoffs), or the teammate when you have one open handoff to it." }, brief: { type: "string", description: "The whole corrected brief, self-contained; say what changed." } }, ["handoff", "brief"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT amended: too many bot-to-bot hops, so nothing was changed. Tell the person.";
        const handoff = openHandoff(String(input.handoff ?? ""));
        if (typeof handoff === "string") return `NOT amended: ${handoff}`;
        const brief = String(input.brief ?? "").trim();
        if (!brief) return "NOT amended: empty brief.";
        const target = getBot(handoff.toBotId);
        if (!target) return "NOT amended: that teammate is gone.";
        await withdraw(handoff, "a corrected brief follows and replaces it.");
        const next = handOver(target, `Updated brief, replacing the one from ${ago(handoff.createdAt)}. Keep what still holds from your work so far.\n\n${brief}`, handoff.parentId);
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} sent ${target.name} a corrected brief.`, answered: true });
        return `Sent ${target.name} the corrected brief (handoff ${next.id}, replacing ${handoff.id}). Its result comes back here.`;
      },
    },
    create_room: {
      description: `Open a group chat (a room) with teammates and you in it, ${ROOM_MAX_BOTS} bots at most, you included. With a first message, the teammates it names answer there; in a room only an @mention wakes a bot.`,
      inputSchema: schema(
        {
          name: { type: "string", description: "The room's name, like Launch plan." },
          bots: { type: "array", items: { type: "string" }, description: "The teammates to add: ids, names or @handles. You are added too." },
          message: { type: "string", description: "Optional first message from you in the room; the teammates in it are @mentioned when you don't name any." },
        },
        ["name", "bots"],
      ),
      execute: async (input) => {
        const name = plainText(String(input.name ?? "")).trim().slice(0, 80);
        if (!name) return "NOT created: give the room a name.";
        const team = listBots({ userId: bot.userId });
        const asked = Array.isArray(input.bots) ? input.bots.map(String) : [];
        const invited: Bot[] = [];
        const unknown: string[] = [];
        for (const ref of asked) {
          const found = findBot(ref, team);
          if (!found) unknown.push(ref);
          else if (found.id !== bot.id && !invited.some((b) => b.id === found.id)) invited.push(found);
        }
        if (unknown.length) return `NOT created: no bot called ${unknown.map((r) => `"${r}"`).join(", ")}. Use list_bots.`;
        if (invited.length === 0) return "NOT created: name at least one teammate besides you.";
        if (invited.length + 1 > ROOM_MAX_BOTS) return `NOT created: a room holds at most ${ROOM_MAX_BOTS} bots, you included. Pick the teammates the job needs.`;
        const room = createRoom(name, [bot.id, ...invited.map((b) => b.id)], bot.userId);
        postMessage({ threadId: room.id, author: "system", kind: "event", body: `${bot.name} opened this room with ${invited.map((b) => b.name).join(", ")}. Mention a bot with @ to address it.`, answered: true });
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} opened the room "${name}".`, answered: true });
        const text = String(input.message ?? "").trim();
        if (text) postMessage({ threadId: room.id, author: bot.id, body: hideSecrets(roomOpener(text, invited).slice(0, 8000)), depth: message.depth, wake: true });
        return `Opened the room "${name}" (id ${room.id}) with ${invited.map((b) => b.name).join(", ")} and you.${text ? " Your message is posted; those it names answer there, and you answer there when they @mention you." : " Nothing is said there yet."} What is said there stays in the room: it doesn't come back to this conversation.`;
      },
    },
    create_bot: {
      description: "Add a new teammate: name, job title, how it works (its SOUL), mascot colour, expression and shape. Every connected app works for every bot.",
      inputSchema: schema(
        {
          name: { type: "string", description: "Its name; one is picked when left out." },
          title: { type: "string", description: "Its job, one line, like Developer." },
          description: { type: "string", description: "How it works: what it owns, sources, boundaries, what it returns." },
          color: { type: "string", description: `One of: ${BOT_COLORS.join(", ")}.` },
          expression: { type: "string", description: `One of: ${BOT_EXPRESSIONS.join(", ")}.` },
          shape: { type: "string", description: `One of: ${BOT_SHAPES.join(", ")}; cog unless the person asks for another.` },
        },
        ["title", "description"],
      ),
      execute: async (input) => {
        const patch = profilePatch(input);
        if ("error" in patch) return patch.error.replace("NOT changed", "NOT created");
        if (!patch.title || !patch.description) return "NOT created: give it a job title and a description of how it works.";
        const taken = listBots({ includeHidden: true, userId: bot.userId }).map((b) => b.name);
        const takenLower = new Set(taken.map((n) => n.toLowerCase()));
        let name = patch.name ?? pickBotName(taken);
        for (let i = 2, base = name; takenLower.has(name.toLowerCase()); i += 1) name = `${base} ${i}`;
        const created = createBot(botInputSchema.parse({ name, title: patch.title, description: patch.description, color: patch.color ?? BOT_COLORS[taken.length % BOT_COLORS.length], expression: patch.expression ?? "happy", shape: patch.shape ?? "cog" }), bot.userId);
        postMessage({ threadId: created.threadId, author: "system", kind: "event", body: `${bot.name} added ${created.name}${created.title ? ` as ${created.title}` : ""}.`, answered: true });
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} added ${created.name} to the team.`, answered: true });
        await context.syncSoul(created);
        return `Created ${created.name} (@${handleOf(created.name)}, id ${created.id}) as ${created.title}. Brief it with delegate_bot when there is work for it.`;
      },
    },
    update_bot: {
      description: "Change a teammate's profile when the person asks: name, job title, how it works (its SOUL), mascot colour, expression, shape or profile picture.",
      inputSchema: schema({
        bot: { type: "string", description: "The teammate's id, name or @handle." },
        name: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "Replaces its current one." },
        color: { type: "string", description: `One of: ${BOT_COLORS.join(", ")}.` },
        expression: { type: "string", description: `One of: ${BOT_EXPRESSIONS.join(", ")}.` },
        shape: { type: "string", description: `One of: ${BOT_SHAPES.join(", ")}; cog unless the person asks for another.` },
        picture: { type: "string", description: "A profile picture for it to wear instead of its mascot: a picture's path in your home, like images/… from create_image. none puts the mascot back." },
      }, ["bot"]),
      execute: async (input) => {
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT changed: no bot called "${String(input.bot ?? "")}". Use list_bots.`;
        if (target.id === bot.id) return "That's you: use set_profile.";
        const patch = profilePatch(input);
        if ("error" in patch) return patch.error;
        const picture = typeof input.picture === "string" ? input.picture.trim() : "";
        if (Object.keys(patch).length === 0 && !picture) return "Nothing to change.";
        const changed: string[] = [];
        if (picture) {
          const worn = await setBotPicture(context.box, bot, target, picture, context.signal);
          if ("error" in worn) return worn.error;
          changed.push(worn.ok);
        }
        if (Object.keys(patch).length === 0) return `${target.name}'s profile updated (${changed.join(", ")}).`;
        const updated = updateBot(target.id, patch);
        if (!updated) return "NOT changed: that bot is gone.";
        await context.syncSoul(updated);
        return `${updated.name}'s profile updated (${[...changed, ...Object.keys(patch)].join(", ")}). It reads its new SOUL on its next turn.`;
      },
    },
    ask_bot: {
      description: "Ask a teammate a short question and wait for the answer.",
      inputSchema: schema({ bot: { type: "string" }, question: { type: "string" } }, ["bot", "question"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT asked: too many bot-to-bot hops.";
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT asked: no bot called "${String(input.bot ?? "")}".`;
        if (target.id === bot.id) return "NOT asked: that's you.";
        const question = String(input.question ?? "").trim();
        if (!question) return "NOT asked: empty question.";
        const answer = await askBot(target, `${bot.name} (${bot.title || "teammate"}) asks you, briefly: ${question}`, depth);
        return clip(answer || "(no answer)");
      },
    },
  };
}

export function permissionTool(context: Context): DriverTool {
  const { bot, thread } = context;
  return {
    description: "Internal: Gond's permission prompt.",

    // Loose on purpose: the CLI may add fields (suggestions, ids) over time.
    inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
    execute: async (raw) => {
      const tool = String(raw.tool_name ?? "");
      const input = (raw.input && typeof raw.input === "object" ? raw.input : {}) as Record<string, unknown>;
      if (scriptsTheScreen(tool, input)) return JSON.stringify({ behavior: "deny", message: SCRIPTED_SCREEN_TEXT });
      if (touchesEngine(tool, input)) return JSON.stringify({ behavior: "deny", message: ENGINE_FILES_TEXT });
      const { decision, note } = await askApproval({ bot, threadId: thread.id, signal: context.signal, tool, input });
      if (decision === "allow" || decision === "always") return JSON.stringify({ behavior: "allow", updatedInput: input });
      const message = decision === "expired" ? expiredText(`for "${summarize(tool, input)}"`) : note ? `The person wants changes to "${summarize(tool, input)}" first: "${note}". Make them and try again.` : `The person denied "${summarize(tool, input)}". Do something else, or say what you would need.`;
      return JSON.stringify({ behavior: "deny", message });
    },
  };
}

export async function appTools(context: Context): Promise<Record<string, DriverTool>> {
  const { bot, thread } = context;
  let tools: ComposioTool[] = [];
  try {
    tools = await toolsFor(bot.userId);
  } catch (error) {
    console.warn(`[gond] connected apps unavailable for ${bot.name}: ${error instanceof Error ? error.message : error}`);
    return {};
  }
  const out: Record<string, DriverTool> = {};
  for (const tool of tools) {
    const slug = tool.slug.toUpperCase();
    out[slug] = {
      description: `${tool.toolkit?.name ?? tool.toolkit?.slug ?? "App"}: ${tool.description ?? tool.name}`.slice(0, 1000),
      inputSchema: tool.inputParameters ?? { type: "object", properties: {} },
      execute: async (asked) => {
        let input = asked;
        let send = false;
        let edited = false;
        if (!isReadOnlyAction(slug)) {
          const first = Object.entries(input).find(([, v]) => typeof v === "string") as [string, string] | undefined;
          const email = emailDraftOf(slug, input);
          const summary = email ? `${tool.name} to ${email.to.map(emailName).join(", ") || "the thread"}${email.subject ? `: ${email.subject.slice(0, 160)}` : ""}` : `${tool.name}${first ? `: ${first[1].slice(0, 160)}` : ""}`;
          const answer = await askApproval({ bot, threadId: thread.id, signal: context.signal, tool: slug, input, summary });
          if (answer.decision === "deny" && answer.note) return `NOT done: the person wants changes first: "${answer.note}". Make them and call ${slug} again with the new version; its card shows them what you changed, so don't write it out in your reply.`;
          if (answer.decision === "deny") return "NOT done: the person denied this action.";
          if (answer.decision === "expired") return expiredText(`for ${tool.name}`);
          edited = answer.edited;
          input = answer.input;
          send = answer.send;
        }
        const result = await executeAction(bot.userId, slug, input, tool.toolkit?.slug);
        const text = clip(typeof result === "string" ? result : JSON.stringify(result, null, 1));
        const changed = edited ? `The person edited the letter on the card before it went; this is what went: ${JSON.stringify(emailDraftOf(slug, input))}\n` : "";
        const sending = send ? sendDraftAction(slug) : null;
        if (!sending) return `${changed}${text}`;
        const id = draftIdOf(result);
        if (!id) return `${changed}The person tapped Send, but the draft was only saved: its id wasn't in the answer, so it couldn't be sent. Tell them it is waiting in their drafts.\n${text}`;
        await executeAction(bot.userId, sending.slug, { [sending.idKey]: id }, tool.toolkit?.slug);
        return `${changed}Sent: the person tapped Send on the draft's card, so it went out rather than waiting as a draft. Say it was sent, in a line.`;
      },
    };
  }
  return out;
}
