import { APP_CATALOG } from "./apps.ts";
import type { ScreenStepType } from "./screen.ts";

export type ToolLabel = { verb: string; detail: string | null };
/**
 * `plain`: for a line the person reads (the work line), in their words, with no command or full path.
 * Without it the label is exact, for the work log and what a retried turn hears it already did.
 */
export type ToolLabelContext = { home?: string | null; servers?: { name: string }[]; plain?: boolean };

const BRIDGE_PREFIX = /^mcp__gond__/;
const COMPOSIO_ACTION = /^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/;
const MCP_TOOL = /^mcp__([^_].*?)__(.+)$/;
const LABEL_MAX = 60;

export function bareToolName(name: string): string {
  return name.replace(BRIDGE_PREFIX, "");
}

const asSlug = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

/**
 * What an app's tool does, as one uppercase slug, so one set of words catches it however it is
 * written: Composio's `GMAIL_SEND_EMAIL` as it is, an MCP server's `send_email`, `sendEmail` or
 * `send-email` as SEND_EMAIL, with the server's own slug as `server`. Gond's own tools and the
 * engine's come back as they are named, lowercase or one word, which no app's action word matches.
 */
export function appAction(tool: string): { action: string; server: string | null } {
  const bare = bareToolName(tool);
  const mcp = MCP_TOOL.exec(bare);
  return mcp ? { action: asSlug(mcp[2]!), server: asSlug(mcp[1]!) } : { action: bare, server: null };
}

// Opens the person's door, car, garage or alarm to someone: by the time they read about it, it's too late.
const PHYSICAL_ACTION = /(^|_)(UNLOCK|UNLOCKS|UNLATCH|DISARM|DISARMS|REMOTE_START|OPEN_(?:DOOR|DOORS|GARAGE|GATE|TRUNK|FRUNK|COVER))(_|$)/;
// A smart home's catch-all runs whatever command its input names, so the input says whether it unlocks.
const DEVICE_ACTION = /(^|_)(COMMAND|COMMANDS|SERVICE|EXECUTE|CALL|CONTROL)(_|$)/;
const PHYSICAL_COMMAND = /\b(?:unlock|unlatch|disarm|alarm_disarm|open_cover|remote_start|actuate_trunk)\b/i;

/** Whether an app's action unlocks or opens something in the physical world: it asks every time, and never as a saved rule. */
export function physicalAccess(tool: string, input: Record<string, unknown>): boolean {
  const { action } = appAction(tool);
  return PHYSICAL_ACTION.test(action) || (DEVICE_ACTION.test(action) && PHYSICAL_COMMAND.test(JSON.stringify(input)));
}

