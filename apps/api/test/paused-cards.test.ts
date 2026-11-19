import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { botInputSchema, isPaused, type Bot, type Message } from "@gond/shared";
import { answerableLate, askApproval, askOwner, CARD_EXPIRED_LINE, decide, endTurnOnExpiry, pauseOnExpiry, requestApproval, retireLapsedCards } from "../src/approvals.ts";
import { createApproval, getApproval, pauseApproval } from "../src/data/approvals.ts";
import { createBot } from "../src/data/bots.ts";
import { getMessage, getThread, listMessages, postMessage } from "../src/data/threads.ts";
import { ensureDatabase, releaseClaims, resetDbReady } from "../src/db/init.ts";
import { closeDb } from "../src/db/sqlite.ts";
import { answerMessage, botTurn, hasWork, postFromPerson, stopCauseOf, stoppedReply, stopThread } from "../src/responder.ts";
import { approvalsRoutes } from "../src/routes/approvals.ts";
import { requestSecret } from "../src/secret-requests.ts";
import type { Env } from "../src/app.ts";

let previous: string | undefined, directory: string;
beforeAll(() => {
  previous = process.env.GOND_DATA_DIR;
  directory = mkdtempSync(join(tmpdir(), "gond-paused-"));
  process.env.GOND_DATA_DIR = directory;
  resetDbReady();
  const db = ensureDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, role TEXT, createdAt TEXT, updatedAt TEXT);
           CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, userId TEXT, providerId TEXT, accountId TEXT, createdAt TEXT, updatedAt TEXT);`);
  for (const id of [OWNER, "u-stranger"]) db.query('INSERT OR REPLACE INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.com`, "user", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
});
afterAll(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.GOND_DATA_DIR;
  else process.env.GOND_DATA_DIR = previous;
  resetDbReady();
});

const OWNER = "u-paused";
const FIFTEEN_MINUTES = 15 * 60_000;

function asker(name: string): Bot {
  return createBot(botInputSchema.parse({ name, approval: "ask" }), OWNER);
}

/** A turn answering the person, as the responder sets one up: it ends when a card times out, and its work can start again. */
function personTurn(message: Pick<Message, "id" | "kind" | "approvalId">, done: string[] = []) {
  const controller = new AbortController();
  endTurnOnExpiry(controller.signal, () => controller.abort("expired"));
  pauseOnExpiry(controller.signal, { messageId: message.id, card: message.kind === "prompt" ? message.approvalId : null, done: () => done });
  return controller;
}

const cardsIn = (threadId: string) => listMessages(threadId).filter((m) => m.kind === "approval");
const linesOf = (bot: Bot) => listMessages(bot.threadId).filter((m) => m.author === bot.id && m.kind === "message").map((m) => m.body);
const promptsIn = (threadId: string) => listMessages(threadId).filter((m) => m.kind === "prompt");

/** Asks for a card in a turn and lets 15 minutes pass with nobody answering. */
async function unanswered(bot: Bot, message: Pick<Message, "id" | "kind" | "approvalId">, tool: string, input: Record<string, unknown>, done: string[] = []) {
  const turn = personTurn(message, done);
  jest.useFakeTimers();
  try {
    const asking = askApproval({ bot, threadId: bot.threadId, tool, input, signal: turn.signal });
    const card = cardsIn(bot.threadId).at(-1)!;
    jest.advanceTimersByTime(FIFTEEN_MINUTES);
    return { answer: await asking, approval: getApproval(card.approvalId!)!, turn };
  } finally {
    jest.useRealTimers();
  }
}

