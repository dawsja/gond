import type { BotFileEntry, DesktopControl, Engine, EngineSignIn, ModelChoice, ScreenStepType, ScreenTarget } from "@gond/shared";
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "./config.ts";
import { getUser, isAdmin } from "./data/users.ts";
import type { ToolPart } from "./driver.ts";
import type { StepUpdate } from "./work.ts";

export type BoxConfig = { url: string; token: string; user: string | null };

export type ExecResult = {
  exitCode: number;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
};

export function boxUrl(): string | null {
  const url = (env("BOX_URL") ?? "").trim().replace(/\/+$/, "");
  return url || null;
}

function boxToken(): string {
  const fromEnv = (env("BOX_TOKEN") ?? "").trim();
  if (fromEnv) return fromEnv;
  const file = path.join(env("BOX_STATE_DIR") || "/box-state", "token");
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch {
    /* fall through */
  }
  throw new Error(`No box token: set GOND_BOX_TOKEN on the API and the box, or mount the box's state volume at ${path.dirname(file)}.`);
}

export function boxConfig(userId: string | null = null): BoxConfig | null {
  const url = boxUrl();
  return url ? { url, token: boxToken(), user: userId } : null;
}

export function requireBoxConfig(userId: string | null = null): BoxConfig {
  const config = boxConfig(userId);
  if (!config) {
    throw new Error("Gond needs its box to run bots. Start the box container and set GOND_BOX_URL (docker-compose.yml does both).");
  }
  return config;
}

export class BoxError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "BoxError";
    this.status = status;
    this.code = code;
  }
}

export function personHasControl(error: unknown): boolean {
  return error instanceof BoxError && error.status === 409 && error.code === "person_has_control";
}

function headersFor(config: BoxConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${config.token}`, ...(config.user ? { "X-Gond-User": config.user, "X-Kru-User": config.user } : {}), ...extra };
}

async function request(config: BoxConfig, route: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array<ArrayBuffer>; signal?: AbortSignal }, retried = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.url}${route}`, { method: init.method, headers: headersFor(config, init.headers), body: init.body, redirect: "error", signal: init.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BoxError(`The box at ${config.url} isn't reachable (${detail}). Is the box service running?`, 0);
  }
  if (res.status === 404 && config.user && !retried) {
    const peek = (await res.clone().json().catch(() => ({}))) as { code?: string };
    if (peek.code === "no_account") {
      await res.body?.cancel().catch(() => undefined);
      await ensureBoxAccount(config);
      return request(config, route, init, true);
    }
  }
  return res;
}

async function call<T>(config: BoxConfig, method: string, route: string, body?: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<T> {
  const res = await request(config, route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string } & T;
  if (!res.ok) throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status, typeof data.code === "string" ? data.code : null);
  return data;
}

export type BoxAccount = { id: string; name: string; uid: number | null; home: string };

const knownAccounts = new Map<string, BoxAccount>();

export async function ensureBoxAccount(config: BoxConfig): Promise<BoxAccount> {
  if (!config.user) throw new BoxError("No person to make an account for", 400);
  const user = getUser(config.user);
  if (!user) throw new BoxError("No such person", 404);
  const { account } = await call<{ ok: true; account: BoxAccount }>({ ...config, user: null }, "POST", "/accounts", { id: user.id, name: user.name, email: user.email, admin: isAdmin(user) }, 30_000);
  knownAccounts.set(user.id, account);
  return account;
}

export function forgetBoxAccounts(): void {
  knownAccounts.clear();
}

export function boxHome(userId: string): string | null {
  return knownAccounts.get(userId)?.home ?? null;
}

export async function removeBoxAccount(config: BoxConfig, userId: string): Promise<void> {
  await call({ ...config, user: null }, "DELETE", `/accounts/${userId}`, undefined, 120_000);
  knownAccounts.delete(userId);
}

export type BoxSkillFile = { path: string; data: string; executable: boolean };

export function listBoxSkills(config: BoxConfig): Promise<{ skills: string[] }> {
  return call(config, "GET", "/skills", undefined, 10_000);
}

export function writeBoxSkill(config: BoxConfig, slug: string, files: BoxSkillFile[]): Promise<{ ok: true }> {
  return call(config, "PUT", `/skills/${slug}`, { files }, 120_000);
}