function short(value: unknown, max = LABEL_MAX): string | null {
  if (typeof value !== "string") return null;
  const line = value.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function quoted(value: unknown, max = LABEL_MAX): string | null {
  const text = short(value, max);
  return text ? `“${text}”` : null;
}

function shownPath(value: unknown, home?: string | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const path = value.trim();
  const relative = home && path.startsWith(`${home}/`) ? path.slice(home.length + 1) : path;
  return short(relative, 120);
}

function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/**
 * A path as a person would say it in a work line: the bot's memory, the team's memory, a skill, a file
 * they sent, else the file's own name. Never a full path: those mean nothing to the person reading.
 * `home` is the bot's own folder (`<person's home>/.bots/<id>`).
 */
export function placeOf(value: unknown, home?: string | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let path = value.trim().replace(/\/+$/, "");
  const person = home ? home.replace(/\/\.bots\/[^/]+$/, "") : null;
  if (person && path.startsWith("~/")) path = `${person}${path.slice(1)}`;
  const own = home && (path === home || path.startsWith(`${home}/`)) ? path.slice(home.length + 1) : home && !path.startsWith("/") && !path.startsWith("~") ? path : null;
  if (own !== null) {
    if (own === "" || own === ".") return "its folder";
    if (own === "MEMORY.md" || own === "memory" || own.startsWith("memory/")) return "its memory";
    if (own === "SOUL.md") return "its profile";
    if (own === "inbox" || own.startsWith("inbox/")) return "a file you sent";
  }
  if (/(^|\/)\.team(\/|$)/.test(path)) return "the team memory";
  const skill = /(^|\/)\.skills\/([^/]+)/.exec(path);
  if (skill) return `the ${skill[2]} skill`;
  if (/(^|\/)\.skills$/.test(path)) return "the skills";
  if (/(^|\/)\.claude(\.json)?(\/|$)/.test(path)) return "Claude Code's settings";
  return short(baseName(path)) ?? short(path);
}

const PATH_IN_TEXT = /(?<![\w.:/])(?:~|\/[\w.@-]+)(?:\/[\w.@-]+)+\/?/g;

export function withoutPaths(text: string, home?: string | null): string {
  return text.replace(PATH_IN_TEXT, (path) => placeOf(path, home) ?? path);
}

/** What a shell command is for, from the few words Claude Code gives with each, never the command itself. */
function commandLine(input: Record<string, unknown>, home?: string | null): ToolLabel {
  const said = short(typeof input.description === "string" ? withoutPaths(input.description, home) : null, 80);
  return said ? { verb: said.charAt(0).toUpperCase() + said.slice(1), detail: null } : { verb: "Running a command", detail: null };
}

const GERUNDS: Record<string, string> = {
  get: "getting", run: "running", set: "setting", put: "putting", reply: "replying", create: "creating",
  add: "adding", cancel: "cancelling", begin: "beginning", stop: "stopping", forward: "forwarding", open: "opening",
  log: "logging", plan: "planning", tag: "tagging", drop: "dropping", pin: "pinning", star: "starring", sum: "summing",
};

export function gerund(word: string): string {
  const w = word.toLowerCase();
  if (GERUNDS[w]) return GERUNDS[w]!;
  if (w.endsWith("ie")) return `${w.slice(0, -2)}ying`;
  if (w.endsWith("e") && !w.endsWith("ee") && !w.endsWith("ye") && !w.endsWith("oe")) return `${w.slice(0, -1)}ing`;
  return `${w}ing`;
}

function humanise(slug: string, form: "gerund" | "infinitive"): string {
  const words = slug.toLowerCase().split(/[_\s-]+/).filter(Boolean);
  if (!words.length) return slug;
  if (form === "gerund") words[0] = gerund(words[0]!);
  return words.join(" ");
}

function toolkitName(segment: string): string {
  const slug = segment.toLowerCase();
  const known = APP_CATALOG.find((app) => app.toolkit === slug);
  return known ? known.name : slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Many servers name their tools after themselves (Notion's `notion-search`); the server is already said. */
function mcpAction(server: string, action: string): string {
  const own = new RegExp(`^${server.replace(/[^a-z0-9]/gi, "")}[-_]+(?=.)`, "i");
  return action.replace(own, "");
}

function serverName(segment: string, servers?: { name: string }[]): string {
  const lower = segment.toLowerCase();
  return servers?.find((server) => server.name.toLowerCase() === lower)?.name ?? segment;
}

function fileOf(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname || short(url);
  } catch {
    return short(url);
  }
}

function stepLabel(step: Record<string, unknown>): ToolLabel | null {
  switch (step.type) {
    case "screenshot":
      return { verb: "Taking a screenshot", detail: null };
    case "click":
      return { verb: typeof step.hold === "number" && step.hold > 0 ? "Holding the mouse down" : "Clicking", detail: typeof step.label === "string" ? quoted(step.label, 40) : null };
    case "hold":
      return { verb: "Holding the mouse down", detail: null };
    case "type":
      return { verb: "Typing", detail: typeof step.text === "string" ? `"${short(step.text, 40) ?? ""}"` : null };
    case "type_login":
      return { verb: "Typing a sign-in", detail: null };
    case "key":
      return { verb: "Pressing", detail: short(step.key) };
    case "scroll":
      return { verb: "Scrolling", detail: short(step.direction) };
    case "move":
    case "hover":
      return { verb: "Moving the mouse", detail: null };
    case "fill":
      return { verb: "Filling in a field", detail: null };
    case "select":
      return { verb: "Choosing", detail: typeof step.option === "string" ? quoted(step.option, 40) : null };
    case "check":
      return { verb: step.checked === false ? "Unticking a box" : "Ticking a box", detail: null };
    case "read":
      return { verb: "Reading the page", detail: null };
    case "copy":
      return { verb: "Copying", detail: null };
    case "paste":
      return { verb: "Pasting", detail: null };
    case "clipboard":
      return { verb: "Reading the clipboard", detail: null };
    case "images":
      return { verb: "Looking at the photos", detail: null };
    case "wait_for":
      return { verb: "Waiting for", detail: typeof step.text === "string" ? quoted(step.text, 40) : short(step.url) };
    case "upload":
      return { verb: "Uploading", detail: typeof step.path === "string" ? short(baseName(step.path)) : null };
    case "dialog":
      return { verb: "Answering a dialog", detail: null };
    case "new_tab":
      return { verb: "Opening a tab", detail: typeof step.url === "string" ? short(step.url.replace(/^https?:\/\//, "").replace(/\/$/, "")) : null };
    case "close_tab":
      return { verb: "Closing a tab", detail: null };
    case "drag":
      return { verb: "Dragging", detail: null };
    case "mouse_down":
      return { verb: "Pressing the mouse button", detail: null };
    case "mouse_up":
      return { verb: "Releasing the mouse button", detail: null };
    case "wait":
      return { verb: "Waiting", detail: null };
    case "navigate":
      return { verb: "Opening", detail: typeof step.url === "string" ? short(step.url.replace(/^https?:\/\//, "").replace(/\/$/, "")) : null };
    case "back":
      return { verb: "Going back", detail: null };
    case "forward":
      return { verb: "Going forward", detail: null };
    case "reload":
      return { verb: "Reloading", detail: null };
    case "tab":
      return { verb: "Switching tabs", detail: null };
    default:
      return null;
  }
}

const NATIVE_STEP: Record<string, ScreenStepType> = {
  left_click: "click",
  right_click: "click",
  middle_click: "click",
  double_click: "click",
  triple_click: "click",
  mouse_move: "move",
  left_click_drag: "drag",
};

/** Anthropic's own computer tool sends one `{ action, coordinate, text, … }`; this is its step. */
export function fromNativeAction(input: Record<string, unknown>): Record<string, unknown> {
  const action = String(input.action ?? "");
  const [x, y] = Array.isArray(input.coordinate) ? input.coordinate : [];
  const [fromX, fromY] = Array.isArray(input.start_coordinate) ? input.start_coordinate : [];
  const at = x === undefined ? {} : { x, y };
  switch (action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      return { type: "click", ...at, button: action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left", count: action === "double_click" ? 2 : action === "triple_click" ? 3 : 1 };
    case "left_click_drag":
      return { type: "drag", x: fromX, y: fromY, to_x: x, to_y: y };
    case "left_mouse_down":
      return { type: "mouse_down", ...at, button: "left" };
    case "left_mouse_up":
      return { type: "mouse_up", ...at, button: "left" };
    case "key":
      return { type: "key", key: input.text };
    case "scroll":
      return { type: "scroll", ...at, direction: input.scroll_direction, amount: input.scroll_amount };
    case "wait":
      return { type: "wait", ms: Math.round(Number(input.duration ?? 1) * 1000) };
    default:
      return { type: NATIVE_STEP[action] ?? action, ...at, ...(typeof input.text === "string" ? { text: input.text } : {}) };
  }
}

function screenLabel(name: string, input: Record<string, unknown>): ToolLabel | null {
  const fallback = name === "browser" ? "Using the browser" : "Using the computer";
  if (typeof input.action === "string") return input.action === "cursor_position" ? null : (stepLabel(fromNativeAction(input)) ?? { verb: fallback, detail: null });
  const steps = Array.isArray(input.actions) ? input.actions.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object") : [];
  if (!steps.length) return { verb: fallback, detail: null };
  const acting = steps.find((s) => s.type !== "screenshot" && s.type !== "wait") ?? steps[0]!;
  return stepLabel(acting) ?? { verb: fallback, detail: null };
}

export function toolLabel(name: string, input: Record<string, unknown> = {}, context: ToolLabelContext = {}): ToolLabel | null {
  if (isQuietTool(name, input)) return null;
  return describeTool(name, input, context);
}

export function describeTool(name: string, input: Record<string, unknown> = {}, context: ToolLabelContext = {}): ToolLabel | null {
  const tool = bareToolName(name);
  const home = context.home ?? null;
  switch (tool) {
    case "Bash": {
      if (context.plain) return commandLine(input, home);
      const command = short(input.command);
      return { verb: "Running", detail: command ? `\`${command}\`` : null };
    }
    case "Read":
    case "NotebookRead":
      return { verb: "Reading", detail: context.plain ? placeOf(fileOf(input), home) : shownPath(fileOf(input), home) };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      if (!context.plain) return { verb: "Editing", detail: shownPath(fileOf(input), home) };
      const place = placeOf(fileOf(input), home);
      return place === "its memory" || place === "the team memory" ? { verb: `Updating ${place}`, detail: null } : { verb: "Editing", detail: place };
    }
    case "Glob":
      if (context.plain) return { verb: "Looking for files", detail: null };
    // falls through: exact, both say their pattern
    case "Grep": {
      // In plain words a word reads well in quotes; a regular expression or a glob doesn't.
      const pattern = context.plain ? (typeof input.pattern === "string" && /^[\w '.-]{1,40}$/.test(input.pattern.trim()) ? quoted(input.pattern) : null) : short(input.pattern);
      return { verb: "Searching files", detail: pattern ? `for ${pattern}` : null };
    }
    case "LS":
      return context.plain ? { verb: "Looking in", detail: placeOf(input.path, home) ?? "its folder" } : { verb: "Listing", detail: shownPath(input.path, home) };
    case "WebFetch":
      return { verb: "Opening", detail: hostOf(input.url) };
    case "WebSearch": {
      const query = quoted(input.query);
      return { verb: "Searching the web", detail: query ? `for ${query}` : null };
    }
    case "Task":
      return { verb: "Running a subtask", detail: short(input.description) };
    case "TodoWrite":
    case "TodoRead":
      return { verb: "Planning", detail: null };
    case "permission":
    case "cursor_position":
      return null;
    case "memory_update":
      return { verb: "Updating its memory", detail: null };
    case "team_memory_update":
      return { verb: "Updating the team memory", detail: null };
    case "memory_read":
      return { verb: input.team === true ? "Reading the team memory" : "Reading its memory", detail: null };
    case "memory_write":
      return { verb: input.team === true ? "Updating the team memory" : "Updating its memory", detail: null };
    case "set_profile":
      return { verb: "Updating its profile", detail: null };
    case "post_message":
      return { verb: "Posting a message", detail: null };
    case "run_with_secrets":
      return context.plain ? commandLine(input, home) : { verb: "Running", detail: typeof input.command === "string" ? short(input.command) : null };
    case "react":
      return { verb: "Reacting", detail: typeof input.emoji === "string" ? input.emoji : null };
    case "create_image":
      return { verb: "Making a picture", detail: short(input.prompt) };
    case "send_file": {
      const file = fileOf(input);
      return { verb: "Sending", detail: file ? short(baseName(file)) : null };
    }
    case "list_bots":
      return { verb: "Listing bots", detail: null };
    case "message_bot":
      return { verb: "Messaging", detail: short(input.bot) };
    case "delegate_bot":
      return { verb: "Delegating to", detail: short(input.bot) };
    case "ask_bot":
      return { verb: "Asking", detail: short(input.bot) };
    case "create_bot":
      return { verb: "Creating a bot", detail: short(input.name) };
    case "update_bot":
      return { verb: "Updating a bot", detail: short(input.bot) };
    case "create_room":
      return { verb: "Creating a room", detail: short(input.name) };
    case "list_handoffs":
      return { verb: "Listing handoffs", detail: null };
    case "cancel_handoff":
      return { verb: "Cancelling a handoff", detail: null };
    case "amend_handoff":
      return { verb: "Updating a handoff", detail: null };
    case "use_skill": {
      const slug = short(input.slug ?? input.name);
      return { verb: slug ? `Using the ${slug} skill` : "Using a skill", detail: null };
    }
    case "save_skill":
      return { verb: "Saving a skill", detail: short(input.name) };
    case "update_skill":
      return { verb: "Updating a skill", detail: short(input.name ?? input.slug) };
    case "connect_app":
      return { verb: "Connecting", detail: short(input.app) };
    case "add_mcp_server":
      return { verb: "Adding an MCP server", detail: short(input.name) };
    case "list_routines":
      return { verb: "Listing routines", detail: null };
    case "create_routine":
    case "update_routine":
    case "delete_routine":
    case "run_routine":
      return { verb: `${gerund(tool.split("_")[0]!).replace(/^./, (c) => c.toUpperCase())} a routine`, detail: short(input.name ?? input.routine) };
    case "follow_up":
      return { verb: "Setting a follow-up", detail: null };
    case "read_conversation":
      return { verb: "Reading a conversation", detail: null };
    case "search_messages": {
      const query = quoted(input.query);
      return { verb: "Searching messages", detail: query ? `for ${query}` : null };
    }
    case "request_secret":
    case "set_composio_key":
      return { verb: "Requesting a secret", detail: short(input.name) };
    case "list_secrets":
      return { verb: "Listing secrets", detail: null };
    case "forget_secret":
      return { verb: "Deleting a secret", detail: short(input.name) };
    case "request_login":
      return { verb: "Requesting a sign-in", detail: short(input.site) ? `to ${short(input.site)}` : null };
    case "list_details":
      return { verb: "Looking at your details", detail: null };
    case "use_details":
      return { verb: "Getting your details ready", detail: short(input.site) ? `for ${short(input.site)}` : null };
    case "save_details":
      return { verb: "Saving your details", detail: short(input.record) };
    case "list_triggers":
      return { verb: "Looking up what can start a routine", detail: short(input.app) ? `in ${short(input.app)}` : null };
    case "ask_approval":
      return { verb: "Requesting approval", detail: null };
    case "send_screenshot":
      return { verb: "Showing the screen", detail: null };
    case "hand_over":
      return { verb: "Handing over the screen", detail: null };
    case "computer":
    case "browser":
      return screenLabel(name, input);
    case "present_products":
      return { verb: "Showing products", detail: null };
    case "get_shopping_context":
      return { verb: "Looking at the order", detail: null };
    case "prepare_checkout":
      return { verb: "Checking the final total", detail: null };
    case "submit_checkout":
      return { verb: "Placing the order", detail: null };
    case "record_order":
      return { verb: "Saving the order", detail: null };
    case "record_shipment":
      return { verb: "Updating the delivery", detail: null };
    case "finish_order_check":
      return { verb: "Finishing a delivery check", detail: null };
    case "resolve_checkout_failure":
      return { verb: "Noting the checkout didn't go through", detail: null };
    default:
      break;
  }
  if (COMPOSIO_ACTION.test(tool)) {
    const at = tool.indexOf("_");
    return { verb: `${toolkitName(tool.slice(0, at))}:`, detail: humanise(tool.slice(at + 1), "gerund") };
  }
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) return { verb: `${serverName(mcp[1]!, context.servers)}:`, detail: humanise(mcpAction(mcp[1]!, mcp[2]!), "gerund") };
  return { verb: "Working", detail: null };
}

export function toolLine(label: ToolLabel | null): string | null {
  if (!label) return null;
  return label.detail ? `${label.verb} ${label.detail}` : label.verb;
}

export function approvalLine(name: string, input: Record<string, unknown> = {}, context: ToolLabelContext = {}): string {
  const tool = bareToolName(name);
  const home = context.home ?? null;
  switch (tool) {
    case "Bash": {
      const command = short(input.command, 300);
      return command ? `run \`${command}\`` : "run a command";
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = shownPath(fileOf(input), home);
      return path ? `change ${path}` : "change a file";
    }
    case "Write": {
      const path = shownPath(fileOf(input), home);
      return path ? `write ${path}` : "write a file";
    }
    case "Read":
    case "NotebookRead": {
      const path = shownPath(fileOf(input), home);
      return path ? `read ${path}` : "read a file";
    }
    case "WebFetch": {
      const host = hostOf(input.url);
      return host ? `open ${host}` : "open a page";
    }
    case "WebSearch": {
      const query = quoted(input.query);
      return query ? `search the web for ${query}` : "search the web";
    }
    case "computer":
      return "use the computer";
    case "request_login": {
      const site = short(input.site);
      return site ? `sign in to ${site} with your saved details` : "sign in with your saved details";
    }
    case "forget_secret": {
      const name = short(input.name);
      return name ? `delete the secret ${name}` : "delete a secret";
    }
    case "use_details": {
      const site = short(input.site);
      return site ? `type your details on ${site}` : "type your details";
    }
    case "save_details": {
      const record = short(input.record);
      return record ? `save ${record} to your details` : "save to your details";
    }
    case "ask_approval": {
      const summary = short(input.summary ?? input.action ?? input.text, 300);
      return summary ?? "go on";
    }
    default:
      break;
  }
  if (COMPOSIO_ACTION.test(tool)) {
    const at = tool.indexOf("_");
    return `${toolkitName(tool.slice(0, at))}: ${humanise(tool.slice(at + 1), "infinitive")}`;
  }
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) return `${serverName(mcp[1]!, context.servers)}: ${humanise(mcpAction(mcp[1]!, mcp[2]!), "infinitive")}`;
  return `use ${tool}`;
}

export function ruleLabel(rule: string, context: ToolLabelContext = {}): string {
  const prefix = /^Bash\((.+):\*\)$/.exec(rule);
  if (prefix) return `${prefix[1]} commands`;
  const folder = /^(\w+)\((.+)\/\*\*\)$/.exec(rule);
  if (folder) {
    const where = folder[2] === "." ? "its own folder" : `${shownPath(folder[2], context.home) ?? folder[2]}/`;
    return folder[2] === "." ? `changes in ${where}` : `changes under ${where}`;
  }
  if (rule === "Bash") return "any command";
  if (rule === "computer") return "the computer";
  if (rule === "request_login") return "your saved sign-ins";
  if (rule === "save_details") return "saving your details";
  if (rule === "WebFetch") return "opening pages";
  if (rule === "Edit" || rule === "Write" || rule === "MultiEdit" || rule === "NotebookEdit") return "changing files";
  if (COMPOSIO_ACTION.test(rule)) {
    const at = rule.indexOf("_");
    return `${toolkitName(rule.slice(0, at))}: ${humanise(rule.slice(at + 1), "infinitive")}`;
  }
  const mcp = MCP_TOOL.exec(rule);
  if (mcp) return `${serverName(mcp[1]!, context.servers)}: ${humanise(mcpAction(mcp[1]!, mcp[2]!), "infinitive")}`;
  return rule;
}

export function isQuietTool(name: string, input: Record<string, unknown> = {}): boolean {
  const tool = bareToolName(name);
  if (tool === "memory_update" || tool === "team_memory_update" || tool === "memory_read" || tool === "memory_write") return true;
  if (tool !== "Read" && tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit" && tool !== "NotebookEdit") return false;
  const file = fileOf(input);
  if (!file) return false;
  return baseName(file) === "MEMORY.md" || /\/\.bots\/[^/]+\/memory\//.test(`/${file}`);
}