describe("a card nobody answered in time", () => {
  test("pauses quietly: the turn ends, nothing is said, and the card stays answerable", async () => {
    const bot = asker("Pauser");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Clean up the build folder and redeploy", answered: true });
    const { answer, approval, turn } = await unanswered(bot, asked, "Bash", { command: "sudo systemctl restart web" }, ["Ran `npm test`", "Wrote deploy.sh"]);

    expect(answer.decision).toBe("expired");
    expect(stopCauseOf(turn.signal)).toBe("expired");
    expect(linesOf(bot)).toEqual([]);
    expect(isPaused(approval)).toBe(true);
    // The turn's work rides in the row, never out to a page.
    expect(approval.note).toBeNull();
  });

  test("answered late, it starts the work again on a hidden prompt with what ran and what the person said; it runs nothing itself", async () => {
    const bot = asker("Late Yes");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Clean up the build folder and **redeploy**", answered: true });
    const { approval } = await unanswered(bot, asked, "Bash", { command: "sudo systemctl restart web", description: "Restart the web service" }, ["Ran `npm test`", "Wrote deploy.sh"]);

    const answered = decide(approval.id, { decision: "allow" });
    expect(answered).toMatchObject({ status: "allowed", outcome: null });
    const prompt = promptsIn(bot.threadId).at(-1)!;
    expect(prompt).toMatchObject({ author: "system", approvalId: approval.id });
    expect(prompt.body).toContain('the person\'s message "Clean up the build folder and redeploy"');
    expect(prompt.body).toContain("- Ran `npm test`\n- Wrote deploy.sh");
    expect(prompt.body).toContain("They have answered it now: yes.");
    expect(prompt.body).toContain("check where things stand before you do anything");
    expect(prompt.body).toContain('call Bash again with exactly this input: {"command":"sudo systemctl restart web"');
    // A second tap changes nothing and starts nothing more.
    expect(decide(approval.id, { decision: "deny" })?.status).toBe("allowed");
    expect(promptsIn(bot.threadId)).toHaveLength(1);
  });

  test("the restarted work lets the very same call through once; a changed one, or a second, gets a new card", async () => {
    const bot = asker("One Pass");
    const other = asker("Other Bot");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Restart the web service", answered: true });
    const { approval } = await unanswered(bot, asked, "Bash", { command: "sudo systemctl restart web", description: "Restart it" });
    decide(approval.id, { decision: "allow" });
    const prompt = promptsIn(bot.threadId).at(-1)!;
    const resumed = personTurn(prompt);
    const ask = (who: Bot, command: string, signal = resumed.signal) => askApproval({ bot: who, threadId: bot.threadId, tool: "Bash", input: { command, description: "Restart the web service again" }, signal });

    // Not another bot, nor another turn, even with the same command.
    const theirs = ask(other, "sudo systemctl restart web");
    expect(cardsIn(bot.threadId)).toHaveLength(2);
    decide(cardsIn(bot.threadId).at(-1)!.approvalId!, { decision: "deny" });
    expect((await theirs).decision).toBe("deny");
    const elsewhere = ask(bot, "sudo systemctl restart web", personTurn(asked).signal);
    decide(cardsIn(bot.threadId).at(-1)!.approvalId!, { decision: "deny" });
    expect((await elsewhere).decision).toBe("deny");

    const changed = ask(bot, "sudo systemctl restart web db");
    expect(cardsIn(bot.threadId)).toHaveLength(4);
    decide(cardsIn(bot.threadId).at(-1)!.approvalId!, { decision: "deny" });
    expect((await changed).decision).toBe("deny");

    expect(await ask(bot, "sudo systemctl restart web")).toMatchObject({ decision: "allow" });
    expect(cardsIn(bot.threadId)).toHaveLength(4);
    expect(getMessage(prompt.id)?.approvalId).toBeNull();

    const again = ask(bot, "sudo systemctl restart web");
    expect(cardsIn(bot.threadId)).toHaveLength(5);
    decide(cardsIn(bot.threadId).at(-1)!.approvalId!, { decision: "deny" });
    expect((await again).decision).toBe("deny");
  });

  test("an email answered late goes as the person left it: their edit, sent at once from the draft", async () => {
    const bot = asker("Late Letter");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Draft Dana a note about the VM", answered: true });
    const letter = { recipient_email: "dana@ruizdesign.co", subject: "VM for the staging site", body: "Hi Dana, the VM is ready." };
    const { approval } = await unanswered(bot, asked, "GMAIL_CREATE_EMAIL_DRAFT", letter);
    expect(isPaused(approval)).toBe(true);

    const answered = decide(approval.id, { decision: "allow", send: true, edit: { to: ["dana@ruizdesign.co"], cc: [], bcc: [], subject: "VM for the staging site", body: "Hey Dana, you can deploy today." } });
    expect(answered).toMatchObject({ status: "allowed", outcome: "sent", edited: true });
    const prompt = promptsIn(bot.threadId).at(-1)!;
    expect(prompt.body).toContain("their version is the one to use");
    expect(prompt.body).toContain("Hey Dana, you can deploy today.");
    expect(prompt.body).toContain("sends it straight away");

    const resumed = personTurn(prompt);
    const asOriginally = askApproval({ bot, threadId: bot.threadId, tool: "GMAIL_CREATE_EMAIL_DRAFT", input: letter, signal: resumed.signal });
    decide(cardsIn(bot.threadId).at(-1)!.approvalId!, { decision: "deny" });
    expect((await asOriginally).decision).toBe("deny");
    const theirs = await askApproval({ bot, threadId: bot.threadId, tool: "GMAIL_CREATE_EMAIL_DRAFT", input: answered!.input, signal: resumed.signal });
    expect(theirs).toMatchObject({ decision: "allow", send: true, edited: true, input: answered!.input });
  });

  test("a late no or a request for changes restarts the work without letting anything through", async () => {
    const bot = asker("Late No");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Email the team the plan", answered: true });
    const { approval } = await unanswered(bot, asked, "GMAIL_SEND_EMAIL", { recipient_email: "team@park.io", subject: "Plan", body: "Here it is." });
    decide(approval.id, { decision: "deny", note: "Add the dates" });
    const prompt = promptsIn(bot.threadId).at(-1)!;
    expect(getApproval(approval.id)).toMatchObject({ status: "denied", outcome: "changes", note: "Add the dates" });
    expect(prompt.approvalId).toBeNull();
    expect(prompt.body).toContain('They want changes first: "Add the dates"');
  });

  test("a routine's and a watch's cards pause too, and the prompt names the routine", async () => {
    const bot = asker("Watcher");
    const run = postMessage({ threadId: bot.threadId, author: "routine", body: "[Watch: Inbox] Look for anything urgent in my inbox", answered: true });
    const { approval } = await unanswered(bot, run, "GMAIL_REPLY_TO_THREAD", { thread_id: "t1", message_body: "On it." });
    expect(isPaused(approval)).toBe(true);
    decide(approval.id, { decision: "allow" });
    expect(promptsIn(bot.threadId).at(-1)!.body).toContain('your routine "Inbox"');
  });
});

