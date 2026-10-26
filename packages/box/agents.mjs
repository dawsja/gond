import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgedSession, EXIT_GRACE_MS, IDLE_MS, MAX_STDERR, ReplyText, killTree, systemReminder } from "./bridge.mjs";
import { CLAUDE_BIN, NOT_SIGNED_IN, writeSystemPrompt } from "./claude.mjs";

export { IDLE_MS, systemReminder };

const MAX_LINE = 4 * 1024 * 1024;

export const FLAG_FLOORS = {
  "--input-format": "1.0.0",
  "--strict-mcp-config": "1.0.30",
  "--setting-sources": "1.0.100",
  "--max-turns": "1.0.0",
  "--replay-user-messages": "1.0.0",
  "--include-partial-messages": "1.0.90",
};

const OPTIONAL_FLAGS = ["--strict-mcp-config", "--setting-sources", "--replay-user-messages", "--include-partial-messages"];

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version, floor) {
  const want = parseVersion(floor);
  if (!version || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > want[i]) return true;
    if (version[i] < want[i]) return false;
  }
  return true;
}

export function flagsFor(version) {
  const allowed = new Set();
  for (const [flag, floor] of Object.entries(FLAG_FLOORS)) {
    if (!version || atLeast(version, floor)) allowed.add(flag);
  }
  return allowed;
}

let cachedVersion;

export function forgetClaudeVersion() {
  cachedVersion = undefined;
}

export function claudeVersion({ bin = CLAUDE_BIN, env, uid, gid } = {}) {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const result = spawnSync(bin, ["--version"], { env, uid, gid, encoding: "utf8", timeout: 15_000 });
    cachedVersion = parseVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

export const CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

export function stripCredentialEnv(env) {
  const clean = { ...env };
  for (const name of CREDENTIAL_ENV) delete clean[name];
  return clean;
}

export function parseAccess(value) {
  if (!value || value.kind !== "api") return { kind: "plan" };
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : "";
  const token = typeof value.token === "string" ? value.token : "";
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl) || !/^[A-Za-z0-9_-]{16,200}$/.test(token)) return { kind: "plan" };
  const smallModel = typeof value.smallModel === "string" && /^[A-Za-z0-9._:/-]{1,120}(?:\[1m\])?$/.test(value.smallModel) ? value.smallModel : null;
  return { kind: "api", baseUrl, token, smallModel };
}

export function claudeAccessEnv(access) {
  if (access?.kind !== "api") return {};
  return {
    ANTHROPIC_BASE_URL: access.baseUrl,
    ANTHROPIC_AUTH_TOKEN: access.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",

    // Every tier and sub-agent, since a key that isn't Anthropic's knows none of Claude's names.
    ...(access.smallModel
      ? Object.fromEntries(["ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"].map((name) => [name, access.smallModel]))
      : {}),
  };
}

export const PERMISSION_MODES = ["ask", "full"];

export const SCREEN_SCRIPTING_DENIED = ["Bash(xdotool:*)", "Bash(ydotool:*)", "Bash(wtype:*)"];

/**
 * A guest session answers a line from someone on another Gond (Spaces): with no tools at all ("talk"),
 * or with only web search ("look"). `--tools` is what takes the rest away, so a Claude Code too old
 * for it, or one whose version can't be read, never runs one; the deny list and an empty working
 * folder are a second fence, since an untrusted line must never reach the owner's files, shell or
 * memory. WebFetch is never a guest's: it reaches any address the box can, the Compose network and
 * the cloud's metadata service included.
 */
