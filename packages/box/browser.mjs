import { batchTimeoutMs } from "./computer.mjs";
import { takeLines } from "./gond-mcp.mjs";

export const BROWSER_IDLE_MS = 30 * 60_000;
// Chrome's first start in a fresh profile, on top of the batch's own time.
export const LAUNCH_MS = 60_000;

export class BrowserError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * One persistent browser host per person (browser-host.mjs, started as them
 * by `start`), kept between batches and turns so the page, its tabs and its
 * sign-ins stay put. A host that exits or stops answering is dropped, and the
 * next batch starts another on the same profile.
 */
export function createBrowsers({ start, idleMs = BROWSER_IDLE_MS, launchMs = LAUNCH_MS, batchMs = batchTimeoutMs, log = () => undefined }) {
  const hosts = new Map();

  const stop = (host) => {
    if (host.idle) clearTimeout(host.idle);
    host.idle = null;
    if (hosts.get(host.user) === host) hosts.delete(host.user);
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

  const hostFor = (account) => {
    const running = hosts.get(account.id);
    if (running && !running.dead) return running;
    const child = start(account);
    const host = { user: account.id, child, pending: new Map(), next: 1, dead: false, idle: null, log: "", lines: { pending: "" } };
    hosts.set(account.id, host);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of takeLines(host.lines, chunk)) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
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
      if (!host.dead) log(`browser for ${account.id} exited (${signal ?? code})`);
      fail(host, "The browser closed");
    });
    child.on("error", (error) => fail(host, `The browser didn't start (${error.message})`));
    child.stdin.on("error", () => undefined);
    return host;
  };

  const request = (account, message, timeoutMs, signal) => {
    const host = hostFor(account);
    if (host.idle) clearTimeout(host.idle);
    host.idle = null;
    const id = host.next++;
    return new Promise((resolve, reject) => {
      const settle = () => {
        signal?.removeEventListener("abort", onAbort);
        if (!host.dead && host.pending.size === 0) host.idle = setTimeout(() => stop(host), idleMs);
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

  return {
    run: (account, steps, signal, options = {}) => request(account, { op: "run", steps, ...options }, batchMs(steps) + launchMs, signal),
    running: (accountId) => {
      const host = hosts.get(accountId);
      return Boolean(host && !host.dead);
    },
    close: (accountId) => {
      const host = hosts.get(accountId);
      if (host) fail(host, "The browser was closed");
    },
    closeAll: () => {
      for (const host of [...hosts.values()]) fail(host, "The browser was closed");
    },
  };
}
