import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgedSession, MAX_STDERR, ReplyText, killTree, systemReminder } from "./bridge.mjs";
import { RpcPeer } from "./rpc.mjs";

export const CODEX_BIN = process.env.CODEX_BIN || "codex";

const SETUP_TIMEOUT_MS = 60_000;

const INTERRUPT_GRACE_MS = 10_000;

export const CODEX_CREDENTIAL_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "GOND_LLM_TOKEN"];

export function tomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, inner]) => `${JSON.stringify(key)} = ${tomlValue(inner)}`)
      .join(", ")} }`;
  }
  return '""';
}

export function codexArgs({ node, mcpScript, socketPath, mcpServers = [], access }) {
  const args = ["app-server"];
  const set = (key, value) => args.push("-c", `${key}=${tomlValue(value)}`);
  set("mcp_servers.gond", { command: node, args: [mcpScript, socketPath], default_tools_approval_mode: "approve", startup_timeout_sec: 30 });
  for (const server of mcpServers) {
    if (!server || typeof server.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(server.name) || server.name === "gond") continue;
    if (server.type === "http" && typeof server.url === "string") {
      set(`mcp_servers.${server.name}`, { url: server.url, http_headers: server.headers && typeof server.headers === "object" ? server.headers : {} });
    } else if (server.type === "stdio" && typeof server.command === "string" && server.command) {
      set(`mcp_servers.${server.name}`, { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: server.env && typeof server.env === "object" ? server.env : {} });
    }
  }
  if (access?.kind === "api") {
    set("model_provider", "gond");

    set("model_providers.gond", { name: "Gond", base_url: access.baseUrl, env_key: "GOND_LLM_TOKEN", wire_api: "responses" });
  }
  return args;
}

export function codexEnv(base, access) {
  const env = { ...base };
  for (const name of CODEX_CREDENTIAL_ENV) delete env[name];
  if (access?.kind === "api") env.GOND_LLM_TOKEN = access.token;
  return env;
}

export function codexApprovalPolicy(permission) {
  return permission === "full" ? "never" : "untrusted";
}

export function unwrapCommand(command) {
  if (Array.isArray(command)) command = command.join(" ");
  const text = String(command ?? "");
  const match = /^(?:\/usr)?\/bin\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text.trim());
  return match ? match[2] : text;
}

export function codexActivity(item) {
  if (item?.type !== "agentMessage") return null;
  return typeof item.text === "string" && item.text.trim() ? item.text.trim().replace(/\s+/g, " ").slice(0, 200) : null;
}

function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export function codexStep(item, done) {
  if (!item?.id || item.type === "agentMessage") return null;
  const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0);
  switch (item.type) {
    case "commandExecution":
      return done
        ? { id: item.id, output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "", status: failed ? "failed" : "done" }
        : { id: item.id, kind: "command", tool: "Bash", input: { command: unwrapCommand(item.command) }, status: "running" };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes.map((c) => c.path).filter((path) => typeof path === "string" && path);
      return done
        ? { id: item.id, output: changes.map((c) => (typeof c.diff === "string" ? c.diff : "")).filter(Boolean).join("\n") || null, status: failed ? "failed" : "done" }
        : { id: item.id, kind: "file", tool: "Edit", input: { ...(files[0] ? { file_path: files[0] } : {}), files }, status: "running" };
    }
    case "mcpToolCall": {
      if (item.server === "gond" && item.tool === "permission") return null;
      const tool = item.server === "gond" ? item.tool : `mcp__${item.server}__${item.tool}`;
      return done
        ? { id: item.id, output: item.error?.message ?? contentText(item.result?.content), status: item.error || failed ? "failed" : "done" }
        : { id: item.id, kind: "tool", tool, input: item.arguments && typeof item.arguments === "object" ? item.arguments : {}, status: "running" };
    }
    case "webSearch":
      return done ? { id: item.id, status: "done" } : { id: item.id, kind: "tool", tool: "WebSearch", input: { query: typeof item.query === "string" ? item.query : "" }, status: "running" };
    default:
      return null;
  }
}

export function codexInput(text, images = []) {
  const input = [{ type: "text", text, text_elements: [] }];
  for (const file of images) {
    if (file && typeof file.data === "string" && typeof file.mediaType === "string" && file.mediaType.startsWith("image/")) {
      input.push({ type: "image", url: `data:${file.mediaType};base64,${file.data}` });
    }
  }
  return input;
}

export class CodexSession extends BridgedSession {
  constructor(options) {
    super(options);
    this.engine = "codex";
    this.bin = options.bin ?? CODEX_BIN;
    this.node = options.node ?? process.execPath;
    this.rpc = null;
    this.permission = "ask";
    this.fileChanges = new Map();
  }

  bridgeTools() {
    return this.tools.filter((tool) => tool.name !== "permission");
  }

  async ensure({ model, systemPrompt, tools, permission = "ask", mcpServers = [], access = { kind: "plan" } }) {
    this.tools = tools;
    this.permission = permission;
    const argsKey = createHash("sha256")
      .update(JSON.stringify({ engine: "codex", model, permission, mcpServers, access, tools: tools.map((t) => t.name).sort() }))
      .digest("hex")
      .slice(0, 16);
    if (this.running && this.argsKey === argsKey) return { launched: false };
    if (this.running) await this.close({ keepSession: true });

    const codexHome = this.baseEnv.CODEX_HOME ?? path.join(this.baseEnv.HOME ?? this.cwd, ".codex");
    if (!fs.existsSync(codexHome)) {
      fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      if (this.uid !== undefined) fs.lchownSync(codexHome, this.uid, this.gid);
    }
    const socketPath = await this.listen();
    const args = codexArgs({ node: this.node, mcpScript: this.mcpScript, socketPath, mcpServers, access });
    this.stderr = "";
    this.log("spawn", { args: args.map((a) => a.replace(/"env_key" = "[^"]*"/, '"env_key" = "…"')) });
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: codexEnv(this.baseEnv, access),
      ...(this.uid !== undefined ? { uid: this.uid, gid: this.gid } : {}),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
      this.log("stderr", chunk);
    });
    const spawned = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.on("close", (code, signal) => this.onExit(child, code, signal));
    await spawned;
    this.rpc = new RpcPeer(child, {
      jsonrpc: false,
      log: this.log,
      onRequest: (method, params) => this.onServerRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
    });

    const describe = (error) => new Error(`Codex didn't start: ${(this.stderr.trim() || error.message).slice(0, 300)}`);
    await this.rpc.request("initialize", { clientInfo: { name: "gond", title: "Gond", version: "1.0.0" } }, { timeoutMs: SETUP_TIMEOUT_MS }).catch((error) => {
      throw describe(error);
    });
    this.rpc.notify("initialized", {});

    const params = { ...(model ? { model } : {}), cwd: this.cwd, approvalPolicy: codexApprovalPolicy(permission), sandbox: "danger-full-access", developerInstructions: systemPrompt };
    let resumed = false;
    let recovered = false;
    if (this.sessionId) {
      try {
        await this.rpc.request("thread/resume", { threadId: this.sessionId, ...params }, { timeoutMs: SETUP_TIMEOUT_MS });
        resumed = true;
      } catch (error) {
        this.onWarning(`Codex couldn't resume thread ${this.sessionId} (${error.message}); starting a new one.`);
        this.sessionId = null;
        recovered = true;
      }
    }
    if (!this.sessionId) {
      const started = await this.rpc.request("thread/start", params, { timeoutMs: SETUP_TIMEOUT_MS }).catch((error) => {
        throw describe(error);
      });
      this.sessionId = started?.thread?.id ?? null;
      if (!this.sessionId) throw new Error("Codex started no thread");
    }
    this.systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex");
    this.argsKey = argsKey;
    return { launched: true, resumed, recovered };
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.log("exit", { code, signal });
    this.child = null;
    this.rpc = null;
    const turn = this.turn;
    if (turn) {
      this.turn = null;
      turn.finish({ ok: false, text: turn.reply.text(), stopReason: turn.interrupted ? "interrupted" : "exited", error: turn.interrupted ? "The turn was interrupted" : this.stderr.trim().slice(0, 500) || `Codex exited (${signal ?? code})` });
    }
  }

  onNotification(method, params) {
    const turn = this.turn;
    if (!turn || (params?.threadId && params.threadId !== this.sessionId)) return;
    switch (method) {
      case "turn/started":
        if (params?.turn?.id) turn.turnId = params.turn.id;
        return;
      case "item/started": {
        const item = params?.item;
        if (item?.type === "fileChange") this.fileChanges.set(item.id, item.changes ?? []);
        if (item?.type === "agentMessage") return;
        if (item?.type && item.type !== "userMessage" && item.type !== "reasoning") turn.reply.tool();
        const step = codexStep(item, false);
        if (step) turn.onEvent({ type: "step", step });
        return;
      }
      case "item/completed": {
        const item = params?.item;
        const step = codexStep(item, true);
        if (step) turn.onEvent({ type: "step", step });
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          turn.reply.block(item.text);
          const line = codexActivity(item);
          if (line) turn.onEvent({ type: "activity", line });
        }
        return;
      }
      case "error":
        if (params?.willRetry) turn.onEvent({ type: "activity", line: "Reconnecting to the model…" });
        else if (params?.error?.message) turn.error = params.error.message;
        return;
      case "turn/completed": {
        const status = params?.turn?.status ?? "failed";
        const error = params?.turn?.error?.message ?? turn.error ?? null;
        this.turn = null;
        turn.finish({
          ok: status === "completed",
          text: turn.reply.text(),
          stopReason: turn.interrupted ? "interrupted" : status,
          error: status === "completed" ? null : turn.interrupted ? "The turn was interrupted" : error || `The turn ${status}`,
        });
        return;
      }
      default:
    }
  }

  async onServerRequest(method, params) {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        if (this.permission === "full") return { decision: "accept" };
        const command = unwrapCommand(params?.command ?? "");
        const answer = await this.askPermission("Bash", { command, ...(params?.reason ? { description: params.reason } : {}) });
        return { decision: answer.allow ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        if (this.permission !== "ask") return { decision: "accept" };
        const changes = this.fileChanges.get(params?.itemId) ?? [];
        const file = changes[0]?.path ?? "";
        const answer = await this.askPermission("Edit", { file_path: file, ...(changes.length > 1 ? { files: changes.map((c) => c.path) } : {}), ...(params?.reason ? { description: params.reason } : {}) });
        return { decision: answer.allow ? "accept" : "decline" };
      }
      case "mcpServer/elicitation/request": {
        const answer = await this.askPermission(`mcp__${params?.serverName ?? "server"}`, { message: params?.message ?? "" });
        return { action: answer.allow ? "accept" : "decline", content: answer.allow ? {} : null, _meta: null };
      }
      default:
        throw new Error(`${method} isn't supported by Gond`);
    }
  }

  turnWith({ prompt, images, timeoutMs, onEvent, systemPrompt, signal }) {
    if (this.turn) return Promise.reject(new Error("A turn is already in flight"));
    if (!this.running || !this.rpc) return Promise.reject(new Error("No session"));
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
        turnId: null,
        reply: new ReplyText(),
        error: null,
        finish: (result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", interrupt);
          this.dropPendingCalls();
          if (this.running) this.armIdle();
          resolve(result);
        },
      };
      const interrupt = () => {
        if (this.turn !== turn) return;
        turn.interrupted = true;
        if (turn.turnId && this.rpc) void this.rpc.request("turn/interrupt", { threadId: this.sessionId, turnId: turn.turnId }).catch(() => undefined);
        setTimeout(() => {
          if (this.turn === turn) this.kill();
        }, INTERRUPT_GRACE_MS).unref?.();
      };
      const timer = setTimeout(interrupt, timeoutMs);
      if (signal?.aborted) {
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "interrupted", error: "Aborted before the turn started" });
        return;
      }
      signal?.addEventListener("abort", interrupt, { once: true });
      this.turn = turn;
      this.log("in", { prompt: text.length, images: images?.length ?? 0 });
      this.rpc
        .request("turn/start", { threadId: this.sessionId, input: codexInput(text, images) })
        .then((started) => {
          if (started?.turn?.id) turn.turnId ??= started.turn.id;
          if (turn.interrupted && this.rpc) void this.rpc.request("turn/interrupt", { threadId: this.sessionId, turnId: turn.turnId }).catch(() => undefined);
        })
        .catch((error) => {
          if (this.turn !== turn) return;
          this.turn = null;
          turn.finish({ ok: false, text: "", stopReason: "error", error: error.message });
        });
    });
  }

  async steer(text) {
    const turn = this.turn;
    if (!turn || turn.interrupted || !turn.turnId || !this.rpc) return false;
    this.log("in", { steer: text.length });
    try {
      await this.rpc.request("turn/steer", { threadId: this.sessionId, expectedTurnId: turn.turnId, input: codexInput(text, []) }, { timeoutMs: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  kill() {
    const child = this.child;
    if (!child) return;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), 5_000).unref?.();
  }

  async close({ keepSession = true } = {}) {
    this.clearIdle();
    await this.stopChild();
    this.child = null;
    this.rpc = null;
    if (!keepSession) {
      this.sessionId = null;
    }
    await this.closeBridge();
  }
}