export const GUEST_MODES = ["talk", "look"];
export const GUEST_FLOOR = "2.0.30";
const GUEST_WEB = ["WebSearch"];
const GUEST_DENIED = ["WebFetch", "Bash", "BashOutput", "KillShell", "PowerShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "Task", "Agent", "TodoWrite", "Skill", "SlashCommand", "ExitPlanMode", "ListMcpResourcesTool", "ReadMcpResourceTool", "LSP", "Monitor"];

export function guestReady(version) {
  return Boolean(version) && atLeast(version, GUEST_FLOOR);
}

export function guestRefusal(version) {
  return version
    ? `Claude Code ${version.join(".")} on the computer is too old to answer in spaces. Update the computer and try again.`
    : "Couldn't tell which Claude Code the computer has, so it won't answer in spaces. Update the computer and try again.";
}

export function sessionArgs({ model, maxTurns, systemPromptFile, mcpConfigFile, permission = "ask", sessionId, resume, allowed, optional = true, guest = null }) {
  const has = (flag) => optional && allowed.has(flag);
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--model", model];
  if (maxTurns && allowed.has("--max-turns")) args.push("--max-turns", String(maxTurns));
  if ((permission === "full" && !guest) || !mcpConfigFile) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "default");
    args.push("--permission-prompt-tool", "mcp__gond__permission");
  }
  if (guest) args.push("--tools", guest === "look" ? GUEST_WEB.join(",") : "");
  // Screen input goes through the gond browser and computer tools, never a shell; deny rules hold even when permissions are skipped.
  args.push("--disallowedTools", ...SCREEN_SCRIPTING_DENIED, ...(guest ? GUEST_DENIED : []), ...(guest === "talk" ? GUEST_WEB : []));
  args.push("--append-system-prompt-file", systemPromptFile);
  if (mcpConfigFile) {
    args.push("--mcp-config", mcpConfigFile, "--allowedTools", "mcp__gond", ...(guest === "look" ? GUEST_WEB : []));
    if (has("--strict-mcp-config") || (guest && allowed.has("--strict-mcp-config"))) args.push("--strict-mcp-config");
  }
  // A guest never loads settings or CLAUDE.md from the person's own folders.
  if (has("--setting-sources") || (guest && allowed.has("--setting-sources"))) args.push("--setting-sources", "project");

  if (has("--replay-user-messages")) args.push("--replay-user-messages");
  if (has("--include-partial-messages")) args.push("--include-partial-messages");
  args.push(resume ? "--resume" : "--session-id", sessionId);
  return args;
}

export function argsKeyFor({ model, maxTurns, toolNames, permission, mcpServers = [], mcpRevs = [], access = { kind: "plan" }, guest = null }) {
  // Only a refreshed server adds its revision, and only a guest its mode, so other sessions keep the key they had.
  const revs = mcpRevs.some(Boolean) ? { mcpRevs } : {};
  const visitor = guest ? { guest } : {};
  return createHash("sha256").update(JSON.stringify({ model, maxTurns: maxTurns ?? null, toolNames, permission: permission ?? "ask", mcpServers, access, ...revs, ...visitor })).digest("hex").slice(0, 16);
}

export function mcpServersConfig(servers) {
  const out = {};
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || typeof server.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(server.name) || server.name === "gond") continue;
    if (server.type === "http" && typeof server.url === "string") {
      out[server.name] = { type: "http", url: server.url, headers: server.headers && typeof server.headers === "object" ? server.headers : {} };
    } else if (server.type === "stdio" && typeof server.command === "string" && server.command) {
      out[server.name] = { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: server.env && typeof server.env === "object" ? server.env : {} };
    }
  }
  return out;
}

export function settle(event) {
  if (!event || event.type !== "result") return null;
  if (event.origin?.kind === "task-notification") return null;
  const ok = event.is_error !== true;
  const text = typeof event.result === "string" ? event.result : "";
  const stopReason = event.stop_reason ?? event.terminal_reason ?? null;
  if (ok) return { ok, text, stopReason };
  // A signed-out CLI says so only in the result's text ("Not logged in · Please run /login").
  return { ok, text, stopReason, ...(text.trim() ? { error: text.trim().slice(0, 500) } : {}), signedOut: NOT_SIGNED_IN.test(text) };
}