export async function deleteBoxSkill(config: BoxConfig, slug: string): Promise<void> {
  await call(config, "DELETE", `/skills/${slug}`);
}

export const EXEC_TIMEOUT_MS = 10 * 60 * 1000;

export function health(config: BoxConfig): Promise<{ ok: boolean; agents: number; desktops?: number; updating?: boolean }> {
  return fetch(`${config.url}/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json() as Promise<{ ok: boolean; agents: number; updating?: boolean }>);
}

export type BoxUpdateStatus = { running: boolean; startedAt?: string; finishedAt?: string | null; ok?: boolean | null; exitCode?: number | null; log?: string };

export function startBoxUpdate(config: BoxConfig): Promise<{ ok: true; startedAt: string }> {
  return call(config, "POST", "/update", {}, 120_000);
}

export function resetBox(config: BoxConfig): Promise<{ ok: true; removed: string[]; accounts: string[] }> {
  return call(config, "POST", "/reset", {}, 300_000);
}

/** The person's own account on the box as it was built, keeping their memories and sign-ins. */
export function resetBoxHome(config: BoxConfig): Promise<{ ok: true; removed: number }> {
  return call(config, "POST", "/home/reset", {}, 300_000);
}

export function boxUpdateStatus(config: BoxConfig): Promise<BoxUpdateStatus> {
  return call(config, "GET", "/update", undefined, 10_000);
}

export type BoxVersions = { node: string | null; bun: string | null; claude: string | null };

export function boxVersions(config: BoxConfig): Promise<BoxVersions> {
  return call(config, "GET", "/versions", undefined, 30_000);
}

/** `env` carries stored secrets for run_with_secrets: in the body only, never in the command line or a log. */
export function execOnBox(config: BoxConfig, command: string, options: { cwd?: string | null; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
  return call(config, "POST", "/exec", { command, cwd: options.cwd ?? null, timeoutMs, ...(options.env ? { env: options.env } : {}) }, timeoutMs + 30_000);
}

export function readBoxFile(config: BoxConfig, filePath: string): Promise<{ content?: string; directory?: string[]; entries?: BotFileEntry[]; binary?: boolean; size?: number }> {
  return call(config, "GET", `/files?path=${encodeURIComponent(filePath)}`);
}

export async function readBoxFileBytes(config: BoxConfig, filePath: string): Promise<Uint8Array> {
  const res = await request(config, `/files/raw?path=${encodeURIComponent(filePath)}`, { method: "GET", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function writeBoxFile(config: BoxConfig, filePath: string, content: string): Promise<{ ok: true }> {
  return call(config, "PUT", "/files", { path: filePath, content });
}

/** Puts bytes at a path in the person's home, as them; up to 30 MB. */
export async function uploadBoxFile(config: BoxConfig, filePath: string, data: Uint8Array, signal?: AbortSignal): Promise<{ ok: true; size: number }> {
  const res = await request(config, `/files/raw?path=${encodeURIComponent(filePath)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(data), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; size?: number };
  if (!res.ok) throw new BoxError(body.error ?? `Upload failed (${res.status})`, res.status, typeof body.code === "string" ? body.code : null);
  return { ok: true, size: body.size ?? data.byteLength };
}

/** A JPEG of a picture in the home, its long edge at most 1568 px, for a model to look at. */
export function previewBoxImage(config: BoxConfig, filePath: string, mediaType: string, signal?: AbortSignal): Promise<{ ok: true; mediaType: string; data: string; size: number }> {
  return call(config, "GET", `/files/preview?path=${encodeURIComponent(filePath)}&type=${encodeURIComponent(mediaType)}`, undefined, 60_000, signal);
}

export async function deleteBoxFile(config: BoxConfig, filePath: string): Promise<void> {
  await call(config, "DELETE", `/files?path=${encodeURIComponent(filePath)}`);
}

export function ensureBotHome(config: BoxConfig, botId: string): Promise<{ ok: true; dir: string }> {
  return call(config, "POST", `/bots/${botId}`);
}

export async function deleteBotHome(config: BoxConfig, botId: string): Promise<void> {
  await call(config, "DELETE", `/bots/${botId}`);
}

export async function openBoxStream(config: BoxConfig, route: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
  const res = await request(config, route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Accept: "text/event-stream", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  }
  return res;
}

export function createTerminal(config: BoxConfig, input: { bot?: string | null; cols: number; rows: number }): Promise<{ id: string; cwd: string }> {
  return call(config, "POST", "/terminals", input);
}

export function terminalInput(config: BoxConfig, id: string, data: string): Promise<{ ok: true }> {
  return call(config, "POST", `/terminals/${id}/input`, { data });
}

export function terminalResize(config: BoxConfig, id: string, size: { cols: number; rows: number }): Promise<{ ok: true }> {
  return call(config, "POST", `/terminals/${id}/resize`, size);
}

export async function closeTerminal(config: BoxConfig, id: string): Promise<void> {
  await call(config, "DELETE", `/terminals/${id}`);
}

export type ClaudeCheck = { status: "ok" | "missing" | "unauthenticated" | "error"; detail: string };

export function checkClaude(config: BoxConfig): Promise<ClaudeCheck> {
  return call(config, "POST", "/claude/check", {}, 45_000);
}

export type ClaudeAuth = { known: boolean; loggedIn: boolean | null; email?: string | null; org?: string | null; method?: string | null };

export function claudeAuth(config: BoxConfig): Promise<ClaudeAuth> {
  return call(config, "GET", "/claude/auth", undefined, 20_000);
}

export function engineModels(config: BoxConfig, engine: Engine): Promise<{ models: ModelChoice[] }> {
  return call(config, "GET", `/engines/${engine}/models`, undefined, 45_000);
}

export function startEngineSignIn(config: BoxConfig, engine: Engine): Promise<{ signIn: EngineSignIn }> {
  return call(config, "POST", `/engines/${engine}/sign-in`, {}, 30_000);
}

export function engineSignIn(config: BoxConfig, engine: Engine): Promise<{ signIn: EngineSignIn | null }> {
  return call(config, "GET", `/engines/${engine}/sign-in`, undefined, 15_000);
}

export function engineSignInCode(config: BoxConfig, engine: Engine, code: string): Promise<{ signIn: EngineSignIn }> {
  return call(config, "POST", `/engines/${engine}/sign-in/code`, { code }, 15_000);
}

export async function cancelEngineSignIn(config: BoxConfig, engine: Engine): Promise<void> {
  await call(config, "DELETE", `/engines/${engine}/sign-in`, undefined, 15_000);
}

export async function* readEvents<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end = pending.indexOf("\n\n");
    while (end !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield JSON.parse(line.slice(5).trim()) as T;
      }
      end = pending.indexOf("\n\n");
    }
  }
}

