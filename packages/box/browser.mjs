import { batchTimeoutMs } from "./computer.mjs";
import { takeLines } from "./gond-mcp.mjs";

const BROWSER_IDLE_MS = 30 * 60_000;
// Chrome's first start in a fresh profile, on top of the batch's own time.
const LAUNCH_MS = 60_000;

const keyOf = (accountId, bot) => `${accountId ?? ""}\n${bot}`;

export class BrowserError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * One persistent browser host per bot of each person (browser-host.mjs,
 * started as them by `start` on that bot's screen and profile), kept between
 * batches and turns so the page, its tabs and its sign-ins stay put. A host
 * that exits or stops answering is dropped, and the next batch starts another
 * on the same profile.
 */
export function createBrowsers({ start, idleMs = BROWSER_IDLE_MS, launchMs = LAUNCH_MS, batchMs = batchTimeoutMs, watched = () => false, onEvent = () => undefined, log = () => undefined }) {
  const hosts = new Map();

  const stop = (host) => {
    if (host.idle) clearTimeout(host.idle);
    host.idle = null;
    if (hosts.get(host.key) === host) hosts.delete(host.key);
    if (host.dead) return;
    host.dead = true;
    try {
      process.kill(-host.child.pid, "SIGTERM");
    } catch {
      host.child.kill?.("SIGTERM");
    }
  };

  const fail = (host, reason) => {
    const tail = host.log.trim().split("\n").slice(-3).join(" ").slice(-300);
    for (const waiting of host.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new BrowserError(502, `${reason}${tail ? `: ${tail}` : ""}`));
    }
    host.pending.clear();
    stop(host);
  };

  const hostFor = (account, bot) => {
    const key = keyOf(account.id, bot);
    const running = hosts.get(key);
    if (running && !running.dead) return running;
    const child = start(account, bot);
    const host = { key, user: account.id, bot, child, pending: new Map(), next: 1, dead: false, idle: null, log: "", lines: { pending: "" } };
    hosts.set(key, host);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of takeLines(host.lines, chunk)) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        // Lines without an id are the host's own news (what a person showed a bot), not answers.
        if (message.event) {
          onEvent(host.user, host.bot, message);
          continue;
        }
        const waiting = host.pending.get(message.id);
        if (!waiting) continue;
        host.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new BrowserError(502, message.error));
        else waiting.resolve(message.result);
      }
    });
    child.stderr?.on("data", (chunk) => {
      host.log = (host.log + chunk.toString("utf8")).slice(-4000);
    });
    child.on("exit", (code, signal) => {
      if (!host.dead) {
        log(`browser for ${account.id}'s ${bot} exited (${signal ?? code})`);
        onEvent(account.id, bot, { event: "exit" });
      }
      fail(host, "The browser closed");
    });
    child.on("error", (error) => fail(host, `The browser didn't start (${error.message})`));
    child.stdin.on("error", () => undefined);
    return host;
  };

  // A browser someone is looking at stays open however long no bot uses it: the person may be browsing in it.
  const whenIdle = (host) => {
    host.idle = setTimeout(() => (watched(host.user, host.bot) ? whenIdle(host) : stop(host)), idleMs);
  };

  const request = (account, bot, message, timeoutMs, signal) => {
    const host = hostFor(account, bot);
    if (host.idle) clearTimeout(host.idle);
    host.idle = null;
    const id = host.next++;
    return new Promise((resolve, reject) => {
      const settle = () => {
        signal?.removeEventListener("abort", onAbort);
        if (!host.dead && host.pending.size === 0) whenIdle(host);
      };
      const onAbort = () => {
        if (!host.pending.delete(id)) return;
        clearTimeout(timer);
        settle();
        reject(new BrowserError(499, "The request was closed"));
      };
      // A host that stops answering is stuck, not slow: it goes, and the next batch starts a new one.
      const timer = setTimeout(() => {
        host.pending.delete(id);
        reject(new BrowserError(504, "The browser didn't answer in time"));
        fail(host, "The browser stopped answering");
      }, timeoutMs);
      host.pending.set(id, {
        timer,
        resolve: (value) => (settle(), resolve(value)),
        reject: (error) => (settle(), reject(error)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      host.child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
    });
  };

  const of = (accountId, bot) => [...hosts.values()].filter((host) => host.user === accountId && (bot === undefined || host.bot === bot));

  return {
    /** Starts a bot's browser on `home` if it isn't open yet; one that is stays on its page. */
    open: (account, bot, home) => request(account, bot, { op: "open", home }, launchMs),
    /** Starts or stops reporting what the person does in a bot's browser, as `onEvent`'s teach events. */
    record: (account, bot, on) => request(account, bot, { op: "record", on }, launchMs),
    run: (account, steps, signal, options = {}) => request(account, options.bot ?? "", { op: "run", steps, ...options }, batchMs(steps) + launchMs, signal),
    running: (accountId, bot) => of(accountId, bot).some((host) => !host.dead),
    /** How many of the person's bots have a browser open. */
    count: (accountId) => [...hosts.values()].filter((host) => host.user === accountId && !host.dead).length,
    /** Closes a bot's browser, or every one of the person's without a bot. */
    close: (accountId, bot) => {
      for (const host of of(accountId, bot)) fail(host, "The browser was closed");
    },
    closeAll: () => {
      for (const host of [...hosts.values()]) fail(host, "The browser was closed");
    },
  };
}