const TOKEN_FIELDS = { input: "inputTokens", output: "outputTokens", cacheRead: "cacheReadInputTokens", cacheWrite: "cacheCreationInputTokens" };

function tokensOf(entry) {
  return Object.fromEntries(Object.entries(TOKEN_FIELDS).map(([key, field]) => [key, Number.isFinite(entry?.[field]) ? Math.max(0, entry[field]) : 0]));
}

function perModel(map) {
  return map && typeof map === "object" ? Object.fromEntries(Object.entries(map).map(([model, entry]) => [model, tokensOf(entry)])) : null;
}

const spent = (tokens) => Object.values(tokens).some((n) => n > 0);

/**
 * The tokens a result's calls used, per model, and the running totals to compare the next result with.
 * `model_usage_since_last_result` says it outright; an older CLI only has `modelUsage`, a running total
 * per process, so the change since the last result is taken (a resumed process's first total holds the
 * turns before it, so it is only the baseline).
 */
export function usageSince(event, counted, resumed = false) {
  const totals = perModel(event?.modelUsage) ?? counted;
  let used = perModel(event?.model_usage_since_last_result);
  if (!used) {
    if (!totals) used = {};
    else if (!counted) used = resumed ? {} : totals;
    else {
      used = {};
      for (const [model, now] of Object.entries(totals)) {
        const before = counted[model];
        // A total that went down was reset (a /clear): what it holds now is all new.
        const reset = before && Object.keys(now).some((key) => now[key] < before[key]);
        used[model] = before && !reset ? Object.fromEntries(Object.keys(now).map((key) => [key, now[key] - before[key]])) : now;
      }
    }
  }
  return { used: Object.fromEntries(Object.entries(used).filter(([, tokens]) => spent(tokens))), counted: totals };
}

export function addUsage(a, b) {
  const out = { ...a };
  for (const [model, tokens] of Object.entries(b)) {
    const had = out[model];
    out[model] = had ? Object.fromEntries(Object.keys(tokens).map((key) => [key, (had[key] ?? 0) + tokens[key]])) : tokens;
  }
  return out;
}

const PLAN_WINDOWS = { five_hour: "session", seven_day: "weekly" };

/**
 * How much of a Claude plan's windows is used, from a `rate_limit_event` (the plan's own response headers;
 * absent on a key): the share used, 0 to 1, and when each window starts again.
 */
