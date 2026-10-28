import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const IDLE_MS = Math.max(30_000, Number(process.env.BOT_IDLE_MS) || 10 * 60 * 1000);

export const EXIT_GRACE_MS = 5_000;

export const MAX_STDERR = 4_000;

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function systemReminder(text) {
  return `<system-reminder>\nThis part of your instructions changed since this session started. It replaces the earlier copy:\n\n${text}\n</system-reminder>\n\n`;
}

export function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

function protocolLogger(dir, id) {
  if (!dir) return () => undefined;
  const file = path.join(dir, `${id}.ndjson`);
  return (direction, payload) => {
    try {
      fs.mkdirSync(dir, { recursive: true });

      if (fs.realpathSync(dir) !== path.resolve(dir)) return;
      try {
        if (fs.lstatSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no file yet */
      }
      const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
      const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), direction, payload })}\n`);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* logging never breaks a turn */
    }
  };
}

const MAX_RESULT_IMAGE_BYTES = 3 * 1024 * 1024;
const RESULT_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function toolResultContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value ?? "");
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (!value.length) throw fail("A tool result needs at least one part");
  return value.map((part) => {
    if (!part || typeof part !== "object") throw fail("Each part must be an object");
    if (part.type === "text") {
      if (typeof part.text !== "string") throw fail("A text part needs text");
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      if (typeof part.data !== "string" || !part.data || !BASE64.test(part.data)) throw fail("An image part needs base64 data");
      if (!RESULT_IMAGE_TYPES.has(part.mimeType)) throw fail("An image part must be image/png or image/jpeg");
      if (Math.floor((part.data.length * 3) / 4) > MAX_RESULT_IMAGE_BYTES) throw fail("An image part is larger than 3 MB");
      return { type: "image", data: part.data, mimeType: part.mimeType };
    }
    throw fail(`Unknown part type ${JSON.stringify(part.type)}`);
  });
}

export function permissionDecision(answer) {
  if (!answer || answer.isError) return { allow: false, message: typeof answer?.content === "string" ? answer.content : "No answer" };
  try {
    const parsed = JSON.parse(typeof answer.content === "string" ? answer.content : JSON.stringify(answer.content));
    return { allow: parsed?.behavior === "allow", message: typeof parsed?.message === "string" ? parsed.message : "" };
  } catch {
    return { allow: false, message: "Unreadable answer" };
  }
}

export class ReplyText {
  segments = [""];

  chunk(text) {
    this.segments[this.segments.length - 1] += text;
  }

  block(text) {
    if (!text.trim()) return;
    const last = this.segments.length - 1;
    this.segments[last] = this.segments[last].trim() ? `${this.segments[last].trimEnd()}\n\n${text.trim()}` : text;
  }

  tool() {
    if (this.segments[this.segments.length - 1].trim()) this.segments.push("");
  }

  current() {
    return this.segments[this.segments.length - 1];
  }

  text() {
    const after = this.current().trim();
    if (after) return after;
    return this.segments.map((s) => s.trim()).filter(Boolean).join("\n\n");
  }
}

export class BridgedSession {
  constructor(options) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.baseEnv = options.env;
    this.uid = options.uid;
    this.gid = options.gid;
    this.socketDir = options.socketDir;
    this.mcpScript = options.mcpScript;
    this.log = protocolLogger(options.logDir, options.id);
    this.onWarning = options.onWarning ?? (() => undefined);
    this.child = null;
    this.sessionId = null;
    this.argsKey = null;
    this.systemPromptHash = null;
    this.turn = null;
    this.idleTimer = null;
    this.bridge = null;
    this.tools = [];
    this.stderr = "";
    this.pendingCalls = new Map();
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  bridgeTools() {
    return this.tools;
  }

  async listen() {
    if (this.bridge) return this.bridge.path;
    fs.mkdirSync(this.socketDir, { recursive: true, mode: 0o755 });
    const socketPath = path.join(this.socketDir, `${this.id}.sock`);
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          if (line.trim()) void this.onBridgeMessage(socket, line);
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    if (this.uid !== undefined) fs.chownSync(socketPath, this.uid, this.gid);
    fs.chmodSync(socketPath, 0o600);
    this.bridge = { server, path: socketPath };
    return socketPath;
  }

  async onBridgeMessage(socket, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.log("mcp", message);
    const answer = (result, error) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(error ? { id: message.id, error } : { id: message.id, result })}\n`);
    };
    if (message.method === "tools/list") {
      answer({ tools: this.bridgeTools() });
      return;
    }
    if (message.method === "tools/call") {
      if (!this.turn) {
        answer(null, "No turn in flight");
        return;
      }
      const callId = randomUUID();
      this.pendingCalls.set(callId, answer);
      this.turn.onEvent({ type: "tool_call", callId, name: message.params?.name, input: message.params?.arguments ?? {} });
      return;
    }
    answer(null, `Unknown method ${message.method}`);
  }

  answerTool(callId, { content, isError = false }) {
    const answer = this.pendingCalls.get(callId);
    if (!answer) return false;
    this.pendingCalls.delete(callId);
    answer({ content, isError });
    return true;
  }

  askPermission(tool, input) {
    if (!this.turn) return Promise.resolve({ allow: false, message: "No turn in flight" });
    const callId = randomUUID();
    return new Promise((resolve) => {
      this.pendingCalls.set(callId, (result, error) => resolve(error ? { allow: false, message: String(error) } : permissionDecision(result)));
      this.turn.onEvent({ type: "tool_call", callId, name: "permission", input: { tool_name: tool, input } });
    });
  }

  dropPendingCalls() {
    for (const answer of this.pendingCalls.values()) {
      try {
        answer(null, "The turn ended");
      } catch {
        /* the socket is gone */
      }
    }
    this.pendingCalls.clear();
  }

  armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.close({ keepSession: true }), IDLE_MS);
    this.idleTimer.unref?.();
  }

  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async closeBridge() {
    if (!this.bridge) return;
    const { server, path: socketPath } = this.bridge;
    this.bridge = null;
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(socketPath, { force: true });
  }

  async stopChild() {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* closed */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        killTree(child, "SIGKILL");
        resolve();
      }, EXIT_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      killTree(child, "SIGTERM");
    });
  }
}