describe("cards that keep the strict expiry", () => {
  test("money, sign-ins, secrets, a server's keys and another Gond's request expire at 15 minutes with Gond's line", async () => {
    const bot = asker("Strict");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Order the groceries", answered: true });
    const strict: [string, Record<string, unknown>][] = [
      ["ask_approval", { summary: "Place the order?", kind: "purchase", allow: "Place order" }],
      ["ask_approval", { summary: "Pay the plumber?", total: { label: "Total", value: "$120.00" } }],
      ["STRIPE_CREATE_PAYMENT_INTENT", { amount: 1200 }],
      ["PAYPAL_TRANSFER_FUNDS", { to: "sam@park.io" }],
      ["request_login", { site: "Uber Eats" }],
      ["type_secret", { name: "ROUTER_PASSWORD" }],
      ["forget_secret", { name: "OPENAI_API_KEY" }],
      ["add_mcp_server", { name: "toad", url: "https://toad.example/mcp", headers: { Authorization: "Bearer {{secret:TOAD_KEY}}" } }],
    ];
    for (const [tool, input] of strict) {
      expect(answerableLate(tool, input)).toBe(false);
      const { approval } = await unanswered(bot, asked, tool, input);
      expect(approval).toMatchObject({ status: "expired", outcome: null });
    }
    expect(linesOf(bot)).toEqual(strict.map(() => CARD_EXPIRED_LINE));

    for (const [tool, input] of [["ask_approval", { summary: "Copy the compose files?" }], ["GMAIL_SEND_EMAIL", {}], ["mcp__toad__delete_app", { id: "a1" }], ["computer", { target: "browser" }], ["add_mcp_server", { name: "toad", url: "https://toad.example/mcp" }]] as const) {
      expect(answerableLate(tool, input)).toBe(true);
    }

    const owner = personTurn(asked);
    jest.useFakeTimers();
    try {
      const fromAfar = askOwner({ bot, threadId: bot.threadId, summary: "Let Strict do what Sam asked?", input: { summary: "Let Strict do what Sam asked?" }, signal: owner.signal });
      const login = requestSecret({ bot, threadId: bot.threadId, name: "ROUTER", reason: "to add reservations", target: "login", site: "Router", fields: [{ name: "ROUTER_PASSWORD", label: "Password", kind: "password" }], signal: personTurn(asked).signal });
      jest.advanceTimersByTime(FIFTEEN_MINUTES);
      expect((await fromAfar).decision).toBe("expired");
      expect(await login).toBe("expired");
    } finally {
      jest.useRealTimers();
    }
    expect(cardsIn(bot.threadId).map((m) => getApproval(m.approvalId!)).filter(isPaused)).toEqual([]);
  });

  test("a turn on a teammate's errand keeps the strict expiry, so it can report back", async () => {
    const bot = asker("Errand");
    const turn = new AbortController();
    endTurnOnExpiry(turn.signal, () => turn.abort("expired"));
    jest.useFakeTimers();
    try {
      const asking = requestApproval({ bot, threadId: bot.threadId, tool: "Bash", input: { command: "sudo reboot" }, signal: turn.signal });
      jest.advanceTimersByTime(FIFTEEN_MINUTES);
      expect(await asking).toBe("expired");
    } finally {
      jest.useRealTimers();
    }
    expect(isPaused(getApproval(cardsIn(bot.threadId).at(-1)!.approvalId!))).toBe(false);
    expect(linesOf(bot)).toEqual([CARD_EXPIRED_LINE]);
  });
});

