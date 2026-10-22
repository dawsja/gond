import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts, USER_ID, handOver, openedPath } from "./accounts.mjs";
import { CLAUDE_BIN, checkClaude } from "./claude.mjs";
import { AgentSession, PERMISSION_MODES, authStatus, forgetClaudeVersion, parseAccess } from "./agents.mjs";
import { toolResultContent } from "./bridge.mjs";
import { BrowserError, createBrowsers } from "./browser.mjs";
import { clipText, readXclip, VIEWPORT, writeXclip } from "./browser-host.mjs";
import { PERSON_HAS_CONTROL, ComputerActionError, controlTransition, describeStep, parseSteps, pngSize, settleMs, STEP_TIMEOUT_MS, stepTimeoutMs, thumbSize, usesInput, xdotoolArgv, xdotoolStdin } from "./computer.mjs";
import { runFileJob } from "./file-job.mjs";
import { MAX_UPLOAD_BYTES, previewArgv } from "./preview.mjs";
import { createSessionStore, turnPrompt } from "./sessions.mjs";
import { engineModels } from "./models.mjs";
import { SIGN_IN_COLS, SIGN_IN_KEEP_MS, SIGN_IN_ROWS, SignInJob, needsCode, signInArgv } from "./sign-in.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const STATE_DIR = process.env.STATE_DIR || "/state";

const AGENT_UID = Number(process.env.AGENT_UID || 1001);
const AGENT_GID = Number(process.env.AGENT_GID || 1001);
const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";

const HOMES_DIR = process.env.HOMES_DIR || "/home";

const SKILLS_ROOT = process.env.SKILLS_DIR || "/srv/gond/skills";

const AGENT_SOCKET_DIR = process.env.AGENT_SOCKET_DIR || "/tmp/gond-agents";
const LEGACY_USER_HEADER = "x-kru-user";

const GOND_MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "gond-mcp.mjs");
const FILE_JOB = path.join(path.dirname(fileURLToPath(import.meta.url)), "file-job.mjs");

const MAX_STEER_CHARS = 40_000;

const MAX_AGENT_TURN_MS = 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const TOKEN_READER_GID = Number(process.env.TOKEN_READER_GID || 1000);

export const MAX_OUTPUT = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;

export const MAX_SHARE_BYTES = 100 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MAX_TURN_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EXEC_TIMEOUT_MS = 30 * 60 * 1000;

const FEED_BYTES = 256 * 1024;
const MAX_TERMINALS = 8;

const TERMINAL_IDLE_MS = 30 * 60 * 1000;
const SSE_KEEPALIVE_MS = 15_000;

const DESKTOP_DISPLAY = Number(process.env.DESKTOP_DISPLAY || 1);
const DESKTOP_SCRIPT = process.env.DESKTOP_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop.sh");
const BROWSER_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-host.mjs");
const MAX_DESKTOP_CONNECTIONS = 6;

const DESKTOP_START_MS = 30_000;

const DESKTOP_IDLE_MS = 30 * 60 * 1000;
// Screens a person's bots keep running at once; each is a display and a Chrome.
const SCREENS_PER_PERSON = Math.max(1, Number(process.env.GOND_SCREENS_PER_PERSON) || 3);
// The bots' hold lapses when no batch has come for this long, so a turn the API lost can't keep the person out.
const BOTS_HOLD_MS = 10 * 60 * 1000;
const VNCCONFIG_MS = 5_000;
// Xtigervnc lets vncconfig change these at run time (desktop.sh's -AllowOverride). xdotool goes through XTEST, not VNC, so the bots' own input never passes them.
const VIEWER_INPUT = ["AcceptPointerEvents", "AcceptKeyEvents", "AcceptCutText"];

const CONNECTION_CLAIM_MS = 30_000;

const SCREENSHOT_MS = 10_000;

const SCREENSHOT_GAP_MS = 300;

const UPDATE_SCRIPT = process.env.UPDATE_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), "update.sh");

const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

const UPDATE_LOG_BYTES = 64 * 1024;

const isRoot = process.getuid?.() === 0;

export const accounts = new Accounts({
  stateDir: STATE_DIR,
  homesDir: HOMES_DIR,
  root: isRoot,
  skillsRoot: SKILLS_ROOT,
  agent: {
    name: "agent",
    uid: AGENT_UID,
    gid: AGENT_GID,
    home: AGENT_HOME,
    dirs: {
      bots: process.env.BOTS_DIR || undefined,
      cache: process.env.CACHE_DIR || undefined,
      claude: process.env.CLAUDE_CONFIG_DIR || undefined,
      run: process.env.XDG_RUNTIME_DIR_AGENT || undefined,
    },
  },
  log: (text) => console.info(`[box] ${text}`),
});

function agentAccount() {
  return accounts.admin() ?? accounts.agentAccount();
}

function asUser(account) {
  return account.uid !== undefined ? { uid: account.uid, gid: account.gid } : {};
}

// Each bot's browser runs on its own screen with its own profile, as the person.
const browsers = createBrowsers({
  start: (account, bot) => {
    const screen = screenOf(account, bot);
    if (!screen) throw new HttpError(502, "The screen isn't running");
    return spawn(process.execPath, [BROWSER_HOST], {
      cwd: account.home,
      env: agentEnv(account, {
        ...displayEnv(screen),
        XDG_RUNTIME_DIR: screen.run,
        GOND_BROWSER_PROFILE: screen.profile,
        CHROME_BIN: process.env.CHROME_BIN || "/usr/local/bin/google-chrome",
      }),
      ...asUser(account),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  },
  log: (text) => console.warn(`[box] ${text}`),
});

/**
 * Hands a path to the account; a no-op when the box isn't root (development).
 * Never through a link, and never to anything outside the home (handOver).
 */
function own(target, account) {
  if (account.uid === undefined) return;
  try {
    handOver(target, account);
  } catch (error) {
    console.warn(`[box] could not own ${target}: ${error.message}`);
  }
}

/** The folders the files API never opens in a home: the CLIs' sign-ins, the bots' browser profiles (their cookies) and the skills link (root's, written by the API). */
function forbiddenIn(account) {
  return [...account.logins, account.browser, account.browsers, account.skills];
}

export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Feed {
  constructor(limit = FEED_BYTES) {
    this.limit = limit;
    this.lines = [];
    this.size = 0;
    this.subscribers = new Set();
    this.closed = false;
  }

  publish(event) {
    const line = JSON.stringify(event);
    this.lines.push(line);
    this.size += line.length;
    while (this.size > this.limit && this.lines.length > 1) {
      this.size -= this.lines.shift().length;
    }
    for (const send of this.subscribers) send(line);
  }

  subscribe(send) {
    for (const line of this.lines) send(line);
    if (this.closed) {
      send(JSON.stringify({ type: "end" }));
      return () => undefined;
    }
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.publish({ type: "end" });
    this.subscribers.clear();
  }
}

function streamFeed(request, response, feed) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const send = (line) => response.write(`data: ${line}\n\n`);
  const unsubscribe = feed.subscribe(send);
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  const stop = () => {
    clearInterval(keepalive);
    unsubscribe();
    response.end();
  };
  request.on("close", stop);
  if (feed.closed) stop();
  return stop;
}

export function inside(root, relative) {
  if (typeof relative !== "string" || !relative.trim()) throw new HttpError(400, "Missing path");
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(400, "Path is outside the agent's home");
  }
  const parts = path.relative(root, full).split(path.sep);
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    throw new HttpError(400, "Path is inside .git");
  }
  return full;
}

const AGENT_LOGIN_DIRS = [process.env.CLAUDE_CONFIG_DIR || path.join(AGENT_HOME, ".claude")];

/**
 * Resolves a path inside a person's home, for the bots' own use of the
 * box: anywhere under home except the CLIs' logins, and never .git.
 */
export function insideHome(relative, home = AGENT_HOME, forbidden = AGENT_LOGIN_DIRS) {
  const full = inside(home, relative);
  for (const dir of Array.isArray(forbidden) ? forbidden : [forbidden]) {
    if (full === dir || full.startsWith(dir + path.sep)) throw new HttpError(400, "Path is inside a private folder (a CLI's sign-in or the skills link)");
  }
  return full;
}

/**
 * insideHome for a file that is read: the path with its symlinks followed
 * must still be inside, so a link can't point a read at a sign-in or at
 * the rest of the machine.
 */
