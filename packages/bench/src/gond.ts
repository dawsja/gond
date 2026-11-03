import type { Approval, Bot, LiveEvent, Message, Thread } from "@gond/shared";

/** One finished turn as the API's timing log keeps it (GET /api/usage/turns, only with GOND_TURN_TIMING=1). */
export type TurnRecord = {
  threadId: string;
  botId: string;
  messageId: string;
  at: string;
  engine: string;
  model: string;
  timing: { totalMs: number; toolsMs: number; modelMs: number; rounds: number; calls: number; screen: number; queuedMs: number; setupMs: number; firstMs: number | null };
  parts: Record<string, number>;
  routeMs: number | null;
  launch: "warm" | "resumed" | "launched" | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/** What one line from the person got back: the bots' lines, the turns and how long each part took as the person saw it. */
export type Exchange = {
  sent: Message;
  replies: Message[];
  turns: TurnRecord[];
  /** POST to the first `writing` text on the live events, as the person sees the first words. */
  firstWordsMs: number | null;
  /** POST to the last turn's end. */
  doneMs: number;
  timedOut: boolean;
};

export class Gond {
  cookie = "";
  private listeners = new Set<(event: LiveEvent, at: number) => void>();
  private stream: AbortController | null = null;

  constructor(readonly url: string) {}

  async signIn(username: string, password: string, setupToken?: string) {
    if (setupToken) {
      const res = await fetch(`${this.url}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: this.url },
        body: JSON.stringify({ token: setupToken, username, password, confirm: password }),
      });
      if (res.ok) {
        this.cookie = cookiesOf(res);
        return;
      }
    }
    const res = await fetch(`${this.url}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: this.url },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`Couldn't sign in as ${username}: ${res.status} ${await res.text()}`);
    this.cookie = cookiesOf(res);
  }

  async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: this.url, Cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${data.error ?? ""}`);
    return data;
  }

  /** Opens /api/events once; every event goes to the listeners with the moment it arrived. */
  async listen() {
    if (this.stream) return;
    this.stream = new AbortController();
    const res = await fetch(`${this.url}/api/events`, { headers: { Cookie: this.cookie, Accept: "text/event-stream" }, signal: this.stream.signal });
    if (!res.ok || !res.body) throw new Error(`The live events didn't open: ${res.status}`);
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of res.body!) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data || data === "{}") continue;
            try {
              const event = JSON.parse(data) as LiveEvent;
              const at = performance.now();
              for (const listener of this.listeners) listener(event, at);
            } catch {
              /* a keepalive or a frame that isn't JSON */
            }
          }
        }
      } catch {
        /* closed */
      }
    })();
  }

  on(listener: (event: LiveEvent, at: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.stream?.abort();
    this.stream = null;
  }

  async createBot(input: { name: string; title?: string; description?: string; approval?: string }): Promise<Bot> {
    return (await this.call<{ bot: Bot }>("POST", "/api/bots", { color: "#2F6FD6", ...input })).bot;
  }

  deleteBot(id: string) {
    return this.call("DELETE", `/api/bots/${id}`).catch(() => undefined);
  }

  messages(threadId: string): Promise<Message[]> {
    return this.call<{ messages: Message[] }>("GET", `/api/threads/${threadId}/messages?limit=200`).then((r) => r.messages);
  }

  turnsSince(since: string): Promise<TurnRecord[]> {
    return this.call<{ turns: TurnRecord[] }>("GET", `/api/usage/turns?since=${encodeURIComponent(since)}`).then((r) => r.turns);
  }

  async room(name: string, members: string[]): Promise<Thread> {
    return (await this.call<{ thread: Thread }>("POST", "/api/rooms", { name, members })).thread;
  }

  /** Waits for the greeting a new bot gives on its own, so it isn't counted against the first case line. */
  async settleGreeting(bot: Bot, timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const lines = await this.messages(bot.threadId);
      const prompt = lines.find((m) => m.kind === "prompt");
      if (!prompt || lines.some((m) => m.author === bot.id && m.answering === prompt.id) || lines.some((m) => m.author === bot.id && m.kind === "message")) {
        await Bun.sleep(500);
        return;
      }
      await Bun.sleep(400);
    }
  }

  /**
   * Says a line and waits until every turn it started has ended (the timing log has them and nothing
   * is still writing), allowing any approval card on the way, as a person tapping Allow would.
   */
  async say(threadId: string, body: string, options: { timeoutMs?: number; expectTurns?: number; replyTo?: string } = {}): Promise<Exchange> {
    await this.listen();
    const since = new Date(Date.now() - 1000).toISOString();
    let firstWordsAt: number | null = null;
    const working = new Set<string>();
    let lastActivity = performance.now();
    const off = this.on((event, at) => {
      if ("threadId" in event && event.threadId !== threadId) return;
      if (event.topic === "writing" && event.text && firstWordsAt === null) firstWordsAt = at;
      if (event.topic === "activity") {
        lastActivity = at;
        if (event.line) working.add(event.botId);
        else working.delete(event.botId);
      }
      if (event.topic === "approvals") void this.allowCards(threadId);
    });
    const started = performance.now();
    try {
      const sent = (await this.call<{ message: Message }>("POST", `/api/threads/${threadId}/messages`, { body, ...(options.replyTo ? { replyTo: options.replyTo } : {}) })).message;
      const end = Date.now() + (options.timeoutMs ?? 300_000);
      let turns: TurnRecord[] = [];
      let timedOut = true;
      while (Date.now() < end) {
        await Bun.sleep(300);
        void this.allowCards(threadId);
        turns = (await this.turnsSince(since)).filter((t) => t.threadId === threadId && t.messageId === sent.id);
        const quiet = working.size === 0 && performance.now() - lastActivity > 1500;
        if (turns.length >= (options.expectTurns ?? 1) && quiet) {
          timedOut = false;
          break;
        }
      }
      const doneMs = performance.now() - started;
      const lines = await this.messages(threadId);
      const at = lines.findIndex((m) => m.id === sent.id);
      const replies = lines.slice(at + 1).filter((m) => m.author !== "you" && m.author !== "system" && !m.fromThreadId);
      return { sent: lines[at] ?? sent, replies, turns, firstWordsMs: firstWordsAt === null ? null : firstWordsAt - started, doneMs, timedOut };
    } finally {
      off();
    }
  }

  private allowing = false;

  /** Allows every waiting approval card in the conversation, once each. */
  async allowCards(threadId: string) {
    if (this.allowing) return;
    this.allowing = true;
    try {
      const { approvals } = await this.call<{ approvals: Approval[] }>("GET", "/api/approvals?status=pending");
      for (const card of approvals.filter((a) => a.threadId === threadId)) await this.call("POST", `/api/approvals/${card.id}`, { decision: "allow" }).catch(() => undefined);
    } catch {
      /* tried again on the next poll */
    } finally {
      this.allowing = false;
    }
  }
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