describe("a restart", () => {
  test("pauses a card that keeps its turn's work and doesn't answer its message again; other cards still expire", async () => {
    const bot = asker("Restarted");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Rotate the logs" });
    ensureDatabase().query("UPDATE gond_messages SET claimed_by = 'old-api' WHERE id = ?").run(asked.id);
    const kept = createApproval({ botId: bot.id, threadId: bot.threadId, tool: "Bash", summary: "Run: logrotate -f", input: { command: "logrotate -f /etc/logrotate.conf" }, work: { answering: asked.id, done: ["Read /etc/logrotate.conf"] } });
    const plain = createApproval({ botId: bot.id, threadId: bot.threadId, tool: "Bash", summary: "Run: ls", input: { command: "ls" } });

    releaseClaims(ensureDatabase());
    expect(isPaused(getApproval(kept.id))).toBe(true);
    expect(getApproval(plain.id)).toMatchObject({ status: "expired", outcome: null });

    await answerMessage(getMessage(asked.id)!);
    const row = ensureDatabase().query("SELECT answered_at, claimed_by FROM gond_messages WHERE id = ?").get(asked.id) as { answered_at: string | null; claimed_by: string | null };
    expect(row.answered_at).not.toBeNull();

    decide(kept.id, { decision: "allow" });
    const prompt = promptsIn(bot.threadId).at(-1)!;
    expect(prompt.body).toContain("- Read /etc/logrotate.conf");
    expect(prompt.body).toContain('the person\'s message "Rotate the logs"');
  });
});