export function realInsideHome(relative, home = AGENT_HOME, forbidden = AGENT_LOGIN_DIRS) {
  const full = insideHome(relative, home, forbidden);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw new HttpError(404, "No such file");
  }
  const realHome = fs.realpathSync(home);
  return insideHome(path.relative(realHome, real) || ".", realHome, (Array.isArray(forbidden) ? forbidden : [forbidden]).map((dir) => (fs.existsSync(dir) ? fs.realpathSync(dir) : dir)));
}

function realForbidden(forbidden) {
  return (Array.isArray(forbidden) ? forbidden : [forbidden]).map((dir) => (fs.existsSync(dir) ? fs.realpathSync(dir) : dir));
}

/**
 * insideHome for a file that is written or deleted: the deepest part of the
 * path that exists, with its links followed, must still be inside, so a
 * link can't aim a write at a sign-in. The change itself is then made as
 * the person (fileJob), which is what keeps it off the rest of the machine.
 */
export function writableInsideHome(relative, home = AGENT_HOME, forbidden = AGENT_LOGIN_DIRS) {
  const full = insideHome(relative, home, forbidden);

  let existing = path.dirname(full);
  const rest = [path.basename(full)];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const realHome = fs.realpathSync(home);
  const real = path.join(fs.realpathSync(existing), ...rest);
  insideHome(path.relative(realHome, real) || ".", realHome, realForbidden(forbidden));
  return full;
}

export function openInsideHome(relative, home = AGENT_HOME, forbidden = AGENT_LOGIN_DIRS) {
  const full = realInsideHome(relative, home, forbidden);
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    throw new HttpError(404, "No such file");
  }
  try {
    const realHome = fs.realpathSync(home);
    const real = openedPath(fd, full);
    insideHome(path.relative(realHome, real) || ".", realHome, realForbidden(forbidden));
    return { fd, real };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function fileJob(account, job) {
  const fail = (code, message) => {
    if (code === "ENOENT") return new HttpError(404, "No such file");
    if (code === "EACCES" || code === "EPERM") return new HttpError(403, "Not allowed there");
    if (code === "EISDIR" || code === "ENOTDIR") return new HttpError(400, message);
    return new HttpError(500, message);
  };
  if (account.uid === undefined) {
    try {
      runFileJob(job);
      return Promise.resolve({ ok: true });
    } catch (error) {
      return Promise.reject(fail(error.code, error.message));
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FILE_JOB], { cwd: account.home, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, ...asUser(account), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new HttpError(500, error.message));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (out === "ok") return resolve({ ok: true });
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* crashed */
      }
      reject(fail(parsed?.code ?? null, parsed?.message ?? (err.trim().slice(0, 200) || "The file change failed")));
    });
    child.stdin.end(JSON.stringify(job));
  });
}

export function boxCwd(given, home = AGENT_HOME, forbidden = AGENT_LOGIN_DIRS) {
  if (given === undefined || given === null || given === "") return home;
  if (typeof given !== "string") throw new HttpError(400, "cwd must be a string");
  const relative = path.isAbsolute(given) ? path.relative(home, given) || "." : given;
  if (relative.startsWith("..")) throw new HttpError(400, "cwd is outside the person's home");
  return insideHome(relative, home, forbidden);
}

export function botDir(account, id) {
  if (!ID.test(id)) throw new HttpError(400, "Bad bot id");
  const dir = path.join(account.bots, id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    own(dir, account);
  }
  return dir;
}

/** Secrets for one command (the API's run_with_secrets): checked, and only ever in the child's environment. */
function execEnv(raw, base) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "env must be an object");
  const entries = Object.entries(raw);
  if (entries.length > 20) throw new HttpError(400, "Too many variables");
  for (const [name, value] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || typeof value !== "string" || value.length > 16_384) throw new HttpError(400, `Bad variable ${name}`);
    if (name in base || /^(?:LD_|BASH_|DYLD_)|^(?:ENV|IFS|PS4|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|SHELL)$/.test(name)) throw new HttpError(400, `${name} can't be set for a command`);
  }
  return Object.fromEntries(entries);
}

