import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgedSession, EXIT_GRACE_MS, IDLE_MS, MAX_STDERR, ReplyText, killTree, systemReminder } from "./bridge.mjs";
import { CLAUDE_BIN, writeSystemPrompt } from "./claude.mjs";

export { IDLE_MS, systemReminder };

const MAX_LINE = 4 * 1024 * 1024;

export const FLAG_FLOORS = {
  "--input-format": "1.0.0",
  "--strict-mcp-config": "1.0.30",
  "--setting-sources": "1.0.100",
  "--max-turns": "1.0.0",
  "--replay-user-messages": "1.0.0",
};

const OPTIONAL_FLAGS = ["--strict-mcp-config", "--setting-sources", "--replay-user-messages"];

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
  const smallModel = typeof value.smallModel === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(value.smallModel) ? value.smallModel : null;
  return { kind: "api", baseUrl, token, smallModel };
}

export function claudeAccessEnv(access) {
  if (access?.kind !== "api") return {};
  return {
    ANTHROPIC_BASE_URL: access.baseUrl,
    ANTHROPIC_AUTH_TOKEN: access.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",

    ...(access.smallModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: access.smallModel, ANTHROPIC_SMALL_FAST_MODEL: access.smallModel } : {}),
  };
}

export const PERMISSION_MODES = ["ask", "full"];

export const SCREEN_SCRIPTING_DENIED = ["Bash(xdotool:*)", "Bash(ydotool:*)", "Bash(wtype:*)"];

export function sessionArgs({ model, maxTurns, systemPromptFile, mcpConfigFile, permission = "ask", sessionId, resume, allowed, optional = true }) {
  const has = (flag) => optional && allowed.has(flag);
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--model", model];
  if (maxTurns && allowed.has("--max-turns")) args.push("--max-turns", String(maxTurns));
  if (permission === "full" || !mcpConfigFile) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "default");
    args.push("--permission-prompt-tool", "mcp__gond__permission");
  }
  // Screen input goes through the gond browser and computer tools, never a shell; deny rules hold even when permissions are skipped.
  args.push("--disallowedTools", ...SCREEN_SCRIPTING_DENIED);
  args.push("--append-system-prompt-file", systemPromptFile);
  if (mcpConfigFile) {
    args.push("--mcp-config", mcpConfigFile, "--allowedTools", "mcp__gond");
    if (has("--strict-mcp-config")) args.push("--strict-mcp-config");
  }
  if (has("--setting-sources")) args.push("--setting-sources", "project");

  if (has("--replay-user-messages")) args.push("--replay-user-messages");
  args.push(resume ? "--resume" : "--session-id", sessionId);
  return args;
}

export function argsKeyFor({ model, maxTurns, toolNames, permission, mcpServers = [], access = { kind: "plan" } }) {
  return createHash("sha256").update(JSON.stringify({ model, maxTurns: maxTurns ?? null, toolNames, permission: permission ?? "ask", mcpServers, access })).digest("hex").slice(0, 16);
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
  return {
    ok: event.is_error !== true,
    text: typeof event.result === "string" ? event.result : "",
    stopReason: event.stop_reason ?? event.terminal_reason ?? null,
  };
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

  async ensure({ model, maxTurns, systemPrompt, tools, permission = "ask", mcpServers = [], access = { kind: "plan" } }) {
    const toolNames = tools.map((tool) => tool.name).sort();
    const argsKey = argsKeyFor({ model, maxTurns, toolNames, permission, mcpServers: mcpServersConfig(mcpServers), access });
    this.tools = tools;
    if (this.running && this.argsKey === argsKey) return { launched: false };
    if (this.running) await this.close({ keepSession: true });
    this.launchEnv = { ...this.env, ...claudeAccessEnv(access) };

    const version = claudeVersion({ bin: this.bin, env: this.env, uid: this.uid, gid: this.gid });
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
        sessionArgs({ model, maxTurns, systemPromptFile: persona.file, mcpConfigFile: mcp.file, permission, sessionId, resume, allowed, optional }),
        { resume },
      );
    let outcome = await launch(true);
    if (outcome.failed && isUnknownOption(outcome.stderr)) {
      this.onWarning(`Claude Code rejected an optional flag (${outcome.stderr.trim().slice(0, 120)}); relaunching without ${OPTIONAL_FLAGS.join(", ")}.`);
      outcome = await launch(false);
    }
    if (outcome.failed) throw new Error(`Claude Code didn't start: ${outcome.stderr.trim().slice(0, 300) || "no output"}`);
    this.replays = outcome.replays;
    this.argsKey = argsKey;
    this.sessionId = sessionId;
    return { launched: true, resumed: resume };
  }

  spawn(args, { resume }) {
    this.stderr = "";
    this.sawInit = false;
    this.resume = resume;
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
      const turn = this.turn;
      this.child = null;
      if (turn) {
        this.turn = null;
        turn.finish({
          ok: false,
          text: "",
          stopReason: turn.interrupted ? "interrupted" : "exited",
          error: turn.interrupted ? "The turn was interrupted" : this.stderr.trim().slice(0, 500) || `Claude Code exited (${signal ?? code})`,
          resumeFailed: isResumeFailure({ resume: this.resume, sawInit: this.sawInit, stderr: this.stderr, exitCode: code }),
        });
      }
      this.cleanup();
    });
    return new Promise((resolve) => {
      const settleLaunch = (failed) => resolve({ failed, stderr: this.stderr, replays: args.includes("--replay-user-messages") });
      child.once("error", (error) => {
        this.stderr = error.message;
        this.child = null;
        settleLaunch(true);
      });
      child.once("close", () => settleLaunch(true));

      setTimeout(() => {
        if (this.child === child && child.exitCode === null) settleLaunch(false);
      }, 1_500);
    });
  }

  onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
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
    if (!this.turn) return;

    if (event.parent_tool_use_id) return;
    if (isReplay(event)) {
      if (!this.turn.promptRead) this.turn.promptRead = true;
      else this.turn.unread = Math.max(0, this.turn.unread - 1);
      return;
    }
    const result = settle(event);
    if (result) {
      const turn = this.turn;

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