export function planLimits(event) {
  if (event?.type !== "rate_limit_event") return null;
  const info = event.rate_limit_info ?? {};
  const windows = { ...(info.unifiedWindows ?? {}) };
  if (!Object.keys(windows).length && PLAN_WINDOWS[info.rateLimitType]) windows[info.rateLimitType] = info;
  const out = {};
  for (const [key, name] of Object.entries(PLAN_WINDOWS)) {
    const window = windows[key];
    if (!Number.isFinite(window?.utilization) || !Number.isFinite(window?.resetsAt)) continue;
    out[name] = { used: Math.max(0, window.utilization), resetsAt: new Date(window.resetsAt * 1000).toISOString() };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A provider's refusal on an API key, which Claude Code would otherwise retry for minutes in silence:
 * a refused key or an unknown model or address won't heal by asking again.
 */
export function keyRefusal(event) {
  if (event?.type !== "system" || event.subtype !== "api_retry") return null;
  if (event.error_status === 401 || event.error_status === 403) return "The provider turned down your API key. Check the key and its address under Settings → AI.";
  if (event.error_status === 404) return "The provider doesn't know that model or address. Check both under Settings → AI.";
  return null;
}

/**
 * The model service a session's history was made on. A session never resumes on another: Claude can't
 * read another's thinking, and a model that doesn't know its context size would compact the lot first.
 */
export function backendOf(access) {
  if (access?.kind !== "api") return "plan";
  return `api:${createHash("sha256").update(`${access.baseUrl}\n${access.token}`).digest("hex").slice(0, 16)}`;
}

/** What Claude Code is busy with that it doesn't otherwise say, as the turn's activity line. */
export function statusLine(event) {
  return event?.type === "system" && event.subtype === "status" && event.status === "compacting" ? "Summarizing the conversation so far" : null;
}

/** A retry Claude Code would otherwise keep to itself, as the turn's activity line. */
export function retryLine(event) {
  if (event?.type !== "system" || event.subtype !== "api_retry") return null;
  const count = Number.isFinite(event.attempt) && Number.isFinite(event.max_retries) ? ` (${event.attempt} of ${event.max_retries})` : "";
  const why = event.error_status === 429 ? "The model's API is busy or the plan's limit is reached" : "The model's API didn't answer";
  return `${why}, trying again${count}`;
}

/**
 * The words of a reply as the model writes them, from the CLI's partial messages: a delta of text,
 * or the end of the text so far when a tool call starts (that text was narration, not the reply).
 */
export function streamText(event) {
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") return { type: "text_delta", text: event.delta.text };
  if (event?.type === "content_block_start" && /tool_use$/.test(event.content_block?.type ?? "")) return { type: "text_end" };
  return null;
}

export function readReply(reply, event) {
  const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") reply.block(block.text);
    else if (block?.type === "tool_use") reply.tool();
  }
}

/** The CLI's echo of a message it read from stdin (with --replay-user-messages), not a tool result. */
export function isReplay(event) {
  if (event?.type !== "user" || event.isReplay !== true) return false;
  const content = event.message?.content;
  return !(Array.isArray(content) && content.some((block) => block?.type === "tool_result"));
}

export const STEER_FOLLOW_MS = 5_000;

export function isResumeFailure({ resume, sawInit, stderr, exitCode }) {
  if (!resume || sawInit || exitCode === 0) return false;
  return /no conversation found|session.*(not found|does not exist|invalid)|could not resume|resume/i.test(stderr ?? "");
}

export function isUnknownOption(stderr) {
  return /unknown option|unrecognized option|unknown argument|too many arguments/i.test(stderr ?? "");
}

export function userMessage(prompt, images = []) {
  const blocks = images.flatMap((file) => {
    if (!file || typeof file.data !== "string" || typeof file.mediaType !== "string") return [];
    const source = { type: "base64", media_type: file.mediaType, data: file.data };
    if (file.mediaType === "application/pdf") {
      return [{ type: "document", source, ...(typeof file.name === "string" ? { title: file.name } : {}) }];
    }
    return file.mediaType.startsWith("image/") ? [{ type: "image", source }] : [];
  });
  if (!blocks.length) return { type: "user", message: { role: "user", content: prompt } };
  return { type: "user", message: { role: "user", content: [...blocks, { type: "text", text: prompt }] } };
}

export function loggable(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return message;
  return { ...message, message: { ...message.message, content: content.map(withoutData) } };
}

function withoutData(block) {
  if (!block || typeof block !== "object") return block;
  if (block.source?.data) return { ...block, source: { ...block.source, data: `[${block.source.data.length} base64 characters]` } };
  if (block.type === "tool_result" && Array.isArray(block.content)) return { ...block, content: block.content.map(withoutData) };
  return block;
}

export class AgentSession extends BridgedSession {
  constructor(options) {
    super(options);
    this.engine = "claude";
    this.env = stripCredentialEnv(options.env);
    this.launchEnv = this.env;
    this.bin = options.bin ?? CLAUDE_BIN;
    this.cleanups = [];
    this.sawInit = false;
  }

  writeMcpConfig(socketPath, servers = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-mcp-"));
    const file = path.join(dir, "mcp.json");
    const config = { mcpServers: { gond: { command: process.execPath, args: [this.mcpScript, socketPath] }, ...mcpServersConfig(servers) } };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    if (this.uid !== undefined) {
      fs.chownSync(dir, this.uid, this.gid);
      fs.chownSync(file, this.uid, this.gid);
    }
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  async ensure({ model, maxTurns, systemPrompt, tools, permission = "ask", mcpServers = [], access = { kind: "plan" }, guest = null }) {
    if (guest) {
      tools = [];
      mcpServers = [];
      permission = "ask";
    }
    const toolNames = tools.map((tool) => tool.name).sort();
    const mcpRevs = (Array.isArray(mcpServers) ? mcpServers : []).map((server) => (typeof server?.rev === "string" ? server.rev : null));
    const argsKey = argsKeyFor({ model, maxTurns, toolNames, permission, mcpServers: mcpServersConfig(mcpServers), mcpRevs, access, guest });
    this.tools = tools;
    const backend = backendOf(access);
    if (this.backend && this.backend !== backend) {
      if (this.running) await this.close({ keepSession: false });
      this.sessionId = null;
    }
    this.backend = backend;
    if (this.running && this.argsKey === argsKey) return { launched: false };
    if (this.running) await this.close({ keepSession: true });
    this.launchEnv = { ...this.env, ...claudeAccessEnv(access) };
    this.access = access;

    const version = claudeVersion({ bin: this.bin, env: this.env, uid: this.uid, gid: this.gid });
    if (guest && !guestReady(version)) throw new Error(guestRefusal(version));
    const allowed = flagsFor(version);
    for (const flag of Object.keys(FLAG_FLOORS)) {
      if (!allowed.has(flag)) this.onWarning(`Claude Code ${version?.join(".") ?? "?"} predates ${flag}; bots run without it.`);
    }
    const socketPath = await this.listen();
    const persona = writeSystemPrompt(systemPrompt, { uid: this.uid, gid: this.gid });
    const mcp = this.writeMcpConfig(socketPath, mcpServers);
    this.cleanups = [persona.cleanup, mcp.cleanup];
    this.systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex");

    const resume = Boolean(this.sessionId);
    const sessionId = this.sessionId ?? randomUUID();
    const launch = (optional) =>
      this.spawn(
        sessionArgs({ model, maxTurns, systemPromptFile: persona.file, mcpConfigFile: mcp.file, permission, sessionId, resume, allowed, optional, guest }),
        { resume },
      );
    const outcome = await launch(!this.withoutOptional);
    if (outcome.failed) {
      // The code (ENOENT, EACCES) is how the turn route tells a missing CLI from one that broke.
      const error = new Error(`Claude Code didn't start: ${outcome.stderr.trim().slice(0, 300) || "no output"}`);
      if (outcome.code) error.code = outcome.code;
      throw error;
    }
    this.replays = outcome.replays;
    this.argsKey = argsKey;
    this.sessionId = sessionId;
    return { launched: true, resumed: resume };
  }

  spawn(args, { resume }) {
    this.stderr = "";
    this.sawInit = false;
    this.resume = resume;
    this.counted = null;
    this.log("spawn", { args });
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: this.launchEnv,
      ...(this.uid !== undefined ? { uid: this.uid, gid: this.gid } : {}),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let pending = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line) this.onLine(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE) pending = pending.slice(-MAX_LINE);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
      this.log("stderr", chunk);
    });
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.log("exit", { code, signal, resume: this.resume, sawInit: this.sawInit });
      // The launch no longer waits to see the CLI take its flags, so one that refuses an optional flag
      // is caught here, and the turn route launches it again without them.
      const flagRejected = !this.sawInit && OPTIONAL_FLAGS.some((flag) => args.includes(flag)) && isUnknownOption(this.stderr);
      if (flagRejected) {
        this.withoutOptional = true;
        this.flagRejected = true;
        this.onWarning(`Claude Code rejected an optional flag (${this.stderr.trim().slice(0, 120)}); relaunching without ${OPTIONAL_FLAGS.join(", ")}.`);
      }
      const turn = this.turn;
      this.child = null;
      if (turn) {
        this.turn = null;
        turn.finish({
          ok: false,
          text: "",
          stopReason: turn.refused ? "refused" : turn.interrupted ? "interrupted" : "exited",
          error: turn.refused ?? (turn.interrupted ? "The turn was interrupted" : this.stderr.trim().slice(0, 500) || `Claude Code exited (${signal ?? code})`),
          resumeFailed: isResumeFailure({ resume: this.resume, sawInit: this.sawInit, stderr: this.stderr, exitCode: code }),
          flagRejected,
        });
      }
      this.cleanup();
    });
    return new Promise((resolve) => {
      const settleLaunch = (failed, code) => resolve({ failed, code, stderr: this.stderr, replays: args.includes("--replay-user-messages") });
      child.once("error", (error) => {
        this.stderr = error.message;
        this.child = null;
        settleLaunch(true, error.code);
      });
      child.once("close", () => settleLaunch(true));
      // Written to stdin at once: the pipe holds the prompt until the CLI reads it.
      child.once("spawn", () => settleLaunch(false));
    });
  }

  onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "stream_event") {
      const text = this.turn && !event.parent_tool_use_id ? streamText(event.event) : null;
      if (text) this.turn.onEvent(text);
      return;
    }
    this.log("out", event.type === "user" ? loggable(event) : event);
    if (event.type === "system" && event.subtype === "init") {
      this.sawInit = true;

      if (this.turn?.held) {
        clearTimeout(this.turn.held.timer);
        this.turn.held = null;
      }

      if (typeof event.session_id === "string") this.sessionId = event.session_id;
      this.turn?.onEvent({ type: "init", sessionId: this.sessionId, permissionMode: event.permissionMode ?? null });
      return;
    }
    if (event.type === "result") this.countUsage(event);
    const limits = planLimits(event);
    if (limits) {
      this.turn?.onEvent({ type: "limits", limits });
      return;
    }
    if (!this.turn) return;

    // On the plan a 401 can be a sign-in being renewed, so only a key's refusal ends the turn here.
    const refused = this.access?.kind === "api" ? keyRefusal(event) : null;
    if (refused) {
      this.turn.refused = refused;
      this.kill();
      return;
    }
    const busy = retryLine(event) ?? statusLine(event);
    if (busy) {
      this.turn.onEvent({ type: "activity", line: busy });
      return;
    }
    if (event.parent_tool_use_id) return;
    if (isReplay(event)) {
      if (!this.turn.promptRead) this.turn.promptRead = true;
      else this.turn.unread = Math.max(0, this.turn.unread - 1);
      return;
    }
    const result = settle(event);
    if (result) {
      const turn = this.turn;
      // On a key a refusal is the key's (`keyRefusal`), never a sign-in on the computer.
      if (this.access?.kind === "api") delete result.signedOut;

      if (turn.unread > 0) {
        clearTimeout(turn.held?.timer);
        turn.held = { result, timer: setTimeout(() => this.finishTurn(turn, result), STEER_FOLLOW_MS) };
        return;
      }
      this.finishTurn(turn, result);
      return;
    }
    if (event.type === "assistant") readReply(this.turn.reply, event);
    this.turn.onEvent({ type: "line", line });
  }

  turnWith({ prompt, images, timeoutMs, onEvent, systemPrompt, signal }) {
    if (this.turn) return Promise.reject(new Error("A turn is already in flight"));
    if (!this.running) return Promise.reject(new Error("No session"));
    this.clearIdle();
    let text = prompt;
    const hash = createHash("sha256").update(systemPrompt).digest("hex");
    if (hash !== this.systemPromptHash) {
      text = systemReminder(systemPrompt) + prompt;
      this.systemPromptHash = hash;
    }
    return new Promise((resolve) => {
      const turn = {
        onEvent,
        interrupted: false,
        promptRead: false,

        unread: 0,
        held: null,
        reply: new ReplyText(),
        finish: (result) => {
          clearTimeout(timer);
          clearTimeout(turn.held?.timer);
          signal?.removeEventListener("abort", interrupt);
          this.dropPendingCalls();
          if (this.running) this.armIdle();
          resolve(result);
        },
      };
      const interrupt = () => {
        if (this.turn !== turn) return;
        turn.interrupted = true;
        this.kill();
      };
      const timer = setTimeout(interrupt, timeoutMs);
      if (signal?.aborted) {
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "interrupted", error: "Aborted before the turn started" });
        return;
      }
      signal?.addEventListener("abort", interrupt, { once: true });
      this.turn = turn;
      if (Object.keys(this.unreported ?? {}).length) {
        onEvent({ type: "usage", models: this.unreported });
        this.unreported = {};
      }
      const message = userMessage(text, images);
      this.log("in", loggable(message));
      const stdin = this.child.stdin;
      if (!stdin.writable || stdin.destroyed) {
        this.turn = null;
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "stdin_write_failed", error: "The CLI's stdin is closed" });
        void this.close();
        return;
      }
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error || this.turn !== turn) return;
        this.turn = null;
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "stdin_write_failed", error: error.message });
        void this.close();
      });
    });
  }

  /** What a result says was used goes to the turn running, or waits for the next one (a late subagent's result). */
  countUsage(event) {
    const { used, counted } = usageSince(event, this.counted, this.resume);
    this.counted = counted;
    this.unreported = addUsage(this.unreported ?? {}, used);
    if (this.turn && Object.keys(this.unreported).length) {
      this.turn.onEvent({ type: "usage", models: this.unreported });
      this.unreported = {};
    }
  }

  finishTurn(turn, result) {
    if (this.turn !== turn) return;
    this.turn = null;

    turn.finish({ ...result, text: turn.reply.text() || result.text });
  }

  async steer(text) {
    const turn = this.turn;
    const stdin = this.child?.stdin;
    if (!turn || turn.interrupted || !this.replays || !stdin?.writable || stdin.destroyed) return false;
    const message = userMessage(text);
    this.log("in", { steer: text.length });
    turn.unread += 1;
    return new Promise((resolve) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) turn.unread = Math.max(0, turn.unread - 1);
        resolve(!error);
      });
    });
  }

  kill() {
    const child = this.child;
    if (!child) return;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), EXIT_GRACE_MS).unref?.();
  }

  cleanup() {
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* already gone */
      }
    }
    this.cleanups = [];
  }

  async close({ keepSession = true } = {}) {
    this.clearIdle();
    await this.stopChild();
    this.child = null;
    this.cleanup();
    if (!keepSession) this.sessionId = null;
    await this.closeBridge();
  }
}

export function authStatus({ bin = CLAUDE_BIN, env, uid, gid } = {}) {
  try {
    const result = spawnSync(bin, ["auth", "status", "--json"], { env, uid, gid, encoding: "utf8", timeout: 10_000 });
    const text = `${result.stdout ?? ""}`.trim();
    const start = text.indexOf("{");
    if (start === -1) return { known: false, loggedIn: null };
    const data = JSON.parse(text.slice(start));
    const loggedIn = data.loggedIn ?? data.logged_in ?? data.isLoggedIn ?? null;
    return {
      known: typeof loggedIn === "boolean",
      loggedIn: typeof loggedIn === "boolean" ? loggedIn : null,
      email: typeof data.email === "string" ? data.email : (data.account?.email ?? null),
      org: typeof data.orgName === "string" ? data.orgName : (data.organization?.name ?? data.org ?? null),
      method: typeof data.method === "string" ? data.method : (data.authMethod ?? null),
    };
  } catch {
    return { known: false, loggedIn: null };
  }
}