function agentEnv(account, extra = {}) {
  const cache = account.cache;
  return {
    PATH: `${path.join(account.home, ".local", "bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: account.home,
    USER: account.name,
    LOGNAME: account.name,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    XDG_CACHE_HOME: cache,
    BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
    npm_config_cache: path.join(cache, "npm"),
    npm_config_store_dir: path.join(cache, "pnpm"),
    YARN_CACHE_FOLDER: path.join(cache, "yarn"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    NEXT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",

    CLAUDE_CONFIG_DIR: account.claude,
    ...extra,
  };
}

export function capOutput(text, limit = MAX_OUTPUT) {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const dropped = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[… ${dropped} characters omitted …]\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

export function runAsUser(account, argv, { cwd, timeoutMs, env, onChunk, input, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: agentEnv(account, env),
      ...asUser(account),
      detached: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
    const chunks = [];
    let size = 0;
    const collect = (chunk) => {
      if (size < MAX_OUTPUT * 4) chunks.push(chunk);
      size += chunk.length;
      onChunk?.(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = () => killGroup();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const { text, truncated } = capOutput(Buffer.concat(chunks).toString("utf8"));
      resolve({
        exitCode: code ?? (exitSignal ? 128 : 1),
        signal: exitSignal ?? null,
        output: text,
        truncated,
        timedOut,
      });
    });
  });
}

function readFile(account, relative) {
  const { fd, real } = openInsideHome(relative, account.home, forbiddenIn(account));
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) {
      const dir = fs.existsSync(`/proc/self/fd/${fd}`) ? `/proc/self/fd/${fd}` : real;
      const names = fs.readdirSync(dir).sort();
      return { directory: names, entries: names.map((name) => dirEntry(dir, name)) };
    }
    if (!stat.isFile()) throw new HttpError(400, "That isn't a file");
    if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 1 MB");
    const buffer = fs.readFileSync(fd);
    if (buffer.includes(0)) return { binary: true, size: stat.size };
    return { content: buffer.toString("utf8"), size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

/** A link is described as itself, never followed, so a listing can't reach outside the home. */
function dirEntry(dir, name) {
  try {
    const stat = fs.lstatSync(path.join(dir, name));
    return { name, dir: stat.isDirectory(), size: stat.isFile() ? stat.size : 0, modified: stat.mtime.toISOString() };
  } catch {
    return { name, dir: false, size: 0, modified: null };
  }
}

function sendRawFile(response, account, relative) {
  const { fd } = openInsideHome(relative, account.home, forbiddenIn(account));
  let buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new HttpError(400, "That's a folder, not a file");
    if (stat.size > MAX_SHARE_BYTES) throw new HttpError(413, `File is larger than ${MAX_SHARE_BYTES / 1024 / 1024} MB`);
    buffer = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buffer.byteLength });
  response.end(buffer);
  return STREAMED;
}

async function uploadFile(request, account, relative) {
  const full = writableInsideHome(relative, account.home, forbiddenIn(account));
  const data = await readBytes(request, MAX_UPLOAD_BYTES);
  await fileJob(account, { op: "write", path: full, content: data.toString("base64"), encoding: "base64" });
  return { ok: true, size: data.length };
}

const PREVIEW_MS = 30_000;

/** A model-sized JPEG of a picture in the home, made as the person by ImageMagick. */
async function imagePreview(account, relative, mediaType) {
  const { fd, real } = openInsideHome(relative, account.home, forbiddenIn(account));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new HttpError(400, "That's a folder, not a file");
    if (stat.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "That picture is too large to preview");
  } finally {
    fs.closeSync(fd);
  }
  const dir = path.join(account.run, "preview");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  own(dir, account);
  const out = path.join(dir, `${randomBytes(6).toString("hex")}.jpg`);
  const argv = previewArgv(real, mediaType, out);
  if (!argv) throw new HttpError(400, "Only JPEG, PNG, WebP, GIF and BMP pictures have a preview");
  try {
    const result = await runAsUser(account, argv, { cwd: account.home, timeoutMs: PREVIEW_MS });
    if (result.exitCode !== 0 || !fs.existsSync(out)) throw new HttpError(422, `The picture couldn't be read: ${result.output.trim().slice(-200) || `convert exited ${result.exitCode}`}`);
    const data = fs.readFileSync(out);
    return { ok: true, mediaType: "image/jpeg", data: data.toString("base64"), size: data.length };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

function writeFile(account, relative, content) {
  if (typeof content !== "string") throw new HttpError(400, "Content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new HttpError(413, "Content is larger than 1 MB");
  }

  return fileJob(account, { op: "write", path: writableInsideHome(relative, account.home, forbiddenIn(account)), content });
}

function deleteFile(account, relative) {
  const full = writableInsideHome(relative, account.home, forbiddenIn(account));
  if (full === account.home || full === account.bots) throw new HttpError(400, "Refusing to delete that folder");
  return fileJob(account, { op: "delete", path: full });
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_SKILL_BODY_BYTES = 40 * 1024 * 1024;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_FILES = 250;

export function skillPath(given) {
  if (typeof given !== "string") return null;
  const parts = given.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.startsWith(".") || part.includes("\\") || /[\u0000-\u001f]/.test(part))) return null;
  const clean = parts.join("/");
  return clean.length <= 255 ? clean : null;
}

function libraryOf(account) {
  if (!account.library) throw new HttpError(503, "No skills folder on this box");
  return accounts.makeLibrary(account);
}

function listSkillFiles(account) {
  try {
    return { skills: fs.readdirSync(libraryOf(account)).filter((name) => SLUG.test(name)).sort() };
  } catch {
    return { skills: [] };
  }
}

/** Writes a whole skill folder next to the old one, then swaps it in, so a bot never reads half of it. */
function writeSkillFolder(account, slug, files) {
  if (!SLUG.test(slug)) throw new HttpError(400, "Bad skill slug");
  if (!Array.isArray(files) || !files.length || files.length > MAX_SKILL_FILES) throw new HttpError(400, "Bad skill files");
  const decoded = [];
  let total = 0;
  const seen = new Set();
  for (const file of files) {
    const clean = skillPath(file?.path);
    if (!clean || seen.has(clean) || typeof file.data !== "string") throw new HttpError(400, `Bad skill file ${String(file?.path ?? "")}`);
    seen.add(clean);
    const data = Buffer.from(file.data, "base64");
    total += data.byteLength;
    if (total > MAX_SKILL_BYTES) throw new HttpError(413, "Skill is too large");
    decoded.push({ path: clean, data, executable: Boolean(file.executable) });
  }
  if (!seen.has("SKILL.md")) throw new HttpError(400, "A skill needs SKILL.md");
  const library = libraryOf(account);
  const target = path.join(library, slug);
  const tmp = path.join(library, `.${slug}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.mkdirSync(tmp, { mode: 0o755 });
    for (const file of decoded) {
      const full = path.join(tmp, file.path);
      if (!full.startsWith(tmp + path.sep)) throw new HttpError(400, "Bad skill file path");
      fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o755 });
      fs.writeFileSync(full, file.data, { mode: file.executable ? 0o755 : 0o644 });
    }
    const old = fs.existsSync(target) ? `${tmp}.old` : null;
    if (old) fs.renameSync(target, old);
    fs.renameSync(tmp, target);
    if (old) fs.rmSync(old, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return { ok: true };
}

function deleteSkillFolder(account, slug) {
  if (!SLUG.test(slug)) throw new HttpError(400, "Bad skill slug");
  fs.rmSync(path.join(libraryOf(account), slug), { recursive: true, force: true });
  return { ok: true };
}

const terminals = new Map();

export function terminalCwd(account, bot) {
  if (bot === undefined || bot === null || bot === "") return account.home;
  return botDir(account, bot);
}

function terminalSize(body) {
  const cols = Math.min(Math.max(Math.floor(Number(body.cols)) || 80, 20), 500);
  const rows = Math.min(Math.max(Math.floor(Number(body.rows)) || 24, 5), 200);
  return { cols, rows };
}

async function createTerminal(account, body) {
  if (terminals.size >= MAX_TERMINALS) throw new HttpError(429, `At most ${MAX_TERMINALS} terminals at once`);
  const cwd = terminalCwd(account, body.bot);
  const { cols, rows } = terminalSize(body);

  const { default: pty } = await import("node-pty");
  const id = randomBytes(8).toString("hex");
  const shell = pty.spawn("bash", ["-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    ...asUser(account),
    env: agentEnv(account, { TERM: "xterm-256color", COLORTERM: "truecolor", SHELL: "/bin/bash" }),
  });
  const terminal = { id, user: account.id, shell, feed: new Feed(), viewers: 0, idle: null };
  terminals.set(id, terminal);
  shell.onData((data) => terminal.feed.publish({ data: Buffer.from(data).toString("base64") }));
  shell.onExit(({ exitCode }) => {
    terminal.feed.publish({ exit: exitCode });
    terminal.feed.close();
    terminals.delete(id);
  });
  touchTerminal(terminal);
  return { id, cwd };
}

function touchTerminal(terminal) {
  if (terminal.idle) clearTimeout(terminal.idle);
  terminal.idle = null;
  if (terminal.viewers === 0) {
    terminal.idle = setTimeout(() => closeTerminal(terminal.id), TERMINAL_IDLE_MS);
  }
}

function existingTerminal(account, id) {
  const terminal = terminals.get(id);
  if (!terminal || terminal.user !== account.id) throw new HttpError(404, "No such terminal");
  return terminal;
}

function closeTerminal(id) {
  const terminal = terminals.get(id);
  if (!terminal) return { ok: true };
  terminals.delete(id);
  if (terminal.idle) clearTimeout(terminal.idle);
  try {
    terminal.shell.kill("SIGHUP");
  } catch {
    /* already gone */
  }
  terminal.feed.close();
  return { ok: true };
}

const signIns = new Map();

function signInKey(account, engine) {
  return `${account.id}:${engine}`;
}

const SIGN_IN_CODE = /^[\x21-\x7e]{4,512}$/;

function cancelSignIns(account = null) {
  for (const [key, job] of [...signIns]) {
    if (account && !key.startsWith(`${account.id}:`)) continue;
    job.cancel();
    signIns.delete(key);
  }
}

function signedIn(account, engine) {
  return Promise.resolve(engine === "claude" && authStatus({ env: agentEnv(account), ...asUser(account) }).loggedIn === true);
}

async function startSignIn(account, engine) {
  dropSignIn(account, engine);
  const argv = signInArgv(engine, ENGINE_BINS);

  const { default: pty } = await import("node-pty");
  const env = agentEnv(account, { TERM: "xterm-256color", COLORTERM: "truecolor", BROWSER: "/bin/true" });

  delete env.CI;
  const key = signInKey(account, engine);
  const job = new SignInJob({
    engine,
    spawn: () =>
      pty.spawn(argv[0], argv.slice(1), {
        name: "xterm-256color",
        cols: SIGN_IN_COLS,
        rows: SIGN_IN_ROWS,
        cwd: account.home,
        ...asUser(account),
        env,
      }),
    confirm: () => signedIn(account, engine),
  });
  signIns.set(key, job);
  job.start();

  const sweep = setTimeout(() => {
    if (signIns.get(key) === job) signIns.delete(key);
  }, SIGN_IN_KEEP_MS + job.timeoutMs);
  if (typeof sweep.unref === "function") sweep.unref();
  return job;
}

async function signInRoute(request, parts, account) {
  const engine = parts[1];
  if (!Object.hasOwn(ENGINES, engine)) throw new HttpError(404, "No such engine");
  const action = parts[3];
  const job = signIns.get(signInKey(account, engine));
  if (request.method === "GET" && !action) return { signIn: job ? job.view() : null };
  if (request.method === "POST" && !action) return { signIn: (await startSignIn(account, engine)).view() };
  if (request.method === "POST" && action === "code") {
    const body = await readJson(request);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!SIGN_IN_CODE.test(code)) throw new HttpError(400, "That doesn't look like the code from the sign-in page");
    if (!needsCode(engine)) throw new HttpError(400, "This sign-in doesn't take a code");
    if (!job || job.state !== "waiting") throw new HttpError(409, "No sign-in is waiting for a code");
    job.write(code);
    return { signIn: job.view() };
  }
  if (request.method === "DELETE" && !action) {
    dropSignIn(account, engine);
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

function dropSignIn(account, engine) {
  const key = signInKey(account, engine);
  const job = signIns.get(key);
  if (!job) return;
  job.cancel();
  signIns.delete(key);
}

// One screen per bot of each person: its own display, its own runtime dir (the X cookie and the VNC
// socket, the person's alone) and its own Chrome, so bots work side by side instead of taking turns.
const screens = new Map();
const connections = new Map();

const screenKey = (account, bot) => `${account.id ?? ""}\n${bot}`;

export function desktopSize(body) {
  const width = Math.min(Math.max(Math.floor(Number(body.width)) || 1280, 640), 4096);
  const height = Math.min(Math.max(Math.floor(Number(body.height)) || 800, 480), 4096);
  return { width, height };
}

/** The lowest display no running screen has. */
export function freeDisplay(used, first = DESKTOP_DISPLAY) {
  let display = first;
  while (used.has(display)) display += 1;
  return display;
}

/**
 * The screen to stop so another can start when a person has `cap` running: the one used longest
 * ago that nobody watches and no bot or person drives; null when every one is in use.
 */
export function screenToStop(running, cap, viewers) {
  if (running.length < cap) return undefined;
  return running.filter((screen) => viewers(screen) === 0 && screen.control.holder === "free").sort((a, b) => a.used - b.used)[0] ?? null;
}

function screensOf(account) {
  return [...screens.values()].filter((screen) => screen.user === account.id);
}

function screenOf(account, bot) {
  return screens.get(screenKey(account, bot)) ?? null;
}

function vncSocketPath(screen) {
  return path.join(screen.run, "vnc.sock");
}

function displayEnv(screen) {
  return { DISPLAY: `:${screen.display}`, XAUTHORITY: path.join(screen.run, "Xauthority") };
}

// Run as the person, never as root: these are paths in their home, theirs to point anywhere.
const PREPARE_SCREEN = 'mkdir -p -m 700 "$1" && if [ -n "$4" ] && [ ! -e "$3" ] && [ -d "$2" ]; then mkdir -p "$(dirname "$3")" && mv "$2" "$3"; fi';

/**
 * Makes a bot's screen's runtime dir, and answers its Chrome profile; the profile from before each
 * bot had its own becomes the primary bot's, sign-ins and all.
 */
async function prepareScreen(account, bot, run, primary) {
  const profile = path.join(account.browsers, bot);
  const done = await runAsUser(account, ["sh", "-c", PREPARE_SCREEN, "sh", run, account.browser, profile, primary ? "1" : ""], { cwd: account.home, timeoutMs: 10_000 });
  if (done.exitCode !== 0) throw new HttpError(500, `The screen couldn't be set up: ${done.output.trim().slice(-300)}`);
  return profile;
}

function connectVnc(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function viewersOf(account, bot) {
  let n = 0;
  for (const connection of connections.values()) if (connection.user === account.id && (bot === undefined || connection.bot === bot)) n += 1;
  return n;
}

function screenStatus(account, bot) {
  const screen = screenOf(account, bot);
  return {
    bot,
    running: Boolean(screen),
    ready: Boolean(screen?.ready),
    width: screen?.width ?? null,
    height: screen?.height ?? null,
    viewers: viewersOf(account, bot),
    control: screen?.control.holder ?? "free",
  };
}

function listScreens(account) {
  return { screens: screensOf(account).map((screen) => screenStatus(account, screen.bot)) };
}

/** While the bots hold the screen, the person's viewers are shown it and nothing they do reaches it, whatever their page sends. */
async function applyViewerInput(account, screen) {
  const accept = screen.control.holder === "bots" ? 0 : 1;
  if (screen.viewerInput === accept) return;
  screen.viewerInput = accept;
  const results = await Promise.all(
    VIEWER_INPUT.map((name) => runAsUser(account, ["vncconfig", "-set", `${name}=${accept}`], { cwd: account.home, timeoutMs: VNCCONFIG_MS, env: displayEnv(screen) }).catch((error) => ({ exitCode: 1, output: error.message }))),
  );
  const failed = results.find((result) => result.exitCode !== 0);
  if (failed) {
    screen.viewerInput = null;
    console.warn(`[box] couldn't ${accept ? "give back" : "hold"} the viewers' input: ${failed.output.trim().slice(0, 200)}`);
  }
}

async function changeControl(account, screen, holder, by = null) {
  if (screen.botsHold) clearTimeout(screen.botsHold);
  screen.botsHold = null;
  if (holder === "bots") {
    screen.botsHold = setTimeout(() => {
      if (screens.get(screen.key) === screen && screen.control.holder === "bots") void changeControl(account, screen, "free");
    }, BOTS_HOLD_MS);
    screen.botsHold.unref?.();
  }
  if (screen.control.holder !== holder) screen.control = { holder, by, since: new Date().toISOString() };
  await applyViewerInput(account, screen);
}

async function setDesktopControl(account, bot, body) {
  let next;
  try {
    next = controlTransition(screenOf(account, bot)?.control.holder ?? "free", body);
  } catch (error) {
    throw new HttpError(error.status ?? 400, error.message);
  }
  const screen = screenOf(account, bot);
  if (!screen) throw new HttpError(404, "That screen isn't running");
  await screen.readyPromise;
  if (next) await changeControl(account, screen, next);
  return screenStatus(account, bot);
}

let systemBus = null;

function ensureSystemBus() {
  if (systemBus && systemBus.exitCode === null) return;
  if (process.getuid?.() !== 0) return;
  const runDir = "/run/dbus";
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.rmSync(path.join(runDir, "pid"), { force: true });
  } catch (error) {
    console.warn(`[box] could not prepare ${runDir}: ${error.message}`);
    return;
  }
  const child = spawn("dbus-daemon", ["--system", "--nofork", "--nopidfile"], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.on("data", (chunk) => {
    log = (log + chunk.toString("utf8")).slice(-1000);
  });
  child.on("error", (error) => console.warn(`[box] system bus didn't start: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (systemBus === child) systemBus = null;
    console.warn(`[box] system bus exited (${signal ?? code}): ${log.trim().slice(-300)}`);
  });
  systemBus = child;
}

async function ensureDesktop(account, bot, body = {}) {
  const running = screenOf(account, bot);
  if (running) {
    await running.readyPromise;
    return screenStatus(account, bot);
  }
  const run = path.join(account.run, "screens", bot);
  fs.mkdirSync(account.run, { recursive: true, mode: 0o700 });
  own(account.run, account);
  const profile = await prepareScreen(account, bot, run, body.primary === true);
  // Another request may have started it while that ran; from here to `screens.set` nothing waits.
  const started = screenOf(account, bot);
  if (started) {
    await started.readyPromise;
    return screenStatus(account, bot);
  }
  const stop = screenToStop(screensOf(account), SCREENS_PER_PERSON, (screen) => viewersOf(account, screen.bot));
  if (stop === null) throw new HttpError(429, `${SCREENS_PER_PERSON} of your bots are using their screens; one frees up when a bot finishes.`, "screens_full");
  if (stop) stopDesktop(account, stop.bot);
  const { width, height } = desktopSize(body);
  const display = freeDisplay(new Set([...screens.values()].map((screen) => screen.display)));
  ensureSystemBus();
  const child = spawn("bash", [DESKTOP_SCRIPT], {
    cwd: account.home,
    env: agentEnv(account, {
      DISPLAY: `:${display}`,
      DESKTOP_WIDTH: String(width),
      DESKTOP_HEIGHT: String(height),
      XDG_RUNTIME_DIR: run,
      XDG_CONFIG_HOME: path.join(account.home, ".config"),
      XDG_DATA_HOME: path.join(account.home, ".local", "share"),
      // A Chrome the person opens on this screen is the bot's, so it has the bot's sign-ins.
      GOND_BROWSER_PROFILE: profile,
    }),
    ...asUser(account),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const screen = {
    key: screenKey(account, bot),
    user: account.id,
    bot,
    display,
    run,
    profile,
    child,
    width,
    height,
    ready: false,
    idle: null,
    used: Date.now(),
    readyPromise: null,
    control: { holder: "free", by: null, since: new Date().toISOString() },
    botsHold: null,
    viewerInput: 1,
    lastShot: 0,
  };
  screens.set(screen.key, screen);
  let log = "";
  const collect = (chunk) => {
    log = (log + chunk.toString("utf8")).slice(-4000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", (code, signal) => {
    const unexpected = screens.get(screen.key) === screen;
    if (unexpected) {
      screens.delete(screen.key);
      browsers.close(account.id, bot);
    }
    if (screen.idle) clearTimeout(screen.idle);
    for (const connection of connections.values()) if (connection.user === account.id && connection.bot === bot) closeConnection(connection.id);
    if (unexpected) console.warn(`[box] ${account.name}'s screen for ${bot} exited (${signal ?? code}): ${log.trim().slice(-500)}`);
  });
  child.on("error", (error) => console.error(`[box] ${account.name}'s screen for ${bot} failed to start`, error));

  screen.readyPromise = (async () => {
    const deadline = Date.now() + DESKTOP_START_MS;
    while (Date.now() < deadline) {
      if (screens.get(screen.key) !== screen) throw new HttpError(502, `The screen didn't start: ${log.trim().slice(-300) || "no output"}`);
      try {
        const probe = await connectVnc(vncSocketPath(screen));
        probe.destroy();
        screen.ready = true;
        touchDesktop(account, bot);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    stopDesktop(account, bot);
    throw new HttpError(504, "The screen didn't start in time");
  })();
  await screen.readyPromise;
  return screenStatus(account, bot);
}

function touchDesktop(account, bot) {
  const screen = screenOf(account, bot);
  if (!screen) return;
  screen.used = Date.now();
  if (screen.idle) clearTimeout(screen.idle);
  screen.idle = null;
  if (viewersOf(account, bot) === 0) screen.idle = setTimeout(() => stopDesktop(account, bot), DESKTOP_IDLE_MS);
}

/** Stops a bot's screen and its browser, or every screen of the person's without a bot. */
function stopDesktop(account, bot) {
  if (bot === undefined) {
    for (const screen of screensOf(account)) stopDesktop(account, screen.bot);
    browsers.close(account.id);
    return { ok: true };
  }
  const current = screenOf(account, bot);
  screens.delete(screenKey(account, bot));
  browsers.close(account.id, bot);
  for (const connection of connections.values()) if (connection.user === account.id && connection.bot === bot) closeConnection(connection.id);
  if (!current) return { ok: true };
  if (current.idle) clearTimeout(current.idle);
  if (current.botsHold) clearTimeout(current.botsHold);
  try {
    process.kill(-current.child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const force = setTimeout(() => {
    try {
      process.kill(-current.child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5000);
  current.child.once("exit", () => clearTimeout(force));
  return { ok: true };
}

async function createConnection(account, bot, body) {
  if (viewersOf(account) >= MAX_DESKTOP_CONNECTIONS) {
    throw new HttpError(429, `At most ${MAX_DESKTOP_CONNECTIONS} screen viewers at once`);
  }
  await ensureDesktop(account, bot, body);
  const screen = screenOf(account, bot);
  let socket;
  try {
    socket = await connectVnc(vncSocketPath(screen));
  } catch (error) {
    throw new HttpError(502, `Could not reach the screen's VNC server: ${error.message}`);
  }
  const id = randomBytes(8).toString("hex");
  const connection = { id, user: account.id, bot, socket, response: null, claim: null };
  socket.pause();
  socket.on("error", () => closeConnection(id));
  socket.on("close", () => closeConnection(id));
  connection.claim = setTimeout(() => closeConnection(id), CONNECTION_CLAIM_MS);
  connections.set(id, connection);
  touchDesktop(account, bot);
  return { id, width: screen?.width ?? null, height: screen?.height ?? null };
}

function existingConnection(account, bot, id) {
  const connection = connections.get(id);
  if (!connection || connection.user !== account.id || connection.bot !== bot) throw new HttpError(404, "No such screen connection");
  return connection;
}

function closeConnection(id) {
  const connection = connections.get(id);
  if (!connection) return { ok: true };
  connections.delete(id);
  if (connection.claim) clearTimeout(connection.claim);
  connection.socket.destroy();
  connection.response?.end();
  connection.response = null;
  const account = accounts.get(connection.user);
  if (account) touchDesktop(account, connection.bot);
  return { ok: true };
}

function stopAllDesktops() {
  for (const screen of [...screens.values()]) {
    const account = accounts.get(screen.user);
    if (account) stopDesktop(account, screen.bot);
    else screens.delete(screen.key);
  }
  for (const connection of [...connections.values()]) closeConnection(connection.id);
  browsers.closeAll();
}

/**
 * Streams VNC bytes to one viewer as base64 server-sent events. Nothing is
 * replayed: a VNC connection is one stateful conversation, so when the
 * stream ends the connection ends with it.
 */
function streamConnection(request, response, connection) {
  if (connection.response) throw new HttpError(409, "That connection already has a viewer");
  if (connection.claim) clearTimeout(connection.claim);
  connection.claim = null;
  connection.response = response;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const { socket } = connection;
  socket.on("data", (chunk) => {
    if (!response.write(`data: ${chunk.toString("base64")}\n\n`)) socket.pause();
  });
  response.on("drain", () => socket.resume());
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  request.on("close", () => {
    clearInterval(keepalive);
    closeConnection(connection.id);
  });
  socket.resume();
}

async function desktopRoute(request, response, parts, account) {
  if (parts.length === 1) {
    if (request.method === "GET") return listScreens(account);
    if (request.method === "DELETE") return stopDesktop(account);
    throw new HttpError(404, "Not found");
  }
  const bot = parts[1];
  if (!ID.test(bot)) throw new HttpError(404, "Not found");
  if (parts.length === 2) {
    if (request.method === "GET") return screenStatus(account, bot);
    if (request.method === "POST") return ensureDesktop(account, bot, await readJson(request));
    if (request.method === "DELETE") return stopDesktop(account, bot);
    throw new HttpError(404, "Not found");
  }
  if (parts.length === 3 && parts[2] === "control") {
    if (request.method === "POST") return setDesktopControl(account, bot, await readJson(request));
    throw new HttpError(404, "Not found");
  }
  if (parts[2] !== "connections") throw new HttpError(404, "Not found");
  const id = parts[3];
  const action = parts[4];
  if (request.method === "POST" && !id) return createConnection(account, bot, await readJson(request));
  if (!id) throw new HttpError(404, "Not found");
  const connection = existingConnection(account, bot, id);
  if (request.method === "DELETE" && !action) return closeConnection(id);
  if (request.method === "GET" && action === "stream") {
    streamConnection(request, response, connection);
    return STREAMED;
  }
  if (request.method === "POST" && action === "input") {
    const body = await readJson(request);
    if (typeof body.data !== "string") throw new HttpError(400, "Missing data");
    connection.socket.write(Buffer.from(body.data, "base64"));
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

/**
 * Reads a file the person's process just wrote in their runtime dir, as
 * root: never through a link (theirs to plant), never a FIFO, and only a
 * PNG. Answers null when there is nothing there.
 */
function readShot(dir, name) {
  if (fs.realpathSync(dir) !== path.resolve(dir)) throw new HttpError(500, "The screenshot folder isn't where it should be");
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(path.join(dir, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = fs.readFileSync(fd);
    return pngSize(buffer) ? buffer : null;
  } finally {
    fs.closeSync(fd);
  }
}

async function takeScreenshot(account, desktop, signal) {
  const gap = desktop.lastShot + SCREENSHOT_GAP_MS - Date.now();
  if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
  desktop.lastShot = Date.now();
  const dir = path.join(desktop.run, "computer");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  own(dir, account);
  const shot = path.join(dir, "shot.png");
  const thumb = path.join(dir, "shot-thumb.png");
  const size = thumbSize(desktop);
  const wantThumb = size.width !== desktop.width || size.height !== desktop.height;
  const scrot = (args) => runAsUser(account, ["scrot", "-o", ...args, shot], { cwd: account.home, timeoutMs: SCREENSHOT_MS, env: displayEnv(desktop), signal });
  let result = await scrot(wantThumb ? ["-t", `${size.width}x${size.height}`] : []);
  try {
    let full = readShot(dir, "shot.png");
    if (!full && wantThumb && !signal?.aborted) {
      result = await scrot([]);
      full = readShot(dir, "shot.png");
    }
    if (!full) throw new HttpError(502, `The screenshot failed: ${result.output.trim().slice(-300) || `scrot exited ${result.exitCode}`}`);
    const small = readShot(dir, "shot-thumb.png") ?? full;
    const measured = pngSize(small);
    return { image: small, width: measured.width, height: measured.height, full };
  } finally {
    for (const file of [shot, thumb]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* the next one overwrites it */
      }
    }
  }
}

/**
 * Runs one batch of a bot's steps on the person's desktop (xdotool) or in
 * their browser (the persistent host), then answers with one screenshot.
 * A step that fails stops the batch; the answer says which, with the screen
 * as it is, so the model can see why.
 */
async function computerRoute(request, response, account) {
  const body = await readJson(request);
  if (typeof body.bot !== "string" || !ID.test(body.bot)) throw new HttpError(400, "Bad bot id");
  if (body.saveTo !== undefined && typeof body.saveTo !== "string") throw new HttpError(400, "saveTo must be a path");
  const target = body.target ?? "desktop";
  const saveTo = body.saveTo ? writableInsideHome(body.saveTo, account.home, forbiddenIn(account)) : null;
  await ensureDesktop(account, body.bot, { primary: body.primary === true });
  const desktop = screenOf(account, body.bot);
  if (!desktop) throw new HttpError(502, "The screen isn't running");
  touchDesktop(account, body.bot);
  let steps;
  try {
    steps = parseSteps(body.steps, target, target === "browser" ? VIEWPORT : desktop);
  } catch (error) {
    if (error instanceof ComputerActionError) throw new HttpError(400, error.message);
    throw error;
  }
  const view = body.view === undefined ? "both" : body.view;
  if (!["both", "image", "text"].includes(view)) throw new HttpError(400, "view must be both, image or text");
  // An upload names a file in the person's home, never a sign-in folder or anything outside it.
  for (const step of steps) if (step.type === "upload") step.path = insideHome(step.path.replace(/^~\//, ""), account.home, forbiddenIn(account));

  const abort = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) abort.abort();
  });
  if (usesInput(steps)) {
    if (desktop.control.holder === "person") throw new HttpError(409, PERSON_HAS_CONTROL, "person_has_control");
    await changeControl(account, desktop, "bots", desktop.control.holder === "bots" ? desktop.control.by : body.bot);
  }
  const answer = (extra) => ({ ok: true, target, control: desktop.control.holder, screen: { width: desktop.width, height: desktop.height }, ...extra });
  const saved = async (png, extra) => {
    await fileJob(account, { op: "write", path: saveTo, content: png.toString("base64"), encoding: "base64" });
    const size = pngSize(png);
    return answer({ ...extra, width: size.width, height: size.height });
  };

  if (target === "browser") {
    let result;
    try {
      result = await browsers.run(account, steps, abort.signal, { view, format: saveTo ? "png" : "jpeg", bot: body.bot });
    } catch (error) {
      if (error instanceof BrowserError) throw new HttpError(error.status, error.message);
      throw error;
    }
    const { image, ...page } = result;
    if (saveTo && image) return saved(Buffer.from(image, "base64"), page);
    return answer(image ? { ...page, image } : page);
  }

  const done = [];
  const outputs = [];
  let failed = null;
  const xclip = { ...asUser(account), env: agentEnv(account, displayEnv(desktop)), cwd: account.home, detached: true };
  for (const [index, step] of steps.entries()) {
    if (abort.signal.aborted) throw new HttpError(499, "The request was closed");
    if (step.type === "wait") await new Promise((resolve) => setTimeout(resolve, step.ms));
    if (step.type === "copy" || step.type === "paste" || step.type === "clipboard") {
      try {
        if (step.type === "paste" && step.text !== null) await writeXclip(step.text, spawn, xclip);
        const keys = step.type === "copy" ? ["ctrl+c"] : step.type === "paste" ? ["ctrl+v"] : [];
        if (keys.length) {
          const pressed = await runAsUser(account, ["xdotool", "key", "--clearmodifiers", ...keys], { cwd: account.home, timeoutMs: STEP_TIMEOUT_MS, env: displayEnv(desktop), signal: abort.signal });
          if (pressed.exitCode !== 0) throw new Error(pressed.output.trim().slice(-300) || `xdotool exited ${pressed.exitCode}`);
        }
        if (step.type !== "paste") {
          // The copy lands a moment after the keys.
          if (step.type === "copy") await new Promise((resolve) => setTimeout(resolve, 150));
          outputs.push({ index, text: clipText(await readXclip(spawn, xclip)) });
        }
      } catch (error) {
        failed = { index, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
        break;
      }
      done.push(describeStep(step));
      continue;
    }
    const argv = xdotoolArgv(step);
    if (argv) {
      const result = await runAsUser(account, argv, { cwd: account.home, timeoutMs: stepTimeoutMs(step), env: displayEnv(desktop), input: xdotoolStdin(step), signal: abort.signal });
      if (result.exitCode !== 0) {
        if (abort.signal.aborted) throw new HttpError(499, "The request was closed");
        failed = { index, message: result.output.trim().slice(-300) || `xdotool exited ${result.exitCode}` };
        break;
      }
    }
    done.push(describeStep(step));
  }
  const delay = settleMs(steps);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const shot = await takeScreenshot(account, desktop, abort.signal);
  if (saveTo) return saved(shot.full, { done, error: failed, outputs });
  return answer({ image: shot.image.toString("base64"), mime: "image/png", width: shot.width, height: shot.height, done, error: failed, outputs });
}

function loadToken() {
  if (process.env.BOX_TOKEN) return process.env.BOX_TOKEN;
  const file = path.join(STATE_DIR, "token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* generate below */
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o640 });
  try {
    fs.chownSync(file, 0, TOKEN_READER_GID);
    fs.chmodSync(STATE_DIR, 0o750);
    fs.chownSync(STATE_DIR, 0, TOKEN_READER_GID);
  } catch (error) {
    console.warn(`[box] could not set token file ownership: ${error.message}`);
  }
  return token;
}

function authorized(request, token) {
  const header = request.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

let update = null;

export function updateStatus() {
  if (!update) return { running: false };
  return {
    running: update.finishedAt === null,
    startedAt: update.startedAt,
    finishedAt: update.finishedAt,
    ok: update.ok,
    exitCode: update.exitCode,
    log: update.log,
  };
}

function refuseWhileUpdating() {
  if (update && update.finishedAt === null) throw new HttpError(503, "The computer is updating; try again in a few minutes.");
}

async function pauseEverything() {
  stopAllDesktops();
  cancelSignIns();
  for (const id of [...terminals.keys()]) closeTerminal(id);
  await Promise.allSettled([...agents.values()].map((agent) => agent.close({ keepSession: true })));
  agents.clear();
}

async function closeAccountWork(account) {
  stopDesktop(account);
  cancelSignIns(account);
  for (const [id, terminal] of [...terminals]) if (terminal.user === account.id) closeTerminal(id);
  for (const [id, agent] of [...agents]) {
    if (agent.user !== account.id) continue;
    agents.delete(id);
    await agent.close({ keepSession: false });
  }
  sessions.forgetUser(account.id);
}

async function resetAccountHome(account) {
  stopDesktop(account);
  cancelSignIns(account);
  for (const [id, terminal] of [...terminals]) if (terminal.user === account.id) closeTerminal(id);
  for (const [id, agent] of [...agents]) {
    if (agent.user !== account.id) continue;
    agents.delete(id);
    await agent.close({ keepSession: true });
  }
  const removed = accounts.refreshHome(account);
  return { ok: true, removed: removed.length };
}

async function startUpdate() {
  if (update && update.finishedAt === null) throw new HttpError(409, "An update is already running");
  update = { startedAt: new Date().toISOString(), finishedAt: null, ok: null, exitCode: null, log: "" };
  const append = (text) => {
    update.log = (update.log + text).slice(-UPDATE_LOG_BYTES);
  };
  append("== Pausing the computer\n");
  await pauseEverything();
  append("Bots, terminals and the desktop are paused.\n");
  const child = spawn("bash", [UPDATE_SCRIPT], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" }, stdio: ["ignore", "pipe", "pipe"] });
  const current = update;
  const timer = setTimeout(() => {
    append("\n== Timed out; stopping the update\n");
    child.kill("SIGKILL");
  }, UPDATE_TIMEOUT_MS);
  child.stdout.on("data", (chunk) => append(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => append(chunk.toString("utf8")));
  child.on("error", (error) => {
    clearTimeout(timer);
    append(`\nCould not run the update script: ${error.message}\n`);
    current.ok = false;
    current.exitCode = 1;
    current.finishedAt = new Date().toISOString();
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    current.exitCode = code ?? (signal ? 128 : 1);
    current.ok = current.exitCode === 0;
    current.finishedAt = new Date().toISOString();
    versionsCache = null;
    forgetClaudeVersion();
  });
  return { ok: true, startedAt: update.startedAt };
}

async function resetHome() {
  if (update && update.finishedAt === null) throw new HttpError(409, "An update is running");

  await pauseEverything();
  sessions.clear();
  const { removed, accounts: people } = accounts.reset({ keepLogins: true });
  versionsCache = null;
  return { ok: true, removed, accounts: people };
}

const MODELS_CACHE_MS = 5 * 60 * 1000;
const modelsCache = new Map();

async function enginesModels(account, engine) {
  const key = `${account.id}:${engine}`;
  const cached = modelsCache.get(key);
  if (cached && Date.now() - cached.at < MODELS_CACHE_MS) return cached.models;
  const models = await engineModels(engine, { bins: ENGINE_BINS, env: agentEnv(account), ...asUser(account) }).catch(() => []);
  if (models.length) modelsCache.set(key, { at: Date.now(), models });
  return models;
}

let versionsCache = null;
const VERSIONS_CACHE_MS = 5 * 60 * 1000;

function commandVersion(command, args) {
  return new Promise((resolve) => {
    const account = agentAccount();
    const child = spawn(command, args, { env: agentEnv(account), ...asUser(account), stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8").trim().split("\n")[0] || null));
  });
}

async function versions() {
  if (versionsCache && Date.now() - versionsCache.at < VERSIONS_CACHE_MS) return versionsCache.value;
  const [bun, claude] = await Promise.all([commandVersion("bun", ["--version"]), commandVersion("claude", ["--version"])]);
  const value = { node: process.versions.node, bun, claude };
  versionsCache = { at: Date.now(), value };
  return value;
}

function readBytes(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function readJson(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Body must be JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  response.end(json);
}

const STREAMED = Symbol("streamed");

export const ENGINES = { claude: AgentSession };
const ENGINE_BINS = { claude: CLAUDE_BIN };

export const MODEL_ID = /^[A-Za-z0-9._:/-]{0,120}$/;

const agents = new Map();
const sessions = createSessionStore(path.join(STATE_DIR, "sessions.json"));

function rememberSession(agent) {
  sessions.remember(agent.id, agent.sessionId ? { user: agent.user, engine: agent.engine, sessionId: agent.sessionId } : null);
}

async function agentFor(account, id, bot, engine = "claude") {
  if (!ID.test(id)) throw new HttpError(400, "Bad agent id");
  const cwd = botDir(account, bot);
  let agent = agents.get(id);
  if (agent && agent.user !== account.id) throw new HttpError(404, "No such agent");
  if (agent && agent.engine !== engine) {
    agents.delete(id);
    await agent.close({ keepSession: false });
    sessions.forget(id);
    agent = undefined;
  }
  if (!agent) {
    const Session = ENGINES[engine];
    agent = new Session({
      id,
      cwd,
      env: agentEnv(account),
      ...asUser(account),
      socketDir: AGENT_SOCKET_DIR,
      mcpScript: GOND_MCP_SCRIPT,
      logDir: path.join(account.bots, ".protocol"),
      onWarning: (text) => console.warn(`[box] ${id}: ${text}`),
    });
    agent.user = account.id;
    agent.sessionId = sessions.get(id, account.id, engine);
    agents.set(id, agent);
  }
  return agent;
}

function ownAgent(account, id) {
  const agent = agents.get(id);
  return agent && agent.user === account.id ? agent : undefined;
}

async function agentTurnRoute(request, response, id, account) {
  // First, before any await: an API that hangs up while the session starts
  // (a stop) must still stop the turn, which then refuses to begin.
  const stop = new AbortController();
  response.on("close", () => stop.abort());
  const body = await readJson(request, MAX_TURN_BODY_BYTES);
  const engine = body.engine ?? "claude";
  if (!Object.hasOwn(ENGINES, engine)) throw new HttpError(400, "Unknown engine");

  if (typeof body.model !== "string" || !MODEL_ID.test(body.model) || (engine === "claude" && !body.model)) throw new HttpError(400, "Bad model id");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "Missing prompt");
  if (body.followUp !== undefined && typeof body.followUp !== "string") throw new HttpError(400, "Bad follow-up");
  if (typeof body.bot !== "string" || !ID.test(body.bot)) throw new HttpError(400, "Bad bot id");
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const tools = Array.isArray(body.tools) ? body.tools.filter((tool) => tool && typeof tool.name === "string") : [];
  const maxTurns = Number.isInteger(body.maxTurns) && body.maxTurns > 0 ? Math.min(body.maxTurns, 500) : null;
  const permission = PERMISSION_MODES.includes(body.permission) ? body.permission : "ask";
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || MAX_AGENT_TURN_MS, 1000), MAX_AGENT_TURN_MS);
  const images = Array.isArray(body.attachments) ? body.attachments : [];
  if (ownAgent(account, id)?.turn) throw new HttpError(409, "This bot is already answering");
  const agent = await agentFor(account, id, body.bot, engine);

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const sendEvent = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  try {
    const settings = { model: body.model, maxTurns, systemPrompt, tools, permission, mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [], access: parseAccess(body.access) };
    let launch = await agent.ensure(settings);
    let result = await agent.turnWith({ prompt: turnPrompt(body, launch), images, timeoutMs, systemPrompt, onEvent: sendEvent, signal: stop.signal });
    let recovered = Boolean(launch.recovered);
    if (result.resumeFailed && !stop.signal.aborted) {
      await agent.close({ keepSession: false });
      launch = await agent.ensure(settings);
      recovered = true;
      result = await agent.turnWith({ prompt: body.prompt, images, timeoutMs, systemPrompt, onEvent: sendEvent, signal: stop.signal });
    }
    rememberSession(agent);
    sendEvent({ type: "result", ...result, sessionId: agent.sessionId, launched: launch.launched, resumed: launch.resumed ?? false, recovered });
  } catch (error) {
    const missing = error.code === "ENOENT" || error.code === "EACCES";
    sendEvent({ type: "error", missing, message: missing ? `The ${ENGINE_BINS[engine]} CLI isn't installed in the box` : error.message });
  } finally {
    clearInterval(keepalive);
    response.end();
  }
  return STREAMED;
}

async function agentRoute(request, response, parts, account) {
  const id = parts[1];
  const action = parts[2];
  if (request.method === "GET" && !id) {
    return { agents: [...agents.values()].map((agent) => ({ id: agent.id, user: agent.user ?? null, running: agent.running, busy: Boolean(agent.turn) })) };
  }
  if (!id) throw new HttpError(404, "Not found");
  if (request.method === "POST" && action === "turn") return agentTurnRoute(request, response, id, account);
  if (request.method === "POST" && action === "tool-result") {
    const body = await readJson(request, MAX_TURN_BODY_BYTES);
    const agent = ownAgent(account, id);
    if (!agent || typeof body.callId !== "string") throw new HttpError(404, "No such call");
    let content;
    try {
      content = toolResultContent(body.content);
    } catch (error) {
      throw new HttpError(error.status ?? 400, error.message);
    }
    if (!agent.answerTool(body.callId, { content, isError: Boolean(body.isError) })) throw new HttpError(404, "No such call");
    return { ok: true };
  }

  if (request.method === "POST" && action === "steer") {
    const body = await readJson(request);
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_STEER_CHARS) throw new HttpError(400, "Bad steer");
    const agent = ownAgent(account, id);
    return { steered: agent?.turn && typeof agent.steer === "function" ? await agent.steer(body.text) : false };
  }
  if (request.method === "POST" && action === "interrupt") {
    const agent = ownAgent(account, id);
    if (agent?.turn) agent.kill();
    return { ok: true, interrupted: Boolean(agent?.turn) };
  }
  if (request.method === "DELETE" && !action) {
    const agent = ownAgent(account, id);
    if (agent) {
      agents.delete(id);
      await agent.close({ keepSession: false });
    }
    sessions.forget(id, account.id);
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

async function terminalRoute(request, response, parts, account) {
  const id = parts[1];
  const action = parts[2];
  if (request.method === "POST" && !id) return createTerminal(account, await readJson(request));
  if (!id) throw new HttpError(404, "Not found");
  const terminal = existingTerminal(account, id);
  if (request.method === "DELETE" && !action) return closeTerminal(id);
  if (request.method === "GET" && action === "stream") {
    terminal.viewers += 1;
    touchTerminal(terminal);
    streamFeed(request, response, terminal.feed);
    request.on("close", () => {
      terminal.viewers -= 1;
      if (terminals.has(id)) touchTerminal(terminal);
    });
    return STREAMED;
  }
  if (request.method === "POST" && action === "input") {
    const body = await readJson(request);
    if (typeof body.data !== "string") throw new HttpError(400, "Missing data");
    terminal.shell.write(Buffer.from(body.data, "base64").toString("utf8"));
    return { ok: true };
  }
  if (request.method === "POST" && action === "resize") {
    const { cols, rows } = terminalSize(await readJson(request));
    terminal.shell.resize(cols, rows);
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

function accountFor(request) {
  const id = String(request.headers["x-gond-user"] ?? request.headers[LEGACY_USER_HEADER] ?? "").trim();
  if (!id) throw new HttpError(400, "Missing X-Gond-User");
  if (!USER_ID.test(id)) throw new HttpError(400, "Bad user id");
  const account = accounts.get(id);
  if (!account) throw new HttpError(404, "No such account on the box", "no_account");
  return account;
}

async function accountsRoute(request, parts) {
  if (request.method === "POST" && parts.length === 1) {
    const body = await readJson(request);
    if (typeof body.id !== "string" || !USER_ID.test(body.id)) throw new HttpError(400, "Bad user id");
    let account;
    try {
      account = accounts.ensure({ id: body.id, name: typeof body.name === "string" ? body.name : "", email: typeof body.email === "string" ? body.email : "", admin: Boolean(body.admin) });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    return { ok: true, account: { id: account.id, name: account.name, uid: account.uid ?? null, home: account.home } };
  }
  if (request.method === "GET" && parts.length === 1) {
    return { accounts: accounts.list().map((account) => ({ id: account.id, name: account.name, uid: account.uid ?? null, home: account.home, admin: account.admin })) };
  }
  if (request.method === "DELETE" && parts.length === 2) {
    if (!USER_ID.test(parts[1])) throw new HttpError(400, "Bad user id");
    const account = accounts.get(parts[1]);

    if (!account) return { ok: true, removed: accounts.remove(parts[1]) };
    if (account.admin) throw new HttpError(400, "The admin's account can't be removed");
    await closeAccountWork(account);
    return { ok: true, removed: accounts.remove(parts[1]) };
  }
  throw new HttpError(404, "Not found");
}

async function route(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "update") {
    if (request.method === "GET" && parts.length === 1) return updateStatus();
    if (request.method === "POST" && parts.length === 1) return startUpdate();
    throw new HttpError(404, "Not found");
  }
  if (request.method === "POST" && parts.length === 1 && parts[0] === "reset") return resetHome();
  if (request.method === "GET" && parts.length === 1 && parts[0] === "versions") return versions();
  if (parts[0] === "accounts") return accountsRoute(request, parts);

  if (parts[0] === "skills") {
    const owner = accountFor(request);
    if (request.method === "GET" && parts.length === 1) return listSkillFiles(owner);
    if (request.method === "PUT" && parts.length === 2) return writeSkillFolder(owner, parts[1], (await readJson(request, MAX_SKILL_BODY_BYTES)).files);
    if (request.method === "DELETE" && parts.length === 2) return deleteSkillFolder(owner, parts[1]);
    throw new HttpError(404, "Not found");
  }

  if (!(request.method === "GET" && (parts[0] === "files" || (parts[0] === "agents" && parts.length === 1)))) refuseWhileUpdating();
  const account = accountFor(request);
  if (request.method === "POST" && parts.length === 2 && parts[0] === "home" && parts[1] === "reset") return resetAccountHome(account);
  if (parts[0] === "terminals") return terminalRoute(request, response, parts, account);
  if (parts[0] === "desktop") return desktopRoute(request, response, parts, account);
  if (request.method === "POST" && parts.length === 1 && parts[0] === "computer") return computerRoute(request, response, account);
  if (parts[0] === "agents") return agentRoute(request, response, parts, account);
  if (request.method === "GET" && parts.length === 2 && parts[0] === "claude" && parts[1] === "auth") {
    return authStatus({ env: agentEnv(account), ...asUser(account) });
  }
  if (request.method === "POST" && parts.length === 2 && parts[0] === "claude" && parts[1] === "check") {
    return checkClaude({ cwd: account.home, env: agentEnv(account), ...asUser(account) });
  }
  if (parts[0] === "engines" && parts.length >= 3 && parts[2] === "sign-in") return signInRoute(request, parts, account);
  if (request.method === "GET" && parts.length === 3 && parts[0] === "engines" && parts[2] === "models") {
    if (!Object.hasOwn(ENGINES, parts[1])) throw new HttpError(404, "No such engine");
    return { models: await enginesModels(account, parts[1]) };
  }

  if (parts.length === 2 && parts[0] === "bots") {
    if (!ID.test(parts[1])) throw new HttpError(400, "Bad bot id");
    if (request.method === "POST") return { ok: true, dir: botDir(account, parts[1]) };
    if (request.method === "DELETE") {
      for (const [id, agent] of agents) {
        if (agent.user === account.id && (id === parts[1] || id.startsWith(`${parts[1]}--`))) {
          agents.delete(id);
          await agent.close({ keepSession: false });
          sessions.forget(id);
        }
      }

      return fileJob(account, { op: "delete", path: path.join(account.bots, parts[1]) });
    }
  }

  if (request.method === "POST" && parts.length === 1 && parts[0] === "exec") {
    const body = await readJson(request);
    if (typeof body.command !== "string" || !body.command.trim()) {
      throw new HttpError(400, "Missing command");
    }
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, 1000),
      MAX_EXEC_TIMEOUT_MS,
    );
    const cwd = boxCwd(body.cwd, account.home, forbiddenIn(account));
    if (!fs.existsSync(cwd)) throw new HttpError(404, "No such directory");
    return runAsUser(account, ["bash", "-lc", body.command], { cwd, timeoutMs, env: execEnv(body.env, agentEnv(account)) });
  }
  if (request.method === "GET" && parts.length === 2 && parts[0] === "files" && parts[1] === "raw") return sendRawFile(response, account, url.searchParams.get("path"));
  if (request.method === "PUT" && parts.length === 2 && parts[0] === "files" && parts[1] === "raw") return uploadFile(request, account, url.searchParams.get("path"));
  if (request.method === "GET" && parts.length === 2 && parts[0] === "files" && parts[1] === "preview") return imagePreview(account, url.searchParams.get("path"), url.searchParams.get("type"));
  if (parts.length === 1 && parts[0] === "files") {
    if (request.method === "GET") return readFile(account, url.searchParams.get("path"));
    if (request.method === "PUT") {
      const body = await readJson(request);
      return writeFile(account, body.path, body.content);
    }
    if (request.method === "DELETE") return deleteFile(account, url.searchParams.get("path"));
  }
  throw new HttpError(404, "Not found");
}

function adoptVisibleDirs() {
  const agent = agentAccount();

  for (const [old, dir] of [["bots", agent.bots], ["team", agent.team]]) {
    const from = path.join(agent.home, old);
    if (from === dir || !fs.existsSync(from)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        const source = path.join(from, entry);
        const target = path.join(dir, entry);
        if (fs.existsSync(target)) continue;
        try {
          fs.renameSync(source, target);
        } catch {
          fs.cpSync(source, target, { recursive: true });
          fs.rmSync(source, { recursive: true, force: true });
        }
      }
      if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
      console.info(`[box] moved ${old} to ${path.basename(dir)}`);
    } catch (error) {
      console.warn(`[box] could not move ${old} to ${path.basename(dir)}: ${error.message}`);
    }
  }
}

export function startServer({ port = PORT, host = HOST } = {}) {
  const token = loadToken();
  adoptVisibleDirs();
  fs.mkdirSync(SKILLS_ROOT, { recursive: true, mode: 0o755 });
  accounts.clearLegacySkills();

  accounts.materialize(agentAccount());
  accounts.adoptLegacyNames();
  accounts.restore();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://box");
    if (url.pathname === "/health") return send(response, 200, { ok: true, agents: agents.size, screens: screens.size, updating: Boolean(update && update.finishedAt === null) });
    if (!authorized(request, token)) return send(response, 401, { error: "Unauthorized" });
    try {
      const result = await route(request, response, url);
      if (result !== STREAMED) send(response, 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("[box]", error);
      if (!response.headersSent) send(response, status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      else response.end();
    }
  });
  server.listen(port, host, () => console.info(`[box] listening on ${host}:${port}`));
  const shutdown = async () => {
    server.close();
    stopAllDesktops();
    cancelSignIns();
    systemBus?.kill("SIGTERM");
    for (const terminal of terminals.keys()) closeTerminal(terminal);
    await Promise.allSettled([...agents.values()].map((agent) => agent.close({ keepSession: true })));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
