export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

export const SIGN_IN_KEEP_MS = 5 * 60 * 1000;

export const SIGN_IN_COLS = 400;
export const SIGN_IN_ROWS = 50;

const TRANSCRIPT_BYTES = 16 * 1024;

export function signInArgv(engine, bins) {
  if (engine === "claude") return [bins.claude, "auth", "login", "--claudeai"];
  if (engine === "codex") return [bins.codex, "login", "--device-auth"];
  if (engine === "grok") return [bins.grok, "login", "--device-auth"];
  throw new Error(`Unknown engine ${engine}`);
}

export function needsCode(engine) {
  return engine === "claude";
}

const ANSI =

  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[@-Z\\-_=>]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, "").replace(/\r/g, "");
}

const URL_AT = {
  claude: /https:\/\/claude\.com\/\S*oauth\S*/i,
  codex: /https:\/\/auth\.openai\.com\/\S+/i,
  grok: /https:\/\/accounts\.x\.ai\/\S+/i,
};

const CODE = /\b[A-Z0-9]{3,8}-[A-Z0-9]{3,8}\b/;

function firstUrl(engine, text) {
  const found = URL_AT[engine]?.exec(text) ?? /https:\/\/\S+/i.exec(text);
  if (!found) return null;
  const url = found[0].replace(/[).,'"\]]+$/, "");
  const again = url.indexOf("https://", 8);
  return again === -1 ? url : url.slice(0, again);
}

export function parseSignIn(engine, text) {
  const clean = stripAnsi(text);
  const url = firstUrl(engine, clean) ?? firstUrl(engine, clean.replace(/\n[ \t]*/g, ""));
  if (engine === "claude") return { url, code: null };
  const fromUrl = url ? /[?&]user_code=([A-Za-z0-9-]+)/.exec(url)?.[1] : null;
  const labelled = /(?:one-time code|Confirm this code)[^\n]*\n\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})/i.exec(clean)?.[1];
  const code = fromUrl ?? labelled ?? CODE.exec(url ? clean.slice(clean.indexOf(url) + url.length) : clean)?.[0] ?? null;
  return { url, code };
}

export function signInReady(engine, parsed) {
  return Boolean(parsed.url) && (needsCode(engine) || Boolean(parsed.code));
}

export function lastLine(text, max = 200) {
  const lines = stripAnsi(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^WARNING/i.test(line));
  return (lines.at(-1) ?? "").slice(0, max);
}

export class SignInJob {
  constructor({ engine, spawn, confirm, timeoutMs = SIGN_IN_TIMEOUT_MS, now = () => new Date() }) {
    this.engine = engine;
    this.spawnPty = spawn;
    this.confirm = confirm;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.state = "starting";
    this.url = null;
    this.code = null;
    this.error = null;
    this.startedAt = now().toISOString();
    this.pty = null;
    this.timer = null;
    this.finished = false;

    this.transcript = "";

    /** What was typed in: the terminal echoes it, and it must not end up in an error. */
    this.typed = [];
  }

  start() {
    this.pty = this.spawnPty();
    this.pty.onData((data) => this.read(data));
    this.pty.onExit(({ exitCode }) => {
      void this.finish(exitCode);
    });
    this.timer = setTimeout(() => this.fail("The sign-in took too long. Start it again."), this.timeoutMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this;
  }

  read(data) {
    this.transcript = (this.transcript + data).slice(-TRANSCRIPT_BYTES);
    if (this.state !== "starting") return;
    const parsed = parseSignIn(this.engine, this.transcript);
    if (!signInReady(this.engine, parsed)) return;
    this.url = parsed.url;
    this.code = parsed.code;
    this.state = "waiting";
  }

  write(text) {
    if (!this.pty || this.state !== "waiting") return false;
    this.typed.push(text.trim());
    this.pty.write(`${text}\r`);
    this.state = "finishing";
    return true;
  }

  said() {
    let text = this.transcript;
    for (const typed of this.typed) if (typed) text = text.split(typed).join("");
    return text;
  }

  async finish(exitCode) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    if (exitCode === 0 && (await this.confirm().catch(() => false))) {
      this.state = "done";
      this.error = null;
      return;
    }
    this.state = "failed";
    this.error = exitCode === 0 ? "The sign-in ended but the computer still isn't signed in." : lastLine(this.said()) || `The sign-in ended with code ${exitCode}.`;
  }

  fail(message) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.state = "failed";
    this.error = message;
    this.kill();
  }

  cancel() {
    if (!this.finished) this.fail("Cancelled.");
    else this.kill();
  }

  kill() {
    try {
      this.pty?.kill("SIGHUP");
    } catch {
      /* already gone */
    }
    this.pty = null;
  }

  /** The only thing a route ever answers: never the transcript. */
  view() {
    return {
      engine: this.engine,
      state: this.state,
      url: this.url,
      code: this.code,
      needsCode: needsCode(this.engine),
      error: this.error,
      startedAt: this.startedAt,
    };
  }
}