export type AgentTool = { name: string; description: string; inputSchema: unknown };

export type BoxAccess = { kind: "plan" } | { kind: "api"; baseUrl: string; token: string; smallModel?: string | null };

export type AgentTurnInput = {
  bot: string;

  engine: Engine;
  access: BoxAccess;

  mcpServers?: unknown[];
  model: string;
  maxTurns?: number | null;
  permission: "ask" | "full";
  systemPrompt: string;
  prompt: string;
  followUp?: string;
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: AgentTool[];
  timeoutMs: number;
};

export type AgentEvent =
  | { type: "init"; sessionId: string; permissionMode: string | null }
  | { type: "line"; line: string }
  | { type: "activity"; line: string }
  | { type: "step"; step: StepUpdate }
  | { type: "tool_call"; callId: string; name: string; input: Record<string, unknown> }
  | AgentTurnResult
  | { type: "error"; missing: boolean; message: string };

export type AgentTurnResult = {
  type: "result";
  ok: boolean;
  text: string;
  stopReason: string | null;
  error?: string;
  sessionId: string | null;
  launched: boolean;
  resumed: boolean;
  recovered: boolean;
};

export async function runAgentTurn(
  config: BoxConfig,
  agentId: string,
  input: AgentTurnInput,
  options: { signal?: AbortSignal; onEvent: (event: AgentEvent) => void },
): Promise<AgentTurnResult | null> {
  const res = await openBoxStream(config, `/agents/${agentId}/turn`, options.signal, input);
  if (!res.body) throw new BoxError("The box sent no stream", 502);
  let result: AgentTurnResult | null = null;
  for await (const event of readEvents<AgentEvent>(res.body)) {
    options.onEvent(event);
    if (event.type === "result") result = event;
    if (event.type === "error") throw new BoxError(event.message, event.missing ? 424 : 502);
  }
  return result;
}