describe("a paused card stops being answerable", () => {
  const paused = (bot: Bot, answering = "m-gone") => {
    const card = createApproval({ botId: bot.id, threadId: bot.threadId, tool: "Bash", summary: "Run: make deploy", input: { command: "make deploy" }, work: { answering, done: [] } });
    postMessage({ threadId: bot.threadId, author: bot.id, kind: "approval", body: card.summary, approvalId: card.id, answered: true });
    expect(pauseApproval(card.id)).toBe(true);
    return card;
  };

  test("when the person writes in the conversation", async () => {
    const bot = asker("Moved On");
    const card = paused(bot);
    await postFromPerson(getThread(bot.threadId)!, { body: "Never mind, I deployed it myself" });
    expect(getApproval(card.id)).toMatchObject({ status: "expired", outcome: null });
    expect(decide(card.id, { decision: "allow" })?.status).toBe("expired");
    expect(promptsIn(bot.threadId)).toEqual([]);
  });

  test("when the person stops, which says so", async () => {
    const bot = asker("Stopped");
    const card = paused(bot);
    expect(hasWork(bot.threadId)).toBe(true);
    const report = await stopThread(bot.threadId, { quiet: true });
    expect(report.cards).toBe(1);
    expect(stoppedReply(report)).toContain("I closed one card still waiting for your answer, so nothing on it will run.");
    expect(isPaused(getApproval(card.id))).toBe(false);
    expect(hasWork(bot.threadId)).toBe(false);
  });

  test("when the same bot posts a newer card there; only the newest waits", async () => {
    const bot = asker("Newer");
    const older = paused(bot);
    const newer = askApproval({ bot, threadId: bot.threadId, tool: "Bash", input: { command: "make test" } });
    expect(isPaused(getApproval(older.id))).toBe(false);
    decide(cardsIn(bot.threadId).at(-1)!.approvalId!, { decision: "deny" });
    await newer;
  });

  test("a day after it was asked", () => {
    const bot = asker("Lapsed");
    const card = paused(bot);
    const recent = paused(asker("Recent"));
    ensureDatabase().query("UPDATE gond_approvals SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 3_600_000).toISOString(), card.id);
    expect(isPaused(getApproval(card.id))).toBe(false);
    expect(decide(card.id, { decision: "allow" })?.status).toBe("expired");
    expect(retireLapsedCards()).toBe(1);
    expect(isPaused(getApproval(recent.id))).toBe(true);
    expect(promptsIn(bot.threadId)).toEqual([]);
  });
});

describe("answering a paused card", () => {
  test("only its own profile can see or answer it", async () => {
    const bot = asker("Mine");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Ship it", answered: true });
    const { approval } = await unanswered(bot, asked, "Bash", { command: "make ship" });
    const as = (id: string) =>
      new Hono<Env>()
        .use("*", async (c, next) => {
          c.set("session", { user: { id } } as never);
          await next();
        })
        .route("/api", approvalsRoutes());
    const post = (id: string) => as(id).request(`/api/approvals/${approval.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "allow" }) });

    expect((await as("u-stranger").request(`/api/approvals/${approval.id}`)).status).toBe(404);
    expect((await post("u-stranger")).status).toBe(404);
    expect(isPaused(getApproval(approval.id))).toBe(true);
    expect(promptsIn(bot.threadId)).toEqual([]);

    const answered = await post(OWNER);
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { approval: { status: string } }).approval.status).toBe("allowed");
    expect(promptsIn(bot.threadId)).toHaveLength(1);
  });
});

describe("a bot's turn", () => {
  test("pauses at a card nobody answers, and a late yes starts it again told what ran, letting the same call through once", async () => {
    // A computer whose bot runs one step, then asks to run a command and waits for the answer.
    const prompts: string[] = [];
    const answers: string[] = [];
    let answered: (content: string) => void = () => undefined;
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/tool-result")) {
          const { content } = (await request.json()) as { content: string };
          answers.push(content);
          answered(content);
          return Response.json({ ok: true });
        }
        if (!path.endsWith("/turn")) return Response.json(path === "/health" ? { ok: true, agents: 0, updating: false } : {});
        prompts.push(((await request.json()) as { prompt: string }).prompt);
        const encoder = new TextEncoder();
        const send = (controller: ReadableStreamDefaultController, event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener("abort", () => controller.close());
              if (prompts.length === 1) send(controller, { type: "step", step: { id: "s1", kind: "command", title: "Ran the tests", status: "done" } });
              send(controller, { type: "tool_call", callId: `c${prompts.length}`, name: "permission", input: { tool_name: "Bash", input: { command: "sudo systemctl restart web", description: prompts.length === 1 ? "Restart it" : "Restart the web service" } } });
              answered = (content) => {
                if (request.signal.aborted) return;
                send(controller, { type: "result", ok: true, text: JSON.parse(content).behavior === "allow" ? "Restarted the web service." : "Couldn't.", stopReason: null, recovered: false });
                controller.close();
              };
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const bot = asker("Turner");
      const thread = getThread(bot.threadId)!;
      const asked = postMessage({ threadId: thread.id, author: "you", body: "Deploy the new build" });
      jest.useFakeTimers();
      let first: Promise<string>;
      try {
        first = botTurn(bot, thread, asked);
        for (let i = 0; i < 400 && !cardsIn(thread.id).length; i += 1) await fetch(`http://127.0.0.1:${fake.port}/tick`);
        expect(cardsIn(thread.id)).toHaveLength(1);
        jest.advanceTimersByTime(FIFTEEN_MINUTES);
      } finally {
        jest.useRealTimers();
      }
      expect(await first).toBe("");
      const card = getApproval(cardsIn(thread.id)[0]!.approvalId!)!;
      expect(isPaused(card)).toBe(true);
      expect(linesOf(bot)).toEqual([]);
      expect(listMessages(thread.id).filter((m) => m.kind === "event")).toEqual([]);

      decide(card.id, { decision: "allow" });
      const prompt = promptsIn(thread.id).at(-1)!;
      expect(await botTurn(bot, thread, prompt)).toBe("Restarted the web service.");
      expect(prompts.at(-1)).toContain("These steps ran before the card:\n- Ran the tests");
      expect(prompts.at(-1)).toContain('the person\'s message "Deploy the new build"');
      expect(JSON.parse(answers.at(-1)!)).toMatchObject({ behavior: "allow" });
      expect(cardsIn(thread.id)).toHaveLength(1);
      expect(linesOf(bot)).toEqual(["Restarted the web service."]);
    } finally {
      fake.stop(true);
      if (boxUrl === undefined) delete process.env.GOND_BOX_URL;
      else process.env.GOND_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.GOND_BOX_TOKEN;
      else process.env.GOND_BOX_TOKEN = boxToken;
    }
  });
});