export function answerAgentTool(config: BoxConfig, agentId: string, answer: { callId: string; content: string | ToolPart[]; isError?: boolean }): Promise<{ ok: true }> {
  return call(config, "POST", `/agents/${agentId}/tool-result`, answer, 30_000);
}

export function steerAgent(config: BoxConfig, agentId: string, text: string): Promise<{ steered: boolean }> {
  return call(config, "POST", `/agents/${agentId}/steer`, { text }, 15_000);
}

export function interruptAgent(config: BoxConfig, agentId: string): Promise<{ ok: true; interrupted: boolean }> {
  return call(config, "POST", `/agents/${agentId}/interrupt`, {});
}

export async function closeAgent(config: BoxConfig, agentId: string): Promise<void> {
  await call(config, "DELETE", `/agents/${agentId}`);
}

export function listAgents(config: BoxConfig): Promise<{ agents: { id: string; user: string | null; running: boolean; busy: boolean }[] }> {
  return call(config, "GET", "/agents", undefined, 10_000);
}

export type DesktopStatus = { bot: string; running: boolean; ready: boolean; width: number | null; height: number | null; viewers: number; control: DesktopControl };

const screenPath = (bot: string) => `/desktop/${encodeURIComponent(bot)}`;

/** The person's bots' screens that are running. */
export function desktopScreens(config: BoxConfig): Promise<{ screens: DesktopStatus[] }> {
  return call(config, "GET", "/desktop", undefined, 10_000);
}

/** `primary` on the first start of the primary bot's screen hands it the browser profile from before each bot had its own. */
export function startDesktop(config: BoxConfig, bot: string, body: { width: number; height: number; primary?: boolean }): Promise<DesktopStatus> {
  return call(config, "POST", screenPath(bot), body, 45_000);
}

export async function stopDesktop(config: BoxConfig, bot?: string): Promise<void> {
  await call(config, "DELETE", bot ? screenPath(bot) : "/desktop");
}

export function connectDesktop(config: BoxConfig, bot: string, body: { width: number; height: number; primary?: boolean }): Promise<{ id: string; width: number | null; height: number | null }> {
  return call(config, "POST", `${screenPath(bot)}/connections`, body, 45_000);
}

export function desktopInput(config: BoxConfig, bot: string, id: string, data: string): Promise<{ ok: true }> {
  return call(config, "POST", `${screenPath(bot)}/connections/${id}/input`, { data });
}

export async function disconnectDesktop(config: BoxConfig, bot: string, id: string): Promise<void> {
  await call(config, "DELETE", `${screenPath(bot)}/connections/${id}`);
}

export function desktopControl(config: BoxConfig, bot: string, body: { holder: "person" | "free"; from?: "bots" }, signal?: AbortSignal): Promise<DesktopStatus> {
  return call(config, "POST", `${screenPath(bot)}/control`, body, 10_000, signal);
}

export function screenStreamPath(bot: string, id: string): string {
  return `${screenPath(bot)}/connections/${id}/stream`;
}

/** One step as the box takes it: coordinates in real screen (or page) pixels, a sign-in already filled in. */
export type ScreenStep = { type: ScreenStepType } & Record<string, unknown>;

export type ScreenView = "both" | "text" | "image";

export type ScreenBatch = {
  bot: string;
  primary?: boolean;
  target: ScreenTarget;
  steps: ScreenStep[];
  view?: ScreenView;
  saveTo?: string;
};

export type ScreenTab = { index: number; title: string; url: string; active: boolean };

export type ScreenResult = {
  ok: true;
  target: ScreenTarget;
  control: DesktopControl;
  screen: { width: number; height: number };
  image?: string;
  mime?: "image/png" | "image/jpeg";
  width?: number;
  height?: number;
  done: string[];
  error: { index: number; message: string } | null;
  outputs?: { index: number; text: string }[];
  url?: string;
  title?: string;
  tabs?: ScreenTab[];
  elements?: { text: string; note: string } | null;
  dialog?: { type: string; message: string } | null;
  downloads?: string[];
};

// Twenty steps may each wait or load a page; the box bounds every one of them.
export const SCREEN_BATCH_TIMEOUT_MS = 6 * 60_000;

export function screenBatch(config: BoxConfig, batch: ScreenBatch, signal?: AbortSignal): Promise<ScreenResult> {
  return call(config, "POST", "/computer", batch, SCREEN_BATCH_TIMEOUT_MS, signal);
}
