import type { ProviderKind } from "@gond/shared";
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir = "";
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "gond-"));
  process.env.GOND_DATA_DIR = dir;
  await seedUsers(["u-admin", "admin"]);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asPerson<T extends { use: (...args: any[]) => unknown }>(app: T, id: string): T {
  app.use("*", async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("session", { user: { id } });
    await next();
  });
  return app;
}

async function seedUsers(...people: [id: string, role: "admin" | "user"][]) {
  const { ensureDatabase } = await import("../src/db/init.ts");
  const db = ensureDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, role TEXT, createdAt TEXT, updatedAt TEXT);
           CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, userId TEXT, providerId TEXT, accountId TEXT, createdAt TEXT, updatedAt TEXT);`);
  for (const [id, role] of people) {
    db.query('INSERT OR REPLACE INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.com`, role, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  }
}
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("data", () => {
  test("creates a bot with its thread, posts and claims messages", async () => {
    const { createBot, listBots, getBotByThread } = await import("../src/data/bots.ts");
    const { postMessage, claimPendingMessages, markAnswered, listMessages, getThread } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Pip", title: "Coordinator" }), "u-admin");
    expect(listBots()).toHaveLength(1);
    expect(getBotByThread(bot.threadId)?.id).toBe(bot.id);
    const thread = getThread(bot.threadId)!;
    expect(thread.members).toEqual([bot.id]);
    postMessage({ threadId: bot.threadId, author: "you", body: "hello" });
    const claimed = claimPendingMessages("test", () => 1000);
    expect(claimed).toHaveLength(1);
    expect(claimPendingMessages("test", () => 1000)).toHaveLength(0);
    markAnswered(claimed[0]!.id);
    postMessage({ threadId: bot.threadId, author: bot.id, body: "hi", answered: true });
    expect(listMessages(bot.threadId)).toHaveLength(2);
    expect(getThread(bot.threadId)!.lastMessage?.body).toBe("hi");
  });

  test("each person's messages are claimed against their own room", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { postMessage, claimPendingMessages, markAnswered } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@gond/shared");
    const busy = createBot(botInputSchema.parse({ name: "Busy" }), "u-busy");
    const quiet = createBot(botInputSchema.parse({ name: "Quiet" }), "u-quiet");
    for (let i = 0; i < 5; i++) postMessage({ threadId: busy.threadId, author: "you", body: `job ${i}` });
    const theirs = postMessage({ threadId: quiet.threadId, author: "you", body: "hello" });

    const claimed = claimPendingMessages("room-per-person", (userId) => (userId === "u-busy" ? 3 : 1));
    expect(claimed.filter((m) => m.threadId === busy.threadId)).toHaveLength(3);
    expect(claimed.map((m) => m.id)).toContain(theirs.id);

    expect(claimPendingMessages("room-per-person", (userId) => (userId === "u-busy" ? 0 : 1))).toHaveLength(0);
    for (const message of [...claimed, ...claimPendingMessages("room-per-person", () => 1000)]) markAnswered(message.id);
  });

  test("secret cards and hidden prompts are messages too", async () => {
    const { listBots } = await import("../src/data/bots.ts");
    const { postMessage, claimPendingMessages, listMessages } = await import("../src/data/threads.ts");
    const bot = listBots()[0]!;
    postMessage({ threadId: bot.threadId, author: bot.id, kind: "secret", body: "OPENAI_API_KEY: for summaries", approvalId: "sr_test", answered: true });
    const prompt = postMessage({ threadId: bot.threadId, author: "system", kind: "prompt", body: "Say hello." });
    expect(listMessages(bot.threadId).map((m) => m.kind)).toContain("secret");

    expect(claimPendingMessages("test", () => 1000).map((m) => m.id)).toEqual([prompt.id]);
  });

  test("an approval reads the bot's level now, not as the turn started", async () => {
    const { listBots, updateBot } = await import("../src/data/bots.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { requestApproval } = await import("../src/approvals.ts");
    const stale = listBots()[0]!;
    const before = listMessages(stale.threadId).length;

    updateBot(stale.id, { approval: "full" });

    const decision = await requestApproval({ bot: { ...stale, approval: "ask" }, threadId: stale.threadId, tool: "Bash", input: { command: "ls" } });
    expect(decision).toBe("allow");

    expect(listMessages(stale.threadId)).toHaveLength(before);

    updateBot(stale.id, { approval: "auto" });
    expect(await requestApproval({ bot: { ...stale, approval: "ask" }, threadId: stale.threadId, tool: "Bash", input: { command: "ls" } })).toBe("allow");
    expect(listMessages(stale.threadId)).toHaveLength(before);
    updateBot(stale.id, { approval: stale.approval });
  });

  test("a bot is made on Auto, which asks only for the hard list and ask_approval", async () => {
    const { createBot, deleteBot, getBot, updateBot } = await import("../src/data/bots.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { listRules } = await import("../src/data/approvals.ts");
    const { requestApproval, decide } = await import("../src/approvals.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Runner", approval: "auto" }), "u-admin");
    expect(getBot(bot.id)?.approval).toBe("auto");
    const ask = (tool: string, input: Record<string, unknown>, summary?: string) => requestApproval({ bot, threadId: bot.threadId, tool, input, summary });
    const count = () => listMessages(bot.threadId).length;
    const before = count();
    expect(await ask("Bash", { command: "ls -la" })).toBe("allow");
    expect(await ask("Write", { file_path: "/home/agent/notes.md" })).toBe("allow");
    expect(await ask("GITHUB_CREATE_ISSUE", { title: "x" })).toBe("allow");
    expect(count()).toBe(before);
    const carded: Array<[string, Record<string, unknown>, string | undefined]> = [
      ["Bash", { command: "sudo apt install x" }, undefined],
      ["GMAIL_SEND_EMAIL", { to: "a@b.c" }, "Gmail: send"],
      ["ask_approval", { summary: "Send the invoice to Ada" }, "Send the invoice to Ada"],
    ];
    for (const [tool, input, summary] of carded) {
      const pending = ask(tool, input, summary);
      const card = listMessages(bot.threadId).at(-1)!;
      expect(card.kind).toBe("approval");
      decide(card.approvalId!, { decision: "deny" });
      expect(await pending).toBe("deny");
    }
    expect(count()).toBe(before + carded.length);

    const rulesBefore = listRules(bot.id);
    const pending = ask("ask_approval", { summary: "Pay the invoice" }, "Pay the invoice");
    const card = listMessages(bot.threadId).at(-1)!;
    expect(decide(card.approvalId!, { decision: "always" })?.rule).toBeNull();
    expect(await pending).toBe("always");
    expect(listRules(bot.id)).toEqual(rulesBefore);

    updateBot(bot.id, { approval: "full" });
    const after = count();
    expect(await ask("ask_approval", { summary: "Pay the invoice" }, "Pay the invoice")).toBe("allow");
    expect(count()).toBe(after);
    deleteBot(bot.id);
  });

  test("an email card sends what the person edited, sends a draft on Send, and sends one back with their note", async () => {
    const { createBot, deleteBot } = await import("../src/data/bots.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { getApproval } = await import("../src/data/approvals.ts");
    const { askApproval, answerProblem, decide } = await import("../src/approvals.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Mailer", approval: "auto" }), "u-admin");
    const letter = { recipient_email: "dana@ruizdesign.co", subject: "VM for the staging site", body: "Hi Dana, you can deploy from Monday." };
    const card = () => getApproval(listMessages(bot.threadId).at(-1)!.approvalId!)!;

    const first = askApproval({ bot, threadId: bot.threadId, tool: "GMAIL_CREATE_EMAIL_DRAFT", input: letter });
    expect(card().revises).toBeNull();
    expect(answerProblem(card(), { decision: "allow", note: "x" })).toBe("A note goes with a no");
    expect(answerProblem(card(), { decision: "always" })).toBe("An email asks every time");
    expect(answerProblem(card(), { decision: "allow", edit: { to: ["not an address"], cc: [], bcc: [], subject: "s", body: "b" } })).toBe("Check the addresses");
    decide(card().id, { decision: "deny", note: "Less formal, and it's ready today" });
    expect(await first).toMatchObject({ decision: "deny", note: "Less formal, and it's ready today" });
    expect(card()).toMatchObject({ status: "denied", outcome: "changes", note: "Less formal, and it's ready today" });

    const redraft = { ...letter, body: "Hey Dana! you can deploy today." };
    const second = askApproval({ bot, threadId: bot.threadId, tool: "GMAIL_CREATE_EMAIL_DRAFT", input: redraft });
    expect(card().revises).toEqual({ tool: "GMAIL_CREATE_EMAIL_DRAFT", input: letter });
    decide(card().id, { decision: "allow", send: true, edit: { to: ["Dana Ruiz <dana@ruizdesign.co>", "leo@park.io"], cc: [], bcc: [], subject: "VM for the staging site", body: "Hey Dana! you can deploy today." } });
    const sent = await second;
    expect(sent).toMatchObject({ decision: "allow", send: true, edited: true, input: { ...redraft, extra_recipients: ["leo@park.io"] } });
    expect(card()).toMatchObject({ status: "allowed", outcome: "sent", edited: true, input: { ...redraft, extra_recipients: ["leo@park.io"] } });

    const third = askApproval({ bot, threadId: bot.threadId, tool: "GMAIL_SEND_EMAIL", input: letter });
    expect(card().revises).toBeNull();
    expect(answerProblem(card(), { decision: "allow", send: true })).toBe("Only a draft's card can send it");
    decide(card().id, { decision: "allow" });
    expect(await third).toMatchObject({ decision: "allow", send: false, edited: false });
    expect(card()).toMatchObject({ outcome: null, edited: false });

    const bash = askApproval({ bot, threadId: bot.threadId, tool: "Bash", input: { command: "sudo reboot" } });
    expect(answerProblem(card(), { decision: "allow", edit: { to: ["a@b.co"], cc: [], bcc: [], subject: "s", body: "b" } })).toBe("Only an email's card can be edited");
    decide(card().id, { decision: "deny" });
    await bash;
    deleteBot(bot.id);
  });

  test("a bot works in its own folder without asking, and asks outside it", async () => {
    const { listBots, updateBot } = await import("../src/data/bots.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { requestApproval } = await import("../src/approvals.ts");
    const bot = listBots()[0]!;
    updateBot(bot.id, { approval: "ask" });
    const ask = (tool: string, input: Record<string, unknown>) => requestApproval({ bot: { ...bot, approval: "ask" }, threadId: bot.threadId, tool, input });
    const before = listMessages(bot.threadId).length;

    expect(await ask("Write", { file_path: `/home/agent/.bots/${bot.id}/notes.md` })).toBe("allow");
    expect(await ask("Edit", { file_path: "memory/plan.md" })).toBe("allow");

    expect(await ask("Read", { file_path: "/etc/hosts" })).toBe("allow");
    expect(listMessages(bot.threadId)).toHaveLength(before);

    for (const path of [`/home/agent/.bots/${bot.id}-other/x.md`, `/home/agent/.bots/${bot.id}/../else.md`, "/home/agent/notes.md"]) {
      const pending = ask("Write", { file_path: path });
      const card = listMessages(bot.threadId).at(-1)!;
      expect(card.kind).toBe("approval");
      const { decide } = await import("../src/approvals.ts");
      decide(card.approvalId!, { decision: "deny" });
      expect(await pending).toBe("deny");
    }
  });

  test("approval rules and routines", async () => {
    const { addRule, listRules, createApproval, resolveApproval } = await import("../src/data/approvals.ts");
    const { createRoutine, claimDueRoutines, listRoutines } = await import("../src/data/routines.ts");
    addRule("b1", "Bash(git:*)");
    expect(listRules("b1")).toEqual(["Bash(git:*)"]);
    const approval = createApproval({ botId: "b1", threadId: "t", tool: "Bash", summary: "Run: ls", input: { command: "ls" } });
    expect(resolveApproval(approval.id, "allowed")?.status).toBe("allowed");
    const routine = createRoutine("b1", { name: "r", cron: "* * * * *", timezone: "UTC", prompt: "p", enabled: true });
    expect(routine.nextRunAt).toBeTruthy();
    const due = claimDueRoutines(new Date(Date.now() + 120_000));
    expect(due.map((r) => r.id)).toContain(routine.id);
    expect(listRoutines("b1")[0]!.lastRunAt).toBeTruthy();
  });

  test("a watch keeps its flag and announces itself as a watch when it runs", async () => {
    const { createRoutine, getRoutine, routinePrompt, updateRoutine } = await import("../src/data/routines.ts");
    const { isWatchRun, routineName } = await import("@gond/shared");
    const watch = createRoutine("b1", { name: "Calendar clashes", cron: "0 * * * *", timezone: "UTC", prompt: "Look for clashes.", enabled: true, watch: true });
    expect(getRoutine(watch.id)?.watch).toBe(true);
    const run = routinePrompt(watch);
    expect(isWatchRun(run)).toBe(true);
    expect(routineName(run)).toBe("Calendar clashes");
    const plain = updateRoutine(watch.id, { watch: false })!;
    expect(plain.watch).toBe(false);
    expect(isWatchRun(routinePrompt(plain))).toBe(false);
    expect(routineName(routinePrompt(plain))).toBe("Calendar clashes");
  });

  test("a thread carries what a watch noticed until it is read", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { postMessage, getThread, markThreadRead } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Lookout" }), "u-admin");
    postMessage({ threadId: bot.threadId, author: "routine", body: "[Routine: Morning]\nSay hello.", answered: true });
    await Bun.sleep(2);
    postMessage({ threadId: bot.threadId, author: bot.id, body: "Good morning.", answered: true });
    expect(getThread(bot.threadId)?.noticed).toBeNull();
    await Bun.sleep(2);
    postMessage({ threadId: bot.threadId, author: "routine", body: "[Watch: Calendar]\nLook for clashes.", answered: true });
    await Bun.sleep(2);
    postMessage({ threadId: bot.threadId, author: bot.id, body: "**Dana** moved your 1:1 to 9:00.", answered: true });
    expect(getThread(bot.threadId)?.noticed).toMatchObject({ watch: "Calendar", body: "**Dana** moved your 1:1 to 9:00." });
    await Bun.sleep(2);
    markThreadRead(bot.threadId);
    expect(getThread(bot.threadId)?.noticed).toBeNull();
  });

  test("each person's color is their own, blue until they pick one", async () => {
    const { setUserAccent, userAccent } = await import("../src/data/prefs.ts");
    expect(userAccent("u-color")).toBe("blue");
    setUserAccent("u-color", "purple");
    expect(userAccent("u-color")).toBe("purple");
    expect(userAccent("u-other")).toBe("blue");
    setUserAccent("u-color", "blue");
    expect(userAccent("u-color")).toBe("blue");
  });

  test("a patch keeps what it doesn't mention", async () => {
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { botInputSchema, botPatchSchema, routinePatchSchema, skillPatchSchema } = await import("@gond/shared");
    const lead = createBot(botInputSchema.parse({ name: "Patch Lead", title: "Team Lead", description: "Runs the team.", notify: false }), "u-admin");

    const parsed = botPatchSchema.parse({ pinned: true });
    expect(parsed).toEqual({});
    const after = updateBot(lead.id, { ...parsed, pinned: true })!;
    expect(after.title).toBe("Team Lead");
    expect(after.description).toBe("Runs the team.");
    expect(after.notify).toBe(false);
    expect(after.pinned).toBe(true);
    expect(routinePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(skillPatchSchema.parse({ name: "Notes" })).toEqual({ name: "Notes" });
  });

  test("what a bot sends to a teammate shows in both conversations", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { postMessage, listMessages, listExchange } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@gond/shared");
    const alex = createBot(botInputSchema.parse({ name: "Alex Exchange" }), "u-admin");
    const newbie = createBot(botInputSchema.parse({ name: "Newbie Exchange" }), "u-admin");
    const hello = postMessage({ threadId: newbie.threadId, author: alex.id, body: "Hey, what's your lane?", fromThreadId: alex.threadId, answered: true });
    postMessage({ threadId: newbie.threadId, author: newbie.id, body: "Replied to Alex.", answered: true });

    // The web's cursor is a timestamp; the reply must not share hello's millisecond.
    await Bun.sleep(3);
    const back = postMessage({ threadId: alex.threadId, author: newbie.id, body: "No lane yet.", fromThreadId: newbie.threadId, answered: true });
    expect(listMessages(alex.threadId).map((m) => m.id)).toEqual([back.id]);
    expect(listMessages(alex.threadId, { includeSent: true }).map((m) => m.id)).toEqual([hello.id, back.id]);
    expect(listMessages(alex.threadId, { includeSent: true, after: hello.createdAt }).map((m) => m.id)).toEqual([back.id]);
    expect(listExchange(alex.threadId, newbie.threadId).map((m) => m.id)).toEqual([hello.id, back.id]);
    expect(listExchange(newbie.threadId, alex.threadId).map((m) => m.id)).toEqual([hello.id, back.id]);
  });

  test("in a room, a note to another member is said in the room for everyone, never privately", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { createRoom, getThread, listMessages } = await import("../src/data/threads.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    const patch = createBot(botInputSchema.parse({ name: "Patchy", title: "Servers" }), "u-admin");
    const net = createBot(botInputSchema.parse({ name: "Netty", title: "Network" }), "u-admin");
    const outsider = createBot(botInputSchema.parse({ name: "Outer", title: "Finance" }), "u-admin");
    const room = createRoom("Lab", [patch.id, net.id], "u-admin");
    const context = { box: { url: "http://box.invalid", token: "t", user: "u-admin" }, bot: patch, thread: room, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
    const tool = baseTools(context).message_bot!;

    expect(await tool.execute({ bot: "Netty", text: "The VM is up, you can start your part." }, "c1")).toContain("said here");
    const said = listMessages(room.id).at(-1)!;
    expect(said).toMatchObject({ author: patch.id, body: "@netty The VM is up, you can start your part." });
    const { ensureDatabase } = await import("../src/db/init.ts");
    expect(ensureDatabase().query("SELECT answered_at FROM gond_messages WHERE id = ?").get(said.id)).toEqual({ answered_at: null });
    expect(listMessages(net.threadId)).toEqual([]);

    await tool.execute({ bot: "netty", text: "@netty and the DNS record too." }, "c2");
    expect(listMessages(room.id).at(-1)!.body).toBe("@netty and the DNS record too.");

    expect(await tool.execute({ bot: "Outer", text: "Budget for the VM?" }, "c3")).toContain("Sent to Outer");
    expect(listMessages(outsider.threadId).map((m) => m.body)).toEqual(["Budget for the VM?"]);
    expect(listMessages(room.id)).toHaveLength(2);
    expect(getThread(net.threadId)).toBeTruthy();
  });

  test("any bot creates a teammate with create_bot", async () => {
    const { createBot, listBots, findBot } = await import("../src/data/bots.ts");
    const { getThread, listMessages } = await import("../src/data/threads.ts");
    const { teamTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    const maker = createBot(botInputSchema.parse({ name: "Maker Test", title: "Researcher" }), "u-admin");
    const synced: string[] = [];
    const context = {
      box: { url: "http://box.invalid", token: "t", user: "u-admin" },
      bot: maker,
      thread: getThread(maker.threadId)!,
      message: { depth: 0 } as never,
      askBot: async () => "",
      syncSoul: async (b: { id: string }) => {
        synced.push(b.id);
      },
      stopWork: async () => false,
      isWorking: () => false,
    };
    const tool = teamTools(context).create_bot!;
    expect(await tool.execute({ title: "Developer" }, "call")).toContain("NOT created");
    expect(await tool.execute({ name: "Dev", title: "Developer", description: "Builds things.", color: "mauve" }, "call")).toContain("NOT created");
    const before = listBots().length;
    const answer = await tool.execute({ name: "Dev", title: "Developer", description: "Writes and ships code.", color: "blue" }, "call");
    expect(answer).toContain("Created Dev");
    expect(listBots()).toHaveLength(before + 1);
    const dev = findBot("Dev")!;
    expect(dev.title).toBe("Developer");
    expect(dev.color).toBe("#2F6FD6");
    expect(synced).toEqual([dev.id]);
    expect(listMessages(maker.threadId).some((m) => m.body.includes("added Dev"))).toBe(true);
    expect(await tool.execute({ name: "Dev", title: "Developer", description: "A second one." }, "call")).toContain("Created Dev 2");
  });

  test("an API provider's key is encrypted, write-only, redacted, and one person's own", async () => {
    const { saveProvider, getProvider, listProviders, providerKey, providerProxyToken, providerByToken, deleteProvider } = await import("../src/data/providers.ts");
    const { allSecretValues } = await import("../src/data/secrets.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    expect(() => saveProvider("u-admin", "openai", { baseUrl: "https://api.openai.com/v1" })).toThrow("Add the API key");
    const saved = saveProvider("u-admin", "openai", { baseUrl: "https://api.openai.com/v1/", apiKey: "sk-test-1234567890" });
    expect(saved.baseUrl).toBe("https://api.openai.com/v1");

    expect(JSON.stringify(saved)).not.toContain("sk-test");
    expect(JSON.stringify(listProviders("u-admin"))).not.toContain("sk-test");
    const raw = ensureDatabase().query("SELECT api_key FROM gond_providers WHERE kind = 'openai'").get() as { api_key: string };
    expect(raw.api_key).not.toContain("sk-test");
    expect(providerKey("u-admin", "openai")).toBe("sk-test-1234567890");
    const token = providerProxyToken("u-admin", "openai")!;
    expect(token.length).toBeGreaterThan(20);
    expect(allSecretValues()).toContain("sk-test-1234567890");

    saveProvider("u-admin", "openai", { baseUrl: "https://api.x.ai/v1" });
    expect(providerKey("u-admin", "openai")).toBe("sk-test-1234567890");
    expect(providerProxyToken("u-admin", "openai")).toBe(token);
    expect(getProvider("u-admin", "openai")!.baseUrl).toBe("https://api.x.ai/v1");

    expect(listProviders("u-other")).toEqual([]);
    expect(providerKey("u-other", "openai")).toBeNull();
    saveProvider("u-other", "openai", { baseUrl: "https://api.openai.com/v1", apiKey: "sk-other-1234567890" });
    expect(providerProxyToken("u-other", "openai")).not.toBe(token);
    expect(providerByToken("openai", token)).toMatchObject({ userId: "u-admin", key: "sk-test-1234567890" });
    expect(providerByToken("openai", providerProxyToken("u-other", "openai")!)).toMatchObject({ userId: "u-other", key: "sk-other-1234567890" });
    expect(providerByToken("anthropic", token)).toBeNull();
    expect(deleteProvider("u-other", "openai")).toBe(true);
    expect(providerKey("u-admin", "openai")).toBe("sk-test-1234567890");
    expect(deleteProvider("u-admin", "openai")).toBe(true);
    expect(providerKey("u-admin", "openai")).toBeNull();
  });

  test("more than one engine is on at a time, and the one in use is always among them", async () => {
    const { getAi, updateAi } = await import("../src/data/ai.ts");
    expect(getAi("u-many").enabled).toEqual(["claude"]);

    const two = updateAi("u-many", { enabled: ["claude", "api"] });
    expect(two.enabled).toEqual(["claude", "api"]);
    expect(two.engine).toBe("claude");

    const moved = updateAi("u-many", { engine: "api", engines: { api: { access: "api", model: "MiniMax-M2", provider: "anthropic" } } });
    expect(moved.engine).toBe("api");
    expect(moved.enabled).toEqual(["claude", "api"]);

    const off = updateAi("u-many", { enabled: ["claude"] });
    expect(off.enabled).toEqual(["claude"]);
    expect(off.engine).toBe("claude");

    const odd = updateAi("u-many", { engine: "grok", enabled: ["claude"] });
    expect(odd.engine).toBe("grok");
    expect(odd.enabled).toContain("grok");
  });

  test("Grok from before its CLI went: a key moves to the api engine, the CLI to the plan", async () => {
    const { getAi } = await import("../src/data/ai.ts");
    const { engineRun, EngineSetupError } = await import("../src/engines.ts");
    const { saveProvider, deleteProvider } = await import("../src/data/providers.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const write = (userId: string, grok: object) =>
      ensureDatabase()
        .query("INSERT INTO gond_user_ai (user_id, engine, enabled, engines, updated_at) VALUES (?, 'grok', '[\"claude\",\"grok\"]', ?, '')")
        .run(userId, JSON.stringify({ grok }));
    saveProvider("u-legacy", "xai", { baseUrl: "https://api.x.ai/v1", apiKey: "xai-1234567890" });

    write("u-legacy", { access: "api", model: "grok-4.6", provider: "xai" });
    const keyed = getAi("u-legacy");
    expect(keyed.engine).toBe("api");
    expect(keyed.enabled).toEqual(["claude", "api"]);
    expect(keyed.engines.api).toEqual({ access: "api", model: "grok-4.6", provider: "xai" });
    expect(keyed.engines.grok).toEqual({ access: "api", model: "", provider: "grok" });
    expect(engineRun(keyed, "u-legacy").native?.kind).toBe("xai");
    deleteProvider("u-legacy", "xai");

    write("u-legacy-cli", { access: "plan", model: "grok-build" });
    const cli = getAi("u-legacy-cli");
    expect(cli.engine).toBe("grok");
    expect(cli.engines.grok).toEqual({ access: "api", model: "", provider: "grok" });
    expect(() => engineRun(cli, "u-legacy-cli")).toThrow(EngineSetupError);
    expect(() => engineRun(cli, "u-legacy-cli")).toThrow("Sign in with Grok");
  });

  test("a ChatGPT plan is signed in to, kept encrypted, and redacted", async () => {
    const { saveProvider, savePlanSession, planSession, endPlanSession, getProvider, allProviderKeys, providerProxyToken, deleteProvider } = await import("../src/data/providers.ts");
    const { chatGptClient, setChatGptClient } = await import("../src/data/prefs.ts");
    const { startChatGptLogin, isChatGptState, completeChatGptLogin } = await import("../src/chatgpt.ts");

    expect(() => saveProvider("u-plan", "chatgpt", { baseUrl: "https://api.openai.com/v1", apiKey: "nope-1234567890" })).toThrow("signed in to, not given a key");

    const first = new URL(startChatGptLogin("u-plan"));
    expect(first.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(first.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47651/callback");
    expect(first.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(first.searchParams.get("agent_name_hint")).toBe("Gond");
    expect(first.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(isChatGptState(first.searchParams.get("state"))).toBe(true);
    expect(await completeChatGptLogin({ state: first.searchParams.get("state"), code: "c" }, "u-someone-else")).toEqual({ ok: false, reason: "That sign-in was started by someone else." });

    savePlanSession("u-plan", "chatgpt", "access-token-1234567890", { clientId: "oaiapp_1", refreshToken: "refresh-token-1234567890", idToken: null, expiresAt: Date.now() + 3_600_000, scope: "chatgpt.tokens.use.direct", email: "plan@example.com", name: null });
    setChatGptClient("u-plan", "oaiapp_1");
    const token = providerProxyToken("u-plan", "chatgpt");
    expect(getProvider("u-plan", "chatgpt")?.account).toEqual({ email: "plan@example.com", name: null });
    expect(planSession("u-plan", "chatgpt")?.accessToken).toBe("access-token-1234567890");
    expect(allProviderKeys()).toEqual(expect.arrayContaining(["access-token-1234567890", "refresh-token-1234567890"]));

    const again = new URL(startChatGptLogin("u-plan"));
    expect(again.searchParams.get("client_id")).toBe("oaiapp_1");
    expect(again.searchParams.has("agent_name_hint")).toBe(false);
    expect(again.searchParams.get("ext_agent_host_id")).toBe(first.searchParams.get("ext_agent_host_id"));

    savePlanSession("u-plan", "chatgpt", "access-token-renewed-12345", { ...planSession("u-plan", "chatgpt")!, refreshToken: "refresh-token-renewed-123" });
    expect(providerProxyToken("u-plan", "chatgpt")).toBe(token);

    endPlanSession("u-plan", "chatgpt", "Your ChatGPT sign-in ended. Sign in again.");
    expect(planSession("u-plan", "chatgpt")).toBeNull();
    expect(getProvider("u-plan", "chatgpt")?.account).toBeNull();
    expect(getProvider("u-plan", "chatgpt")?.check?.ok).toBe(false);
    expect(deleteProvider("u-plan", "chatgpt")).toBe(true);
    expect(chatGptClient("u-plan")).toBe("oaiapp_1");
  });

  test("a Grok plan signs in with a code, keeps its tokens encrypted, and signs out", async () => {
    const { startGrokLogin, checkGrokLogin, grokSignIn, grokAccessToken, signOutGrok, GROK_CLIENT_ID } = await import("../src/grok.ts");
    const { getProvider, planSession, allProviderKeys } = await import("../src/data/providers.ts");
    const seen: { url: string; body: URLSearchParams; headers: Headers }[] = [];
    let approved = false;
    const real = globalThis.fetch;
    const answer = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return answer({ device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code", token_endpoint: "https://auth.x.ai/oauth2/token", revocation_endpoint: "https://auth.x.ai/oauth2/revoke" });
      const body = new URLSearchParams(String(init?.body ?? ""));
      seen.push({ url, body, headers: new Headers(init?.headers) });
      if (url.endsWith("/device/code")) return answer({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://accounts.x.ai/device", verification_uri_complete: "https://accounts.x.ai/device?code=ABCD-1234", expires_in: 600, interval: 5 });
      if (url.endsWith("/token") && body.get("grant_type")?.endsWith("device_code")) {
        if (!approved) return answer({ error: "authorization_pending" }, 400);
        const id = `h.${Buffer.from(JSON.stringify({ iss: "https://auth.x.ai", email: "grok@example.com" })).toString("base64url")}.s`;
        return answer({ access_token: "grok-access-1234567890", refresh_token: "grok-refresh-1234567890", id_token: id, expires_in: 60 });
      }
      if (url.endsWith("/token")) return answer({ access_token: "grok-access-renewed-12345", refresh_token: "grok-refresh-renewed-123", expires_in: 21600 });
      if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    try {
      const started = await startGrokLogin("u-grok");
      expect(started).toMatchObject({ state: "waiting", code: "ABCD-1234", url: "https://accounts.x.ai/device?code=ABCD-1234" });
      expect(seen[0]!.body.get("client_id")).toBe(GROK_CLIENT_ID);
      expect(seen[0]!.body.get("scope")).toContain("grok-cli:access");
      expect(seen[0]!.headers.get("x-grok-client-surface")).toBe("headless");

      expect((await checkGrokLogin("u-grok"))?.state).toBe("waiting");
      approved = true;
      expect((await checkGrokLogin("u-grok"))?.state).toBe("done");
      expect(getProvider("u-grok", "grok")?.account).toEqual({ email: "grok@example.com", name: null });
      expect(allProviderKeys()).toEqual(expect.arrayContaining(["grok-access-1234567890", "grok-refresh-1234567890"]));

      // Under five minutes left, so the next use renews it, once, with the rotated refresh token kept.
      expect(await Promise.all([grokAccessToken("u-grok"), grokAccessToken("u-grok")])).toEqual(["grok-access-renewed-12345", "grok-access-renewed-12345"]);
      expect(seen.filter((call) => call.body.get("grant_type") === "refresh_token")).toHaveLength(1);
      expect(planSession("u-grok", "grok")?.refreshToken).toBe("grok-refresh-renewed-123");

      expect(await signOutGrok("u-grok")).toBe(true);
      expect(seen.at(-1)?.body.get("token")).toBe("grok-refresh-renewed-123");
      expect(getProvider("u-grok", "grok")).toBeNull();
      expect(grokSignIn("u-grok")).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });

  test("refreshing an MCP server marks it, so the sessions that use it start again", async () => {
    const { createMcpServer } = await import("../src/data/mcp.ts");
    const { boxMcpServers } = await import("../src/mcp.ts");
    const { mcpRoutes } = await import("../src/routes/mcp.ts");
    const { Hono } = await import("hono");
    const server = createMcpServer({ name: "local-notes", transport: "stdio", command: "notes-mcp", args: [], env: {}, headers: {}, enabled: true }, "u-refresh");
    expect(boxMcpServers({ userId: "u-refresh" })[0]).not.toHaveProperty("rev");

    const app = asPerson(new Hono(), "u-refresh");
    app.route("/api", mcpRoutes());
    const res = await app.request(`/api/mcp-servers/${server.id}/refresh`, { method: "POST" });
    const body = (await res.json()) as { server: { refreshedAt: string | null }; tools: number | null };
    expect(body.tools).toBeNull();
    expect(body.server.refreshedAt).toBeTruthy();
    expect(boxMcpServers({ userId: "u-refresh" })[0]?.rev).toBe(body.server.refreshedAt!);
    expect((await asPerson(new Hono(), "u-someone").route("/api", mcpRoutes()).request(`/api/mcp-servers/${server.id}/refresh`, { method: "POST" })).status).toBe(404);
  });

  test("an engine runs on a key only while that key is there", async () => {
    const { saveProvider, deleteProvider, getProvider } = await import("../src/data/providers.ts");
    const { getAi, updateAi, releaseEngines } = await import("../src/data/ai.ts");
    const saved = (kind: ProviderKind) => Boolean(getProvider("u-keys", kind));

    saveProvider("u-keys", "anthropic", { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-1234567890" });
    saveProvider("u-keys", "openai", { baseUrl: "https://api.openai.com/v1", apiKey: "sk-1234567890" });

    updateAi("u-keys", { engines: { claude: { access: "api", model: "opus" }, api: { access: "api", model: "", provider: "openai" } } });

    deleteProvider("u-keys", "openai");
    releaseEngines("u-keys", "openai", saved);
    expect(getAi("u-keys").engines.claude.access).toBe("api");
    expect(getAi("u-keys").engines.api.access).toBe("api");

    deleteProvider("u-keys", "anthropic");
    releaseEngines("u-keys", "anthropic", saved);
    expect(getAi("u-keys").engines.claude.access).toBe("plan");
  });

  test("AI settings are each person's own, and the team-wide ones from before become the admin's", async () => {
    const { getAi, updateAi, adoptLegacyAi } = await import("../src/data/ai.ts");
    const { readEngines, getSettings } = await import("../src/data/settings.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    expect(getAi("u-admin").engine).toBe("claude");
    const next = updateAi("u-admin", { engine: "grok", engines: { grok: { access: "api", model: "grok-test" } } });
    expect(next.engine).toBe("grok");
    expect(next.engines.grok).toEqual({ access: "api", model: "grok-test", provider: "grok" });

    const direct = updateAi("u-admin", { engine: "api", engines: { api: { access: "api", model: "MiniMax-M2", provider: "anthropic" } } });
    expect(direct.engine).toBe("api");
    expect(direct.engines.api).toEqual({ access: "api", model: "MiniMax-M2", provider: "anthropic" });
    expect(getAi("u-admin").engines.api.provider).toBe("anthropic");
    updateAi("u-admin", { engine: "grok" });
    expect(next.engines.claude.access).toBe("plan");

    expect(getAi("u-other").engine).toBe("claude");
    expect(getAi("u-other").engines.grok.access).toBe("api");

    expect(readEngines(null, "claude-opus-5").claude.model).toBe("claude-opus-5");
    expect(readEngines('{"grok":{"access":"nope","model":"bad model!","provider":"nope"}}', null).grok).toEqual({ access: "api", model: "", provider: "grok" });

    ensureDatabase().query("UPDATE gond_settings SET engine = 'grok', engines = ? WHERE id = 1").run(JSON.stringify({ grok: { access: "api", model: "grok-build" } }));
    adoptLegacyAi("u-admin");
    expect(getAi("u-admin").engines.grok.model).toBe("grok-test");
    ensureDatabase().query("DELETE FROM gond_user_ai WHERE user_id = ?").run("u-admin");
    adoptLegacyAi("u-admin");
    expect(getAi("u-admin")).toMatchObject({ engine: "grok" });
    expect(getAi("u-admin").engines.grok).toEqual({ access: "api", model: "grok-build", provider: "grok" });

    expect(Object.keys(getSettings()).sort()).toEqual(["onboarding", "timezone"]);
    updateAi("u-admin", { engine: "claude", engines: { grok: { access: "plan", model: "" } } });
  });

  test("settings saved while Codex was an engine read back without it", async () => {
    const { getAi } = await import("../src/data/ai.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    ensureDatabase()
      .query("INSERT INTO gond_user_ai (user_id, engine, enabled, engines, updated_at) VALUES (?, 'codex', ?, ?, ?)")
      .run("u-codex", JSON.stringify(["codex", "api"]), JSON.stringify({ codex: { access: "plan", model: "gpt-5.1-codex" } }), new Date().toISOString());
    const ai = getAi("u-codex");
    expect(ai.engine).toBe("claude");
    expect(ai.enabled).toEqual(["claude", "api"]);
    expect(Object.keys(ai.engines).sort()).toEqual(["api", "chatgpt", "claude", "grok"]);
  });

  test("a ChatGPT plan run as the api engine reads back as the ChatGPT engine", async () => {
    const { getAi, updateAi } = await import("../src/data/ai.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    ensureDatabase()
      .query("INSERT INTO gond_user_ai (user_id, engine, enabled, engines, updated_at) VALUES (?, 'api', ?, ?, ?)")
      .run("u-plan-old", JSON.stringify(["claude", "api"]), JSON.stringify({ api: { access: "api", model: "gpt-6.1", provider: "chatgpt" } }), new Date().toISOString());
    const ai = getAi("u-plan-old");
    expect(ai.engine).toBe("chatgpt");
    expect(ai.enabled).toEqual(["claude", "chatgpt"]);
    expect(ai.engines.chatgpt).toEqual({ access: "api", model: "gpt-6.1", provider: "chatgpt" });
    expect(ai.engines.api.provider).toBeNull();
    updateAi("u-plan-old", { engine: "claude" });
    expect(getAi("u-plan-old")).toMatchObject({ engine: "claude", enabled: ["claude", "chatgpt"] });

    const { engineRun, EngineSetupError } = await import("../src/engines.ts");
    const onPlan = updateAi("u-plan-old", { engine: "chatgpt" });
    expect(() => engineRun(onPlan, "u-plan-old")).toThrow(EngineSetupError);
    expect(() => engineRun(onPlan, "u-plan-old")).toThrow("Continue with ChatGPT");
  });

  test("a turn on an API key gets the proxy and the person's own token, never the key", async () => {
    const { saveProvider, deleteProvider, providerProxyToken } = await import("../src/data/providers.ts");
    const { engineRun, EngineSetupError } = await import("../src/engines.ts");
    const { getAi } = await import("../src/data/ai.ts");
    const base = getAi("u-admin");
    const ai = { ...base, engine: "api" as const, enabled: ["api" as const], engines: { ...base.engines, api: { access: "api" as const, model: "grok-4.6", provider: "xai" as const } } };

    expect(() => engineRun(ai, "u-admin")).toThrow(EngineSetupError);
    saveProvider("u-admin", "xai", { baseUrl: "https://api.x.ai/v1", apiKey: "xai-secret-123456" });
    const run = engineRun(ai, "u-admin");
    expect(run.engine).toBe("api");
    expect(run.model).toBe("grok-4.6");
    expect(run.native?.baseUrl).toEndWith("/api/llm/xai");
    expect(run.native?.token).toBe(providerProxyToken("u-admin", "xai")!);

    expect(JSON.stringify(run)).not.toContain("xai-secret");

    expect(() => engineRun({ ...ai, engines: { ...ai.engines, api: { ...ai.engines.api, model: "" } } }, "u-admin")).toThrow(EngineSetupError);

    expect(() => engineRun(ai, "u-other")).toThrow(EngineSetupError);
    deleteProvider("u-admin", "xai");
  });

  test("voice picks the cheapest key unless one is chosen, and transcribes through it", async () => {
    const { saveProvider, deleteProvider } = await import("../src/data/providers.ts");
    const { getVoice, setVoice } = await import("../src/data/voice.ts");
    const { voiceRoutes } = await import("../src/routes/voice.ts");
    const { Hono } = await import("hono");
    const seen: { path: string; auth: string | null; model: unknown; name: string | null }[] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const form = await request.formData();
        const file = form.get("file");
        seen.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), model: form.get("model"), name: file instanceof File ? file.name : null });
        return Response.json({ text: " hello there " });
      },
    });
    const app = asPerson(new Hono(), "u-voice");
    app.route("/api", voiceRoutes());
    const send = (name = "voice.webm", bytes = 10) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(bytes)], name));
      return app.request("/api/transcribe", { method: "POST", body: form });
    };
    try {
      expect(getVoice("u-voice")).toEqual({ preference: "auto", using: null, available: [], openaiModel: "gpt-transcribe" });
      expect((await send()).status).toBe(409);

      saveProvider("u-voice", "openai", { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "sk-voice-key-123456" });
      saveProvider("u-voice", "xai", { baseUrl: `http://127.0.0.1:${upstream.port}/x/v1`, apiKey: "xai-voice-key-123456" });
      expect(getVoice("u-voice").using).toBe("xai");
      const grok = await send();
      expect(await grok.json()).toEqual({ text: "hello there" });
      expect(seen[0]).toEqual({ path: "/x/v1/stt", auth: "Bearer xai-voice-key-123456", model: "grok-voice-transcribe-2.0", name: "recording.webm" });

      expect(setVoice("u-voice", { preference: "openai" }).using).toBe("openai");
      await send("voice.mp4");
      expect(seen[1]).toEqual({ path: "/v1/audio/transcriptions", auth: "Bearer sk-voice-key-123456", model: "gpt-transcribe", name: "recording.mp4" });

      const local = await app.request("/api/voice", { method: "PUT", body: JSON.stringify({ openaiModel: "Systran/faster-whisper-small" }) });
      expect(await local.json()).toMatchObject({ preference: "openai", openaiModel: "Systran/faster-whisper-small" });
      await send();
      expect(seen[2]!.model).toBe("Systran/faster-whisper-small");
      expect((await app.request("/api/voice", { method: "PUT", body: JSON.stringify({ openaiModel: "bad model" }) })).status).toBe(400);
      expect(setVoice("u-voice", { openaiModel: "" }).openaiModel).toBe("gpt-transcribe");

      deleteProvider("u-voice", "openai");
      expect(getVoice("u-voice")).toMatchObject({ preference: "openai", using: "xai" });

      expect((await send("page.html")).status).toBe(400);
      expect((await app.request("/api/transcribe", { method: "POST", body: new FormData() })).status).toBe(400);
      expect((await send("voice.webm", 11 * 1024 * 1024)).status).toBe(413);
      expect((await app.request("/api/voice", { method: "PUT", body: JSON.stringify({ preference: "anthropic" }) })).status).toBe(400);
    } finally {
      upstream.stop(true);
      deleteProvider("u-voice", "openai");
      deleteProvider("u-voice", "xai");
    }
  });

  test("a person's turn after a teammate's message hears that its answer reaches only the person", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { postMessage, getThread } = await import("../src/data/threads.ts");
    const { promptFor } = await import("../src/responder.ts");
    const { botInputSchema } = await import("@gond/shared");
    const clo = createBot(botInputSchema.parse({ name: "Clo", title: "Docs" }), "u-admin");
    const pip = createBot(botInputSchema.parse({ name: "Pipkin", title: "Homelab" }), "u-admin");
    const thread = getThread(pip.threadId)!;
    const asked = postMessage({ threadId: pip.threadId, author: "you", kind: "message", body: "How is the NAS?" });
    expect(promptFor(pip, thread, asked, [clo, pip])).not.toContain("Your answer goes to the person only");
    postMessage({ threadId: pip.threadId, author: clo.id, kind: "message", body: "Please check the new machine.", fromThreadId: clo.threadId, answered: true });
    const goAhead = postMessage({ threadId: pip.threadId, author: "you", kind: "message", body: "go ahead and listen to Clo on this one time." });
    const prompt = promptFor(pip, thread, goAhead, [clo, pip]);
    expect(prompt).toContain("Your answer goes to the person only");
    expect(prompt).toContain("call message_bot");
    expect(prompt).toContain("Clo (teammate, by message): Please check the new machine.");
  });

  test("the LLM proxy swaps its token for its owner's key and refuses everything else", async () => {
    const { saveProvider, deleteProvider, providerProxyToken } = await import("../src/data/providers.ts");
    const { llmProxyRoutes } = await import("../src/routes/llm.ts");
    const { Hono } = await import("hono");
    const seen: { path: string; auth: string | null; xkey: string | null; body: string }[] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push({ path: url.pathname + url.search, auth: request.headers.get("authorization"), xkey: request.headers.get("x-api-key"), body: await request.text() });
        return new Response("data: {\"ok\":true}\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      saveProvider("u-admin", "openai", { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "sk-real-key-123456" });
      saveProvider("u-admin", "anthropic", { baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "ant-real-key-123456" });
      saveProvider("u-other", "openai", { baseUrl: `http://127.0.0.1:${upstream.port}/other`, apiKey: "sk-other-key-123456" });
      const app = new Hono();
      app.route("/api", llmProxyRoutes());
      const token = providerProxyToken("u-admin", "openai")!;
      const refused = await app.request("/api/llm/openai/responses", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
      expect(refused.status).toBe(401);
      expect(seen).toHaveLength(0);
      const ok = await app.request("/api/llm/openai/responses?x=1", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"model":"m"}' });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('"ok":true');
      expect(seen[0]).toEqual({ path: "/v1/responses?x=1", auth: "Bearer sk-real-key-123456", xkey: null, body: '{"model":"m"}' });

      const anthropic = await app.request("/api/llm/anthropic/v1/messages", { method: "POST", headers: { authorization: `Bearer ${providerProxyToken("u-admin", "anthropic")}` }, body: "{}" });
      expect(anthropic.status).toBe(200);
      expect(seen[1]!.path).toBe("/v1/messages");
      expect(seen[1]!.xkey).toBe("ant-real-key-123456");

      expect((await app.request("/api/llm/anthropic/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: "{}" })).status).toBe(401);

      const other = await app.request("/api/llm/openai/responses", { method: "POST", headers: { authorization: `Bearer ${providerProxyToken("u-other", "openai")}` }, body: "{}" });
      expect(other.status).toBe(200);
      expect(seen[2]).toMatchObject({ path: "/other/responses", auth: "Bearer sk-other-key-123456" });
    } finally {
      upstream.stop(true);
      deleteProvider("u-admin", "openai");
      deleteProvider("u-admin", "anthropic");
      deleteProvider("u-other", "openai");
    }
  });

  test("each bot has its own screen, which goes to one of its replies at a time, and the ones turned away hear when it is free", async () => {
    const { releaseComputer, waitForScreen, desktopHolder } = await import("../src/desktop.ts");
    // One bot at work in three conversations, and a second bot alongside.
    const ada = { botId: "b-ada", threadId: "t-ada" };
    const room = { botId: "b-ada", threadId: "t-room" };
    const other = { botId: "b-ada", threadId: "t-other" };
    const bo = { botId: "b-bo", threadId: "t-bo" };
    const user = "u-desk";

    expect(await waitForScreen(user, ada, "desktop", 50)).toBeNull();
    expect(desktopHolder(user, "b-ada")).toEqual(ada);
    expect(await waitForScreen(user, bo, "desktop", 50)).toBeNull();
    expect(desktopHolder(user, "b-bo")).toEqual(bo);
    expect(await waitForScreen(user, ada, "browser", 50)).toBeNull();
    expect(await waitForScreen(user, room, "browser", 50)).toEqual(ada);
    expect(await waitForScreen(user, room, "desktop", 50)).toEqual(ada);

    const waiting = waitForScreen(user, other, "desktop", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await releaseComputer(user, ada.threadId, { botId: ada.botId })).toEqual([room]);
    expect(await waiting).toBeNull();
    expect(desktopHolder(user, "b-ada")).toEqual(other);
    expect(desktopHolder(user, "b-bo")).toEqual(bo);
    expect(await releaseComputer(user, other.threadId, { botId: other.botId })).toEqual([]);
    expect(desktopHolder(user, "b-ada")).toBeNull();
    expect(await waitForScreen(user, room, "browser", 50)).toBeNull();
    await releaseComputer(user, bo.threadId, { botId: bo.botId });
  });

  test("a server that wants a bearer token gets it from a secret in its headers, never on the computer", async () => {
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { getThread } = await import("../src/data/threads.ts");
    const { listMcpServers } = await import("../src/data/mcp.ts");
    const { setSecret, deleteSecret } = await import("../src/data/secrets.ts");
    const { checkMcpHeaders } = await import("../src/mcp.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");

    const stored = (name: string) => name === "CURA_TOKEN";
    expect(checkMcpHeaders(undefined, stored, [])).toEqual({});
    expect(checkMcpHeaders({ Authorization: "Bearer {{secret:CURA_TOKEN}}" }, stored, [])).toEqual({ Authorization: "Bearer {{secret:CURA_TOKEN}}" });
    expect(checkMcpHeaders({ Authorization: "Bearer sk-live-123" }, stored, [])).toContain("{{secret:NAME}}");
    expect(checkMcpHeaders({ "X-Api-Key": "{{secret:OTHER}}" }, stored, [])).toContain("request_secret");
    expect(checkMcpHeaders({ "X-Workspace": "s3cret-value-1" }, stored, ["s3cret-value-1"])).toContain("stored secret");
    expect(checkMcpHeaders({ "X-Gond-Mcp-Token": "x" }, stored, [])).toContain("Gond's own");
    expect(checkMcpHeaders({ "X-Workspace": "team-a" }, stored, [])).toEqual({ "X-Workspace": "team-a" });

    const fake = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        if (request.headers.get("authorization") !== "Bearer tok-123") return new Response("", { status: 401 });
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "cura", version: "1" } } });
      },
    });
    try {
      const bot = updateBot(createBot(botInputSchema.parse({ name: "Curator" }), "u-bearer").id, { approval: "full" })!;
      const context = { box: { url: "http://box.invalid", token: "t", user: "u-bearer" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const tool = baseTools(context).add_mcp_server!;
      const url = `http://127.0.0.1:${fake.port}/mcp`;

      const bare = String(await tool.execute({ name: "cura", url }, "c"));
      expect(bare).toContain("isn't usable yet");
      expect(bare).toContain("request_secret");
      expect(String(await tool.execute({ name: "cura", url, headers: { Authorization: "Bearer tok-123" } }, "c"))).toContain("NOT added");
      expect(String(await tool.execute({ name: "cura", url, headers: { Authorization: "Bearer {{secret:CURA_TOKEN}}" } }, "c"))).toContain("isn't stored yet");
      expect(String(await tool.execute({ name: "cura", command: "node", headers: {} }, "c"))).toContain("NOT added");

      setSecret("u-bearer", "CURA_TOKEN", "tok-123");
      const keyed = String(await tool.execute({ name: "cura", url, headers: { Authorization: "Bearer {{secret:CURA_TOKEN}}" } }, "c"));
      expect(keyed).toContain("Updated cura; it answered with its key");
      const server = listMcpServers("u-bearer").find((m) => m.name === "cura")!;
      expect(server.authStatus).toBe("none");
      expect(server.headers).toEqual({ Authorization: "Bearer {{secret:CURA_TOKEN}}" });
      expect(server.refreshedAt).not.toBeNull();
      expect(JSON.stringify(server)).not.toContain("tok-123");

      setSecret("u-bearer", "CURA_TOKEN", "tok-wrong");
      const { probeMcpServer } = await import("../src/mcp-oauth.ts");
      expect(await probeMcpServer(server.id)).toEqual({ status: "error", detail: "The server turned down the key in its headers." });
      expect(listMcpServers("u-bearer").find((m) => m.name === "cura")?.authStatus).toBe("error");
      deleteSecret("u-bearer", "CURA_TOKEN");
      expect((await probeMcpServer(server.id)).detail).toContain("CURA_TOKEN");
    } finally {
      fake.stop(true);
    }
  });

  test("add_mcp_server attaches a server and posts a sign-in card when it wants one", async () => {
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { getThread, listMessages } = await import("../src/data/threads.ts");
    const { listMcpServers, deleteMcpServer } = await import("../src/data/mcp.ts");
    const { baseTools, mcpServerName } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    expect(mcpServerName("Robinhood Trading!")).toBe("robinhood-trading");

    let port = 0;
    const fake = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const url = new URL(request.url);
        const base = `http://127.0.0.1:${port}`;
        if (url.pathname === "/.well-known/oauth-protected-resource/private/mcp") return Response.json({ resource: `${base}/private/mcp`, authorization_servers: [base] });
        if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
        if (url.pathname === "/register") return Response.json({ client_id: "gond-client" });
        if (url.pathname === "/token") return Response.json({ access_token: "at-123", expires_in: 3600 });
        if (url.pathname === "/private/mcp") return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/private/mcp"` } });
        if (url.pathname === "/public/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "p", version: "1" } } });
        return new Response("", { status: 404 });
      },
    });
    port = fake.port ?? 0;
    try {
      const bot = updateBot(createBot(botInputSchema.parse({ name: "Trader" }), "u-admin").id, { approval: "full" })!;
      const context = { box: { url: "http://box.invalid", token: "t", user: "u-admin" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const tool = baseTools(context).add_mcp_server!;
      expect(await tool.execute({ name: "x", url: "file:///etc/passwd" }, "c")).toContain("NOT added");
      expect(await tool.execute({ name: "x", url: "https://me:pw@example.com/mcp" }, "c")).toContain("NOT added");
      const added = String(await tool.execute({ name: "Robinhood", url: `http://127.0.0.1:${fake.port}/private/mcp` }, "c"));
      expect(added).toContain("Sign in card");
      const server = listMcpServers("u-admin").find((m) => m.name === "robinhood")!;
      expect(server.authStatus).toBe("needed");

      const { getBot } = await import("../src/data/bots.ts");
      const { boxMcpServers } = await import("../src/mcp.ts");
      const other = createBot(botInputSchema.parse({ name: "Bystander" }), "u-admin");
      const theirs = createBot(botInputSchema.parse({ name: "Elsewhere" }), "u-mcp-other");
      expect(boxMcpServers(getBot(bot.id)!).map((m) => m.name)).not.toContain("robinhood");
      expect(boxMcpServers(theirs).map((m) => m.name)).not.toContain("robinhood");
      expect(String(await baseTools({ ...context, bot: other, thread: getThread(other.threadId)! }).connect_app!.execute({ app: "robinhood" }, "c"))).toContain("Sign in card");
      const card = listMessages(bot.threadId).find((m) => m.kind === "signin")!;
      expect(card.approvalId).toBe(server.id);
      expect(card.body).toBe("Sign in to robinhood");

      expect(String(await tool.execute({ name: "robinhood", url: `http://127.0.0.1:${fake.port}/private/mcp` }, "c"))).toContain("already attached");
      expect(String(await baseTools(context).connect_app!.execute({ app: "robinhood" }, "c"))).toContain("Sign in card");
      expect(listMcpServers("u-admin").filter((m) => m.name === "robinhood")).toHaveLength(1);
      expect(listMessages(bot.threadId).filter((m) => m.kind === "signin")).toHaveLength(1);
      expect(String(await tool.execute({ name: "Open Data", url: `http://127.0.0.1:${fake.port}/public/mcp` }, "c"))).toContain("without a sign-in");
      expect(listMcpServers("u-admin").find((m) => m.name === "open-data")?.authStatus).toBe("none");

      const { mcpRoutes } = await import("../src/routes/mcp.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin");
      app.route("/api", mcpRoutes());
      const beforeSignIn = JSON.stringify(boxMcpServers(getBot(bot.id)!));
      const started = (await (await app.request(`/api/mcp-servers/${server.id}/login`, { method: "POST", body: JSON.stringify({ threadId: bot.threadId }) })).json()) as { url: string };
      const state = new URL(started.url).searchParams.get("state")!;
      const back = await app.request(`/api/mcp-servers/oauth/callback?code=c1&state=${state}`);
      expect(back.status).toBe(302);
      expect(back.headers.get("location")).toEndWith(`/app/t/${bot.threadId}`);
      expect(listMcpServers("u-admin").find((m) => m.name === "robinhood")?.authStatus).toBe("signed_in");

      const signedIn = JSON.stringify(boxMcpServers(getBot(bot.id)!));
      expect(signedIn).not.toBe(beforeSignIn);
      expect(signedIn).toContain("signed_in");
      expect(boxMcpServers(other).map((m) => m.name)).toContain("robinhood");
      const after = listMessages(bot.threadId);
      expect(after.some((m) => m.kind === "event" && m.body === "Signed in to robinhood.")).toBe(true);
      expect(after.some((m) => m.kind === "prompt" && m.author === "system" && m.body.includes("robinhood"))).toBe(true);

      const { mcpHandBack } = await import("../src/routes/mcp.ts");
      const { MCP_LOOPBACK_CALLBACK } = await import("@gond/shared");
      const desktop = asPerson(new Hono(), "u-admin");
      desktop.use("/api/mcp-servers/oauth/callback", mcpHandBack);
      desktop.route("/api", mcpRoutes());
      const fromApp = (await (await desktop.request(`/api/mcp-servers/${server.id}/login`, { method: "POST", body: JSON.stringify({ app: "desktop" }) })).json()) as { url: string };
      const appState = new URL(fromApp.url).searchParams.get("state")!;
      const inBrowser = await desktop.request(`/api/mcp-servers/oauth/callback?code=c2&state=${appState}`);
      expect(inBrowser.status).toBe(302);
      const loopback = new URL(inBrowser.headers.get("location")!);
      expect(`${loopback.origin}${loopback.pathname}`).toBe(MCP_LOOPBACK_CALLBACK);
      expect(Object.fromEntries(loopback.searchParams)).toEqual({ code: "c2", state: appState, via: "app" });
      const inApp = await desktop.request(`/api/mcp-servers/oauth/callback${loopback.search}`);
      expect(inApp.headers.get("location")).toStartWith("/app/settings/apps?mcp=");

      const { updateMcpServer } = await import("../src/data/mcp.ts");
      updateMcpServer(server.id, { enabled: false });
      expect(boxMcpServers(other).map((m) => m.name)).not.toContain("robinhood");
      expect(boxMcpServers(other).map((m) => m.name)).toContain("open-data");
      for (const m of listMcpServers("u-admin")) deleteMcpServer(m.id);
      expect(boxMcpServers(getBot(bot.id)!)).toEqual([]);
      expect(boxMcpServers(other)).toEqual([]);
    } finally {
      fake.stop(true);
    }
  });

  test("add_mcp_server attaches a command server, arguments intact, and never with a secret in it", async () => {
    const { createBot, getBot, updateBot } = await import("../src/data/bots.ts");
    const { getThread } = await import("../src/data/threads.ts");
    const { listMcpServers, deleteMcpServer } = await import("../src/data/mcp.ts");
    const { setSecret } = await import("../src/data/secrets.ts");
    const { boxMcpServers } = await import("../src/mcp.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = updateBot(createBot(botInputSchema.parse({ name: "Painter" }), "u-admin").id, { approval: "full" })!;
    const context = { box: { url: "http://box.invalid", token: "t", user: "u-admin" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
    const tool = baseTools(context).add_mcp_server!;
    try {
      expect(await tool.execute({ name: "x" }, "c")).toContain("NOT added");
      expect(await tool.execute({ name: "x", url: "https://example.com/mcp", command: "uv" }, "c")).toContain("NOT added");
      expect(await tool.execute({ name: "x", command: "uv", args: "run" }, "c")).toContain("NOT added");
      setSecret("u-admin", "STEAM_PASSWORD", "hunter2-hunter2");
      expect(await tool.execute({ name: "x", command: "uv", env: { STEAM_PASSWORD: "hunter2-hunter2" } }, "c")).toContain("stored secret");
      const args = ["--directory", "/home/agent/My Tools/aseprite-mcp", "run", "-m", "aseprite_mcp"];
      const added = String(await tool.execute({ name: "Aseprite", command: "/home/agent/.local/bin/uv", args, env: { ASEPRITE_PATH: "/home/agent/.local/bin/aseprite" } }, "c"));
      expect(added).toContain("Added aseprite");
      const server = listMcpServers("u-admin").find((m) => m.name === "aseprite")!;
      expect(server.transport).toBe("stdio");
      expect(server.args).toEqual(args);
      expect(boxMcpServers(getBot(bot.id)!).find((m) => m.name === "aseprite")).toMatchObject({ type: "stdio", command: "/home/agent/.local/bin/uv", args, env: { ASEPRITE_PATH: "/home/agent/.local/bin/aseprite" } });

      expect(String(await tool.execute({ name: "sprites", command: "/home/agent/.local/bin/uv", args }, "c"))).toContain("already attached");
      expect(listMcpServers("u-admin").filter((m) => m.transport === "stdio")).toHaveLength(1);
    } finally {
      for (const m of listMcpServers("u-admin")) deleteMcpServer(m.id);
    }
  });

  test("the api engine talks to the person's MCP servers itself, under the CLI's tool names", async () => {
    const { createMcpServer, deleteMcpServer, listMcpServers, setMcpAuthStatus } = await import("../src/data/mcp.ts");
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { getThread } = await import("../src/data/threads.ts");
    const { nativeMcpTools } = await import("../src/mcp-client.ts");
    const { systemPromptFor } = await import("../src/souls.ts");
    const { botInputSchema } = await import("@gond/shared");
    const sessions: (string | null)[] = [];
    const fake = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id?: number; method: string; params?: { name?: string; arguments?: { q?: string } } };
        sessions.push(req.headers.get("mcp-session-id"));
        if (req.headers.get("x-team") !== "t-1") return Response.json({ error: "no team" }, { status: 400 });
        if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "mcp-session-id": "s-1" } });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search", description: "Search the workspace", inputSchema: { type: "object", properties: { q: { type: "string" } } } }, { name: "a".repeat(80) }] } });
        const reply = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `found ${body.params?.arguments?.q}` }] } };
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      createMcpServer({ name: "toad", transport: "http", url: `http://127.0.0.1:${fake.port}/mcp`, headers: { "X-Team": "t-1" }, args: [], env: {}, enabled: true }, "u-native");
      const waiting = createMcpServer({ name: "notion", transport: "http", url: `http://127.0.0.1:${fake.port}/mcp`, headers: {}, args: [], env: {}, enabled: true }, "u-native");
      setMcpAuthStatus(waiting.id, "needed");
      createMcpServer({ name: "local", transport: "stdio", command: "uv", args: [], headers: {}, env: {}, enabled: true }, "u-native");
      const bot = updateBot(createBot(botInputSchema.parse({ name: "Patch" }), "u-native").id, { approval: "full" })!;
      const thread = getThread(bot.threadId)!;

      const { tools, servers } = await nativeMcpTools({ bot, thread });
      expect(Object.keys(tools)).toEqual(["mcp__toad__search"]);
      expect(await tools.mcp__toad__search!.execute({ q: "roadmap" }, "c1")).toBe("found roadmap");
      expect(sessions.slice(1)).toEqual(["s-1", "s-1", "s-1"]);
      expect(servers.find((m) => m.name === "toad")).toEqual({ name: "toad" });
      expect(servers.find((m) => m.name === "notion")?.note).toContain("sign in");
      expect(servers.find((m) => m.name === "local")?.note).toContain("not a plan or an API key");

      const system = systemPromptFor(bot, { bots: [], thread, memory: null, memoryTruncated: false, teamMemory: null, connections: [], toolNotes: "", timezone: "UTC", skillsIndex: "", mcpServers: servers });
      expect(system).toContain("- toad: tools named mcp__toad__…");
      expect(system).toContain("- notion: not attached yet");
    } finally {
      for (const m of listMcpServers("u-native")) deleteMcpServer(m.id);
      fake.stop(true);
    }
  });

  test("the proxy sends the box's call to the server's own URL, path and all", async () => {
    const { createMcpServer, deleteMcpServer, mcpProxyToken } = await import("../src/data/mcp.ts");
    const { boxMcpServers } = await import("../src/mcp.ts");
    const { mcpProxyRoutes } = await import("../src/routes/mcp.ts");
    const { Hono } = await import("hono");
    const seen: string[] = [];
    const fake = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(url.pathname + url.search);
        if (url.pathname === "/mcp/trading") return Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "x-upstream": "yes" } });
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const server = createMcpServer({ name: "robinhood", transport: "http", url: `http://127.0.0.1:${fake.port}/mcp/trading`, headers: { "X-Gond-Test": "1" }, args: [], env: {}, enabled: true }, "u-admin");
      const [given] = boxMcpServers({ userId: "u-admin" });
      expect(given?.type).toBe("http");
      if (given?.type !== "http") throw new Error("expected an http server");
      const app = new Hono().route("/api", mcpProxyRoutes());
      const path = `${new URL(given.url).pathname}?a=1`;
      const call = (headers: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
      expect((await call({})).status).toBe(403);
      const res = await call(given.headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-upstream")).toBe("yes");
      expect(seen).toEqual(["/mcp/trading?a=1"]);
      expect(mcpProxyToken(server.id)).toBe(given.headers["X-Gond-Mcp-Token"]);
      deleteMcpServer(server.id);
    } finally {
      fake.stop(true);
    }
  });

  test("a server's picture comes from its host's site icon, an app it's named after, or nothing", async () => {
    const { createMcpServer, deleteMcpServer } = await import("../src/data/mcp.ts");
    const { iconHosts, resolveMcpIcon } = await import("../src/mcp-icon.ts");
    expect(iconHosts("https://agent.robinhood.com/mcp/trading")).toEqual(["agent.robinhood.com", "robinhood.com"]);
    expect(iconHosts("https://linear.app/mcp")).toEqual(["linear.app"]);
    expect(iconHosts("http://localhost:3000/mcp")).toEqual([]);
    expect(iconHosts("http://10.0.0.5:8080/mcp")).toEqual([]);
    expect(iconHosts(undefined)).toEqual([]);
    const asked: string[] = [];
    const icons = Bun.serve({
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.slice(1);
        asked.push(name);

        if (name === "robinhood.com.ico") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 404, headers: { "content-type": "image/png" } });
      },
    });
    const iconService = `http://127.0.0.1:${icons.port}/`;
    try {
      const robinhood = createMcpServer({ name: "robinhood", transport: "http", url: "https://agent.robinhood.com/mcp/trading", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      const found = await resolveMcpIcon(robinhood, { iconService });
      expect(found?.kind).toBe("image");
      expect(asked).toEqual(["agent.robinhood.com.ico", "robinhood.com.ico"]);

      await resolveMcpIcon(robinhood, { iconService });
      expect(asked).toHaveLength(2);
      const nowhere = createMcpServer({ name: "nowhere", transport: "http", url: "https://nonexistent.example/mcp", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      expect(await resolveMcpIcon(nowhere, { iconService })).toBeNull();
      const notion = createMcpServer({ name: "notion", transport: "http", url: "https://mcp.notion.com/mcp", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      expect(await resolveMcpIcon(notion, { iconService })).toEqual({ kind: "redirect", url: "https://logos.composio.dev/api/notion" });
      const command = createMcpServer({ name: "local", transport: "stdio", command: "npx", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      expect(await resolveMcpIcon(command, { iconService })).toBeNull();
      const { mcpRoutes } = await import("../src/routes/mcp.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin").route("/api", mcpRoutes());
      expect((await app.request(`/api/mcp-servers/${notion.id}/icon`)).status).toBe(302);
      expect((await app.request(`/api/mcp-servers/${command.id}/icon`)).status).toBe(404);
      for (const s of [robinhood, nowhere, notion, command]) deleteMcpServer(s.id);
    } finally {
      icons.stop(true);
    }
  });

  test("a localhost sign-in registers the loopback redirect and finishes from a pasted address", async () => {
    const { createMcpServer, deleteMcpServer, getMcpServer } = await import("../src/data/mcp.ts");
    const { MCP_LOOPBACK_CALLBACK, defaultOAuthRedirect } = await import("@gond/shared");
    expect(defaultOAuthRedirect("https://agent.robinhood.com/mcp/trading")).toBe("localhost");
    expect(defaultOAuthRedirect("https://mcp.linear.app/mcp")).toBe("app");
    let port = 0;
    const registered: string[][] = [];
    const tokenBodies: URLSearchParams[] = [];
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const base = `http://127.0.0.1:${port}`;
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
        if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
        if (url.pathname === "/register") {
          registered.push(((await request.json()) as { redirect_uris: string[] }).redirect_uris);
          return Response.json({ client_id: `client-${registered.length}` });
        }
        if (url.pathname === "/token") {
          tokenBodies.push(new URLSearchParams(await request.text()));
          return Response.json({ access_token: "at-local", expires_in: 3600 });
        }
        if (url.pathname === "/mcp") return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
        return new Response("", { status: 404 });
      },
    });
    port = fake.port ?? 0;
    try {
      const server = createMcpServer({ name: "local-only", transport: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {}, args: [], env: {}, enabled: true, oauthRedirect: "localhost" }, "u-admin");
      expect(server.oauthRedirect).toBe("localhost");
      const { mcpRoutes } = await import("../src/routes/mcp.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin");
      app.route("/api", mcpRoutes());
      const started = (await (await app.request(`/api/mcp-servers/${server.id}/login`, { method: "POST", body: "{}" })).json()) as { url: string };
      const authorize = new URL(started.url);
      expect(authorize.searchParams.get("redirect_uri")).toBe(MCP_LOOPBACK_CALLBACK);
      expect(registered[0]).toEqual([MCP_LOOPBACK_CALLBACK]);
      const bad = await app.request("/api/mcp-servers/oauth/complete", { method: "POST", body: JSON.stringify({ url: "not an address" }) });
      expect(bad.status).toBe(400);
      const pasted = `${MCP_LOOPBACK_CALLBACK}?code=c9&state=${authorize.searchParams.get("state")}`;
      const done = await app.request("/api/mcp-servers/oauth/complete", { method: "POST", body: JSON.stringify({ url: pasted }) });
      expect(done.status).toBe(200);
      expect(((await done.json()) as { name: string }).name).toBe("local-only");
      expect(tokenBodies[0]?.get("redirect_uri")).toBe(MCP_LOOPBACK_CALLBACK);
      expect(getMcpServer(server.id)?.authStatus).toBe("signed_in");

      await app.request(`/api/mcp-servers/${server.id}`, { method: "PATCH", body: JSON.stringify({ oauthRedirect: "app" }) });
      await app.request(`/api/mcp-servers/${server.id}/login`, { method: "POST", body: "{}" });
      expect(registered).toHaveLength(2);
      expect(registered[1]?.[0]).toEndWith("/api/mcp-servers/oauth/callback");
      deleteMcpServer(server.id);
    } finally {
      fake.stop(true);
    }
  });

  test("a CLI signs in from the app: the computer drives it and the person is told when it lands", async () => {
    const { subscribe } = await import("../src/events.ts");
    const { watchEngineSignIn } = await import("../src/status.ts");
    let state = "waiting";
    const seen: { user: string | null; auth: string | null; code: string | null } = { user: null, auth: null, code: null };
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        seen.user = request.headers.get("x-gond-user");
        seen.auth = request.headers.get("authorization");
        const view = { engine: "claude", state, url: "https://claude.com/cai/oauth/authorize?code=true", code: null, needsCode: true, error: null, startedAt: "2026-01-01T00:00:00Z" };
        if (url.pathname === "/engines/claude/sign-in" && request.method === "POST") return Response.json({ signIn: { ...view, state: "starting", url: null } });
        if (url.pathname === "/engines/claude/sign-in" && request.method === "GET") return Response.json({ signIn: view });
        if (url.pathname === "/engines/claude/sign-in" && request.method === "DELETE") return Response.json({ ok: true });
        if (url.pathname === "/engines/claude/sign-in/code") {
          seen.code = ((await request.json()) as { code: string }).code;
          return Response.json({ signIn: { ...view, state: "finishing" } });
        }
        return new Response("", { status: 404 });
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const { boxRoutes } = await import("../src/routes/box.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin");
      app.route("/api", boxRoutes());

      expect((await app.request("/api/box/engines/nothing/sign-in")).status).toBe(404);

      const started = await app.request("/api/box/engines/claude/sign-in", { method: "POST", body: "{}" });
      expect(started.status).toBe(200);
      expect(((await started.json()) as { signIn: { state: string } }).signIn.state).toBe("starting");

      expect(seen.user).toBe("u-admin");
      expect(seen.auth).toBe("Bearer box-token");

      const waiting = (await (await app.request("/api/box/engines/claude/sign-in")).json()) as { signIn: { url: string; needsCode: boolean } };
      expect(waiting.signIn.url).toStartWith("https://claude.com/cai/oauth/authorize");
      expect(waiting.signIn.needsCode).toBe(true);

      expect((await app.request("/api/box/engines/claude/sign-in/code", { method: "POST", body: JSON.stringify({ code: "no" }) })).status).toBe(400);
      const answered = await app.request("/api/box/engines/claude/sign-in/code", { method: "POST", body: JSON.stringify({ code: "abcd#state" }) });
      expect(answered.status).toBe(200);
      expect(seen.code).toBe("abcd#state");

      const told = new Promise<void>((resolve) => {
        const off = subscribe((event) => {
          if (event.topic === "ai" && event.userId === "u-admin") {
            off();
            resolve();
          }
        });
      });
      watchEngineSignIn(boxConfig("u-admin")!, "u-admin", "claude", 20);
      state = "done";
      await told;

      expect((await app.request("/api/box/engines/claude/sign-in", { method: "DELETE" })).status).toBe(204);
    } finally {
      fake.stop(true);
      if (boxUrl === undefined) delete process.env.GOND_BOX_URL;
      else process.env.GOND_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.GOND_BOX_TOKEN;
      else process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("a push notice also goes out as a notify live event", async () => {
    const { subscribe } = await import("../src/events.ts");
    const { sendPush } = await import("../src/push.ts");
    const seen: unknown[] = [];
    const stop = subscribe((event) => {
      if (event.topic === "notify") seen.push(event);
    });
    try {
      expect(await sendPush({ title: "Pip", body: "Done.", url: "/app/t/t1", tag: "t1", threadId: "t1" }, "u-admin")).toBe(0);
    } finally {
      stop();
    }
    expect(seen).toEqual([{ topic: "notify", userId: "u-admin", title: "Pip", body: "Done.", url: "/app/t/t1", tag: "t1", threadId: "t1", device: null }]);
  });

  test("the time zone is the person's browser's, and a change moves their routines", async () => {
    const { userTimezone, setUserTimezone } = await import("../src/data/prefs.ts");
    const { updateSettings } = await import("../src/data/settings.ts");
    const { createBot } = await import("../src/data/bots.ts");
    const { createRoutine, getRoutine } = await import("../src/data/routines.ts");
    const { botInputSchema } = await import("@gond/shared");
    const before = userTimezone("u-zone");
    updateSettings({ timezone: "Europe/Paris" });
    expect(userTimezone("u-zone")).toBe("Europe/Paris");
    expect(userTimezone(null)).toBe("Europe/Paris");
    updateSettings({ timezone: "" });
    expect(userTimezone("u-zone")).toBe("UTC");
    const bot = createBot(botInputSchema.parse({ name: "Clock" }), "u-zone");
    const other = createBot(botInputSchema.parse({ name: "Theirs" }), "u-zone-other");
    const routine = createRoutine(bot.id, { name: "Morning", cron: "0 9 * * *", timezone: "UTC", prompt: "p", enabled: true });
    const theirs = createRoutine(other.id, { name: "Theirs", cron: "0 9 * * *", timezone: "UTC", prompt: "p", enabled: true });
    expect(setUserTimezone("u-zone", "Not/AZone")).toBe(false);
    expect(setUserTimezone("u-zone", 42)).toBe(false);
    expect(userTimezone("u-zone")).toBe("UTC");
    expect(setUserTimezone("u-zone", "Asia/Tokyo")).toBe(true);
    expect(userTimezone("u-zone")).toBe("Asia/Tokyo");
    expect(setUserTimezone("u-zone", "Asia/Tokyo")).toBe(false);
    const moved = getRoutine(routine.id)!;
    expect(moved.timezone).toBe("Asia/Tokyo");
    expect(moved.nextRunAt).not.toBe(routine.nextRunAt);
    expect(new Date(moved.nextRunAt!).getUTCHours()).toBe(0);
    expect(getRoutine(theirs.id)).toMatchObject({ timezone: "UTC", nextRunAt: theirs.nextRunAt });
    updateSettings({ timezone: before });
  });

  test("a person only switches a routine on or off; its bot makes, changes and removes it", async () => {
    const { Hono } = await import("hono");
    const { routinesRoutes } = await import("../src/routes/routines.ts");
    const { createBot } = await import("../src/data/bots.ts");
    const { createSkill } = await import("../src/data/skills.ts");
    const { getRoutine, listRoutines } = await import("../src/data/routines.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Planner" }), "u-sched");
    const app = asPerson(new Hono(), "u-sched").route("/api", routinesRoutes());
    const send = (path: string, method: string, body?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

    expect((await send(`/api/bots/${bot.id}/routines`, "POST", { name: "Mine", cron: "0 9 * * *", prompt: "p" })).status).toBe(404);
    expect(listRoutines(bot.id)).toHaveLength(0);

    const skill = createSkill("u-sched", { name: "Digest", description: "", instructions: "Summarize." });
    const tools = baseTools({ bot, thread: { id: bot.threadId }, message: { depth: 0 } } as unknown as Parameters<typeof baseTools>[0]);
    expect(String(await tools.create_routine!.execute({ name: "Morning", cron: "0 9 * * *", prompt: "Brief me", skill: "/nope" }, "c"))).toContain("NOT created");
    expect(String(await tools.create_routine!.execute({ name: "Morning", cron: "0 9 * * *", prompt: "Brief me", skill: `/${skill.slug}` }, "c"))).toContain("Created");
    const routine = listRoutines(bot.id)[0]!;
    expect(routine).toMatchObject({ skillId: skill.id, enabled: false });

    expect((await send(`/api/routines/${routine.id}`, "PATCH", { prompt: "Something else" })).status).toBe(400);
    expect((await send(`/api/routines/${routine.id}`, "PATCH", { enabled: true, name: "Renamed" })).status).toBe(200);
    expect(getRoutine(routine.id)).toMatchObject({ enabled: true, name: "Morning", prompt: "Brief me" });
    expect((await send(`/api/routines/${routine.id}`, "DELETE")).status).toBe(404);
    expect((await send(`/api/routines/${routine.id}/run`, "POST")).status).toBe(404);
    expect((await send(`/api/routines/${routine.id}/runs`, "GET")).status).toBe(404);
    expect((await asPerson(new Hono(), "u-sched-other").route("/api", routinesRoutes()).request(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status).toBe(404);

    expect(String(await tools.update_routine!.execute({ routine: "Morning", skill: "" }, "c"))).toContain("Updated");
    expect(getRoutine(routine.id)?.skillId).toBeNull();
    expect(String(await tools.delete_routine!.execute({ routine: "Morning" }, "c"))).toContain("Deleted");
    expect(getRoutine(routine.id)).toBeNull();
  });

  test("resetting your computer resets only your own account on the box", async () => {
    const { Hono } = await import("hono");
    const { boxRoutes } = await import("../src/routes/box.ts");
    const calls: { path: string; method: string; user: string | null }[] = [];
    const fake = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const path = new URL(request.url).pathname;
        calls.push({ path, method: request.method, user: request.headers.get("X-Gond-User") });
        return path === "/home/reset" ? Response.json({ ok: true, removed: 42 }) : Response.json({});
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const app = asPerson(new Hono(), "u-fresh").route("/api", boxRoutes());
      const response = await app.request("/api/box/home/reset", { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, removed: 42 });
      const reset = calls.filter((call) => call.path === "/home/reset");
      expect(reset).toHaveLength(1);
      expect(reset[0]).toMatchObject({ method: "POST", user: "u-fresh" });
    } finally {
      fake.stop(true);
      process.env.GOND_BOX_URL = boxUrl;
      process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("a bot's picture is its owner's to set, see and remove", async () => {
    const { Hono } = await import("hono");
    const { botsRoutes } = await import("../src/routes/bots.ts");
    const { createBot, deleteBot, getBot, getBotAvatar } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Pictured" }), "u-pic");
    expect(bot.avatar).toBeNull();
    const mine = asPerson(new Hono(), "u-pic").route("/api", botsRoutes());
    const theirs = asPerson(new Hono(), "u-pic-other").route("/api", botsRoutes());
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const upload = (app: typeof mine, type = "image/png", bytes = png) => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type }), "bot.png");
      return app.request(`/api/bots/${bot.id}/avatar`, { method: "PUT", body: form });
    };

    expect((await upload(theirs)).status).toBe(404);
    expect((await upload(mine, "image/svg+xml", new TextEncoder().encode("<svg onload=alert(1)>"))).status).toBe(400);
    const saved = await upload(mine);
    expect(saved.status).toBe(200);
    const url = getBot(bot.id)!.avatar!;
    expect(url).toStartWith(`/api/bots/${bot.id}/avatar?v=`);
    const served = await mine.request(url);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    expect((await theirs.request(url)).status).toBe(404);

    expect((await mine.request(`/api/bots/${bot.id}/avatar`, { method: "DELETE" })).status).toBe(204);
    expect(getBot(bot.id)!.avatar).toBeNull();
    await upload(mine);
    deleteBot(bot.id);
    expect(getBotAvatar(bot.id)).toBeNull();
  });

  test("a bot is a cog unless it is given another shape", async () => {
    const { createBot, getBot, updateBot } = await import("../src/data/bots.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Shapely" }), "u-shape");
    expect(bot.shape).toBe("cog");
    expect(updateBot(bot.id, { shape: "cloud" })?.shape).toBe("cloud");
    const tools = baseTools({ bot: getBot(bot.id)!, thread: { id: bot.threadId }, message: { depth: 0 }, syncSoul: async () => undefined } as unknown as Parameters<typeof baseTools>[0]);
    expect(String(await tools.set_profile!.execute({ shape: "hexagon" }, "c"))).toContain("NOT changed");
    await tools.set_profile!.execute({ shape: "Triangle" }, "c");
    expect(getBot(bot.id)?.shape).toBe("triangle");
    ensureDatabase().query("UPDATE gond_bots SET shape = 'blob' WHERE id = ?").run(bot.id);
    expect(getBot(bot.id)?.shape).toBe("cog");
  });

  test("a presence ping stores the browser's time zone", async () => {
    const { Hono } = await import("hono");
    const { pushRoutes } = await import("../src/routes/push.ts");
    const { userTimezone } = await import("../src/data/prefs.ts");
    const app = asPerson(new Hono(), "u-ping").route("/api", pushRoutes());
    const ping = (body: unknown) => app.request("/api/push/viewing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await ping({ client: "w1", threadId: null, timezone: "America/Chicago" })).status).toBe(204);
    expect(userTimezone("u-ping")).toBe("America/Chicago");
    expect((await ping({ client: "w1", threadId: null, timezone: "Nowhere/Nothing" })).status).toBe(204);
    expect(userTimezone("u-ping")).toBe("America/Chicago");
    expect((await ping({ client: "w1", threadId: null })).status).toBe(204);
    expect(userTimezone("u-ping")).toBe("America/Chicago");
    expect((await ping({ client: "bad client!", threadId: null, timezone: "Europe/Rome" })).status).toBe(400);
    expect(userTimezone("u-ping")).toBe("America/Chicago");
  });

  test("a notification goes to the person's own subscriptions, on the device they used last", async () => {
    const { Hono } = await import("hono");
    const { mock } = await import("bun:test");
    const delivered: string[] = [];
    mock.module("web-push", () => ({
      default: {
        generateVAPIDKeys: () => ({ publicKey: "pk", privateKey: "sk" }),
        sendNotification: async (sub: { endpoint: string }) => {
          delivered.push(sub.endpoint);
          return { statusCode: 201 };
        },
      },
    }));
    const { pushRoutes } = await import("../src/routes/push.ts");
    const { sendPush } = await import("../src/push.ts");
    const notice = { title: "Gond", body: "Done.", url: "/app", tag: "t", threadId: "" };
    const { saveSubscription } = await import("../src/data/push.ts");
    const { markViewing } = await import("../src/presence.ts");
    const { subscribe } = await import("../src/events.ts");
    saveSubscription({ endpoint: "https://push.example/tester", keys: { p256dh: "a", auth: "b" } }, "u-tester");
    saveSubscription({ endpoint: "https://push.example/bystander", keys: { p256dh: "a", auth: "b" } }, "u-bystander");
    markViewing("u-tester", "w1", "t-open");
    const seen: unknown[] = [];
    const stop = subscribe((event) => {
      if (event.topic === "notify") seen.push(event);
    });
    try {
      expect(await sendPush(notice, "u-tester")).toBe(1);
    } finally {
      stop();
    }
    expect(delivered).toEqual(["https://push.example/tester"]);
    expect(seen).toEqual([{ topic: "notify", userId: "u-tester", ...notice, device: null }]);

    delivered.length = 0;
    seen.length = 0;
    saveSubscription({ endpoint: "https://push.example/tester-phone", keys: { p256dh: "a", auth: "b" } }, "u-tester", "", "phone");
    const again = subscribe((event) => {
      if (event.topic === "notify") seen.push(event);
    });
    try {
      const app = asPerson(new Hono(), "u-tester").route("/api", pushRoutes());
      const used = await app.request("/api/push/viewing", { method: "POST", body: JSON.stringify({ client: "w2", threadId: null, device: "phone", active: true }) });
      expect(used.status).toBe(204);
      expect(await sendPush(notice, "u-tester")).toBe(1);
    } finally {
      again();
    }
    expect(delivered).toEqual(["https://push.example/tester-phone"]);
    expect(seen).toMatchObject([{ topic: "notify", device: "phone" }]);
  });

  test("each person has their own bots, conversations and subscriptions", async () => {
    const { createBot, listBots, getPrimary } = await import("../src/data/bots.ts");
    const { createRoom, listThreads, postMessage, searchMessages, threadOwner } = await import("../src/data/threads.ts");
    const { saveSubscription, listSubscriptions, removeSubscription } = await import("../src/data/push.ts");
    const { botInputSchema } = await import("@gond/shared");
    const mine = createBot(botInputSchema.parse({ name: "Mine" }), "u-me");
    const theirs = createBot(botInputSchema.parse({ name: "Theirs" }), "u-them");
    expect(listBots({ userId: "u-me" }).map((b) => b.id)).toEqual([mine.id]);
    expect(listBots({ userId: "u-them" }).map((b) => b.id)).toEqual([theirs.id]);
    expect(getPrimary("u-me")?.id).toBe(mine.id);
    expect(getPrimary("u-them")?.id).toBe(theirs.id);
    expect(threadOwner(mine.threadId)).toBe("u-me");
    const room = createRoom("Ours", [mine.id], "u-me");
    expect(listThreads({ userId: "u-me" }).map((t) => t.id).sort()).toEqual([mine.threadId, room.id].sort());
    expect(listThreads({ userId: "u-them" }).map((t) => t.id)).toEqual([theirs.threadId]);
    postMessage({ threadId: mine.threadId, author: "you", body: "the secret plan" });
    postMessage({ threadId: theirs.threadId, author: "you", body: "the secret plan" });
    expect(searchMessages("secret plan", "u-me").map((m) => m.threadId)).toEqual([mine.threadId]);
    const kopia = postMessage({ threadId: mine.threadId, author: "you", body: "Delete the old Kopia cache on ditto, then check the B2 backup" });
    const found = (query: string) => searchMessages(query, "u-me").map((m) => m.id);
    expect(found("KOPIA")).toEqual([kopia.id]);
    expect(found("opia")).toEqual([kopia.id]);
    expect(found("backup kopia")).toEqual([kopia.id]);
    expect(found("b2 kopia")).toEqual([kopia.id]);
    expect(found("b2")).toEqual([kopia.id]);
    expect(found("kopia restic")).toEqual([]);
    expect(found('"kopia" OR plan')).toEqual([]);
    expect(searchMessages("kopia", "u-them")).toEqual([]);
    const { dropMessage } = await import("../src/data/threads.ts");
    dropMessage(kopia.id);
    expect(found("kopia")).toEqual([]);
    saveSubscription({ endpoint: "https://push.example/me", keys: { p256dh: "a", auth: "b" } }, "u-me");
    saveSubscription({ endpoint: "https://push.example/them", keys: { p256dh: "a", auth: "b" } }, "u-them");
    expect(listSubscriptions("u-me").map((s) => s.endpoint)).toEqual(["https://push.example/me"]);

    expect(removeSubscription("https://push.example/them", "u-me")).toBe(false);
    expect(removeSubscription("https://push.example/them", "u-them")).toBe(true);
  });

  test("the OIDC provider's secret is stored encrypted and never read back", async () => {
    const { getOidcSettings, updateOidcSettings, oidcProvider, oidcReady, clearOidcSecret } = await import("../src/data/oidc.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    expect(oidcReady()).toBe(false);
    updateOidcSettings({ name: "Pocket ID", issuer: "https://id.example.com/", clientId: "gond", clientSecret: "s3cret-value", scopes: "" });
    const shown = getOidcSettings();
    expect(shown).toMatchObject({ enabled: false, name: "Pocket ID", issuer: "https://id.example.com", clientId: "gond", scopes: "openid profile email", hasClientSecret: true });
    expect(JSON.stringify(shown)).not.toContain("s3cret-value");
    const raw = ensureDatabase().query("SELECT oidc FROM gond_settings WHERE id = 1").get() as { oidc: string };
    expect(raw.oidc).not.toContain("s3cret-value");

    expect(oidcProvider()).toBeNull();
    updateOidcSettings({ enabled: true });
    expect(oidcProvider()).toEqual({ name: "Pocket ID", issuer: "https://id.example.com", clientId: "gond", clientSecret: "s3cret-value", scopes: ["openid", "profile", "email"] });

    updateOidcSettings({ clientSecret: "" });
    expect(oidcProvider()?.clientSecret).toBe("s3cret-value");
    expect(clearOidcSecret()).toMatchObject({ enabled: false, hasClientSecret: false });
    expect(oidcReady()).toBe(false);
  });

  test("the first account is the admin and adopts what came before users", async () => {
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { ensureAdmin, adoptOrphans, listUsers, getUser, isAdmin, deleteUserData } = await import("../src/data/users.ts");
    const { createBot, listBots } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const db = ensureDatabase();

    db.exec('DELETE FROM "user"; DELETE FROM "account";');
    db.query('INSERT INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, NULL, ?, ?)').run("u-first", "dawson", "dawson@users.krubot.invalid", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.query('INSERT INTO "account" (id, userId, providerId, accountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("a1", "u-first", "credential", "u-first", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.query('INSERT INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("u-sso", "Sam", "sam@example.com", "user", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
    db.query('INSERT INTO "account" (id, userId, providerId, accountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("a2", "u-sso", "oidc", "sub-1", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
    expect(ensureAdmin()).toBe("u-first");
    expect(getUser("u-first")).toMatchObject({ role: "admin", provider: "local" });
    expect(getUser("u-sso")).toMatchObject({ role: "user", provider: "oidc" });
    expect(isAdmin({ role: "admin" })).toBe(true);
    expect(isAdmin({ role: "user" })).toBe(false);

    const orphan = createBot(botInputSchema.parse({ name: "Old Timer" }), "u-first");
    db.query("UPDATE gond_bots SET user_id = NULL WHERE id = ?").run(orphan.id);
    db.query("UPDATE gond_threads SET user_id = NULL WHERE id = ?").run(orphan.threadId);
    adoptOrphans("u-first");
    expect(listBots({ userId: "u-first", includeHidden: true }).some((b) => b.id === orphan.id)).toBe(true);
    const sam = createBot(botInputSchema.parse({ name: "Sam's Bot" }), "u-sso");
    expect(listUsers().map((u) => [u.id, u.role, u.bots >= 1])).toEqual([["u-first", "admin", true], ["u-sso", "user", true]]);
    expect(deleteUserData("u-sso").bots).toEqual([sam.id]);
    expect(listBots({ userId: "u-sso", includeHidden: true })).toEqual([]);
    expect(listBots({ userId: "u-first", includeHidden: true }).some((b) => b.id === orphan.id)).toBe(true);
  });

  test("send_file hands the person a file from the box as an attachment", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { getAttachment, getThread, listMessages } = await import("../src/data/threads.ts");
    const { baseTools, sharePath } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    expect(sharePath("~/.team/hello-world.html", "b1")).toBe(".team/hello-world.html");

    expect(sharePath("/home/agent/.team/a.txt", "b1", "/home/agent")).toBe(".team/a.txt");
    expect(sharePath("/home/gond-ada/notes/a.txt", "b1", "/home/gond-ada")).toBe("notes/a.txt");
    expect(sharePath("/home/agent/.team/a.txt", "b1", "/home/gond-ada")).toBeNull();
    expect(sharePath("/home/agent/.team/a.txt", "b1")).toBeNull();
    expect(sharePath("out/report.pdf", "b1")).toBe(".bots/b1/out/report.pdf");
    expect(sharePath("../../../../etc/passwd", "b1")).toBeNull();
    expect(sharePath("/etc/passwd", "b1", "/home/agent")).toBeNull();
    const asked: string[] = [];
    const box = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const url = new URL(request.url);
        if (url.pathname !== "/files/raw") return new Response("", { status: 404 });
        const path = url.searchParams.get("path") ?? "";
        asked.push(path);
        if (path.endsWith("missing.html")) return Response.json({ error: "No such file" }, { status: 404 });
        return new Response("<h1>Hello world</h1>", { headers: { "Content-Type": "application/octet-stream" } });
      },
    });
    try {
      const bot = createBot(botInputSchema.parse({ name: "Sender" }), "u-admin");
      const context = { box: { url: `http://127.0.0.1:${box.port}`, token: "t", user: "u-admin" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const tool = baseTools(context).send_file!;
      expect(String(await tool.execute({ path: "~/.team/missing.html" }, "c"))).toContain("NOT sent");
      expect(String(await tool.execute({ path: "~/.team/hello-world.html", note: "Here it is." }, "c"))).toContain("Sent hello-world.html");
      expect(asked).toContain(".team/hello-world.html");
      const posted = listMessages(bot.threadId).find((m) => m.attachments.length)!;
      expect(posted.author).toBe(bot.id);
      expect(posted.body).toBe("Here it is.");
      expect(posted.attachments[0]).toMatchObject({ name: "hello-world.html", mediaType: "text/html" });
      expect(new TextDecoder().decode(getAttachment(posted.attachments[0]!.id)!.data)).toBe("<h1>Hello world</h1>");

      const { threadsRoutes } = await import("../src/routes/threads.ts");
      const { Hono } = await import("hono");
      const app = new Hono<{ Variables: { session: { user: { id: string } } } }>();

      app.use("*", async (c, next) => {
        c.set("session", { user: { id: "u-admin" } });
        await next();
      });
      app.route("/api", threadsRoutes());
      const res = await app.request(`/api/attachments/${posted.attachments[0]!.id}`);
      expect(res.headers.get("content-disposition")).toStartWith("attachment;");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");

      const send = (file: File) => {
        const form = new FormData();
        form.append("files", file);
        form.append("after", "1");
        return app.request(`/api/threads/${bot.threadId}/messages`, { method: "POST", body: form });
      };
      const sent = await send(new File(['<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'], "logo.svg", { type: "image/svg+xml" }));
      expect(sent.status).toBe(201);
      const svg = ((await sent.json()) as { message: { attachments: { id: string; mediaType: string }[] } }).message.attachments[0]!;
      expect(svg.mediaType).toBe("image/svg+xml");
      const servedSvg = await app.request(`/api/attachments/${svg.id}`);
      expect(servedSvg.headers.get("content-disposition")).toStartWith("attachment;");
      expect(servedSvg.headers.get("content-security-policy")).toBe("sandbox");
      expect((await send(new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }))).status).toBe(400);
    } finally {
      box.stop(true);
    }
  });

  test("another person's bots keep to their own team, apps, servers and secrets", async () => {
    await seedUsers(["u-admin", "admin"], ["u-other", "user"]);
    const { createBot, listBots } = await import("../src/data/bots.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { getConnection, listConnections, saveConnection } = await import("../src/data/settings.ts");
    const { createMcpServer, deleteMcpServer, mcpProxyToken } = await import("../src/data/mcp.ts");
    const { allSecretValues, injectSecrets, listSecrets, setSecret } = await import("../src/data/secrets.ts");
    const { adoptOrphans } = await import("../src/data/users.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { composioKeySource, executeAction, toolsFor } = await import("../src/composio.ts");
    const { connectionsRoutes } = await import("../src/routes/connections.ts");
    const { mcpProxyRoutes, mcpRoutes } = await import("../src/routes/mcp.ts");
    const { Hono } = await import("hono");
    const { baseTools } = await import("../src/tools.ts");
    const { loadTeamMemory } = await import("../src/transcript.ts");
    const { promptFor } = await import("../src/responder.ts");
    const { systemPromptFor } = await import("../src/souls.ts");
    const { boxMcpServers } = await import("../src/mcp.ts");
    const { botInputSchema } = await import("@gond/shared");
    const read: string[] = [];
    const box = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const path = new URL(request.url).searchParams.get("path") ?? "";
        read.push(path);
        if (path === ".team/MEMORY.md") return Response.json({ content: "Dylan is the founder." });
        return Response.json({ error: "No such file" }, { status: 404 });
      },
    });
    try {
      const config = { url: `http://127.0.0.1:${box.port}`, token: "t", user: "u-admin" };

      expect(await loadTeamMemory(config, "u-admin")).toBe("Dylan is the founder.");
      expect(await loadTeamMemory(config, "u-other")).toBeNull();
      expect(read).toContain(".team/u-other/MEMORY.md");

      saveConnection("u-admin", { toolkit: "gmail", name: "Gmail", accountId: "acc-admin", status: "active" });
      const comet = createBot(botInputSchema.parse({ name: "Comet" }), "u-other");
      expect(listConnections("u-other")).toEqual([]);
      expect(await toolsFor("u-other")).toEqual([]);
      await expect(executeAction("u-other", "GMAIL_SEND_EMAIL", {}, "gmail")).rejects.toThrow();
      const thread = getThread(comet.threadId)!;
      const system = systemPromptFor(comet, { bots: listBots({ includeHidden: true, userId: "u-other" }), thread, memory: null, memoryTruncated: false, teamMemory: null, connections: listConnections("u-other"), toolNotes: "", timezone: "UTC", skillsIndex: "", mcpServers: [] });
      expect(system.startsWith("## What you are\nYou are a personal assistant, not a coding agent.")).toBe(true);
      expect(system).toContain("Nobody else yet");
      expect(system).toContain("~/.team/u-other/MEMORY.md");
      expect(system).not.toContain("Dylan");
      expect(system).toContain("None connected to you yet");
      expect(system).not.toContain("- Gmail");
      const withNotion = systemPromptFor(comet, { bots: [], thread, memory: null, memoryTruncated: false, teamMemory: null, connections: [{ toolkit: "notion", name: "Notion", accountId: "acc-n", status: "active" }] as never, toolNotes: "", timezone: "UTC", skillsIndex: "", mcpServers: [] });
      expect(withNotion).toContain("- Notion: tools named NOTION_…");
      expect(withNotion).toContain("mcp__gond__<NAME>");

      const context = { box: config, bot: comet, thread, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const { secretsRoutes } = await import("../src/routes/secrets.ts");
      const asking = baseTools(context).set_composio_key!.execute({ reason: "to connect your Gmail" }, "c");
      const card = listMessages(thread.id).find((m) => m.kind === "secret" && m.body.startsWith("COMPOSIO_API_KEY"))!;
      expect(card.approvalId).toBeTruthy();
      const secrets = asPerson(new Hono(), "u-other").route("/api", secretsRoutes());
      expect((await secrets.request(`/api/secret-requests/${card.approvalId}`, { method: "POST", body: JSON.stringify({ value: "ak_from_card" }) })).status).toBe(200);
      expect(String(await asking)).toContain("Connected apps are on");
      expect(composioKeySource("u-other")).toBe("own");

      expect(allSecretValues()).toContain("ak_from_card");
      expect(String(await baseTools(context).set_composio_key!.execute({}, "c"))).toContain("already in place");
      const { clearComposioKey } = await import("../src/data/composio-keys.ts");
      clearComposioKey("u-other");
      const previous = process.env.COMPOSIO_API_KEY;
      process.env.COMPOSIO_API_KEY = "server-key";
      try {
        expect(composioKeySource("u-admin")).toBe("server");
        expect(composioKeySource("u-other")).toBeNull();
        const other = asPerson(new Hono(), "u-other").route("/api", connectionsRoutes());
        const saved = await other.request("/api/composio", { method: "PUT", body: JSON.stringify({ apiKey: "ak_other_123" }) });
        expect(await saved.json()).toEqual({ source: "own" });
        expect(await (await other.request("/api/composio")).text()).not.toContain("ak_other_123");
        expect(composioKeySource("u-other")).toBe("own");
        expect(composioKeySource("u-admin")).toBe("server");
        expect(allSecretValues()).toContain("ak_other_123");
        expect((await other.request("/api/composio", { method: "DELETE" })).status).toBe(200);
        expect(composioKeySource("u-other")).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.COMPOSIO_API_KEY;
        else process.env.COMPOSIO_API_KEY = previous;
      }

      setSecret("u-admin", "TOKEN", "admin-token-value");
      const missing: string[] = [];
      expect(injectSecrets("Bearer {{secret:TOKEN}}", "u-other", (name) => missing.push(name))).toBe("Bearer ");
      expect(missing).toEqual(["TOKEN"]);
      expect(injectSecrets("Bearer {{secret:TOKEN}}", "u-admin")).toBe("Bearer admin-token-value");
      expect(listSecrets("u-other")).toEqual([]);
      const adminServer = createMcpServer({ name: "private", transport: "http", url: "https://admin.example/mcp", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      const theirs = createMcpServer({ name: "private", transport: "http", url: "https://other.example/mcp", headers: { Authorization: "{{secret:TOKEN}}" }, args: [], env: {}, enabled: true }, "u-other");

      expect(boxMcpServers({ userId: "u-other" }).map((m) => m.name)).toEqual(["private"]);
      expect(boxMcpServers({ userId: "u-admin" }).map((m) => m.name)).toContain("private");
      const routes = asPerson(new Hono(), "u-other").route("/api", mcpRoutes());
      const listed = (await (await routes.request("/api/mcp-servers")).json()) as { servers: { id: string }[] };
      expect(listed.servers.map((m) => m.id)).toEqual([theirs.id]);
      expect((await routes.request(`/api/mcp-servers/${adminServer.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status).toBe(404);
      expect((await routes.request(`/api/mcp-servers/${adminServer.id}`, { method: "DELETE" })).status).toBe(404);

      const proxy = new Hono().route("/api", mcpProxyRoutes());
      const proxied = await proxy.request(`/api/mcp/${theirs.id}/mcp`, { method: "POST", headers: { "x-gond-mcp-token": mcpProxyToken(theirs.id)! }, body: "{}" });
      expect(proxied.status).toBe(424);
      deleteMcpServer(adminServer.id);
      deleteMcpServer(theirs.id);

      ensureDatabase().query("INSERT INTO gond_connections (user_id, toolkit, name, account_id, status, created_at) VALUES (NULL, 'notion', 'Notion', 'acc-old', 'active', '2026-01-01T00:00:00Z')").run();
      adoptOrphans("u-admin");
      expect(getConnection("u-admin", "notion")?.accountId).toBe("acc-old");

      const hello = postMessage({ threadId: comet.threadId, author: "system", kind: "prompt", body: "Greet the person as yourself." });
      const prompt = promptFor(comet, thread, hello, [comet]);
      expect(prompt).toContain("Greet the person as yourself.");
      expect(prompt).not.toContain("system report");
    } finally {
      box.stop(true);
    }
  });
});

describe("connections that keep working", () => {
  test("asking again for a working app keeps it, and a stale row heals before an action fails", async () => {
    const { mock } = await import("bun:test");
    const accounts: { id: string; status: string; toolkit: string }[] = [{ id: "acc-live", status: "ACTIVE", toolkit: "notion" }];
    const executed: string[] = [];
    let linked = 0;
    class FakeComposio {
      connectedAccounts = {
        list: async (query: { statuses?: string[]; toolkitSlugs?: string[] }) => ({ items: accounts.filter((a) => (!query.statuses || query.statuses.includes(a.status)) && (!query.toolkitSlugs || query.toolkitSlugs.includes(a.toolkit))) }),
        get: async (id: string) => accounts.find((a) => a.id === id) ?? { id, status: "INITIATED" },
        link: async () => (linked++, { id: `acc-new-${linked}`, redirectUrl: "https://connect.example/notion" }),
      };
      authConfigs = { list: async () => ({ items: [{ id: "ac-gond", status: "ENABLED" }] }) };
      tools = { execute: async (_slug: string, options: { connectedAccountId: string }) => (executed.push(options.connectedAccountId), { successful: true, data: { ok: true } }) };
    }
    mock.module("@composio/core", () => ({ Composio: FakeComposio }));
    const { setComposioKey } = await import("../src/data/composio-keys.ts");
    const { getConnection, saveConnection } = await import("../src/data/settings.ts");
    const { executeAction, startConnection } = await import("../src/composio.ts");
    setComposioKey("u-heal", "ak_heal_123456");

    saveConnection("u-heal", { toolkit: "notion", name: "Notion", accountId: "acc-live", status: "active" });
    expect(await startConnection("u-heal", "notion")).toEqual({ redirectUrl: null, accountId: "acc-live" });
    expect(linked).toBe(0);
    expect(getConnection("u-heal", "notion")).toMatchObject({ accountId: "acc-live", status: "active" });

    saveConnection("u-heal", { toolkit: "notion", name: "Notion", accountId: "acc-stale", status: "pending" });
    expect(await executeAction("u-heal", "NOTION_SEARCH_NOTION_PAGE", { query: "Homelab" }, "notion")).toEqual({ ok: true });
    expect(executed).toEqual(["acc-live"]);
    expect(getConnection("u-heal", "notion")).toMatchObject({ accountId: "acc-live", status: "active" });

    accounts.length = 0;
    saveConnection("u-heal", { toolkit: "notion", name: "Notion", accountId: "acc-gone", status: "pending" });
    await expect(executeAction("u-heal", "NOTION_SEARCH_NOTION_PAGE", {}, "notion")).rejects.toThrow("Call connect_app");
    expect((await startConnection("u-heal", "notion")).redirectUrl).toBe("https://connect.example/notion");
    expect(linked).toBe(1);
  });

  test("an MCP sign-in renews once for parallel requests, and a refused renewal doesn't sign out a fresh one", async () => {
    const { createMcpServer, deleteMcpServer, getMcpOAuth, getMcpServer, setMcpAuthStatus, setMcpOAuth } = await import("../src/data/mcp.ts");
    const { bearerFor } = await import("../src/mcp-oauth.ts");
    let refreshes = 0;
    const issuer = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        const form = new URLSearchParams(await request.text());
        refreshes += 1;
        // A single-use refresh token: the second spend is refused, as Toad-style servers do.
        if (form.get("refresh_token") !== "rt-1" || refreshes > 1) return Response.json({ error: "invalid_grant" }, { status: 400 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Response.json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
      },
    });
    const server = createMcpServer({ name: "toad", transport: "http", url: "https://toad.example/mcp", headers: {}, args: [], env: {}, enabled: true }, "u-renew");
    try {
      const state = { authorizationEndpoint: "https://toad.example/authorize", tokenEndpoint: `http://127.0.0.1:${issuer.port}/token`, resource: "https://toad.example/mcp", clientId: "c", accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 10_000 };
      setMcpOAuth(server.id, state);
      setMcpAuthStatus(server.id, "signed_in");
      expect(await Promise.all([bearerFor(server.id), bearerFor(server.id), bearerFor(server.id)])).toEqual(["at-2", "at-2", "at-2"]);
      expect(refreshes).toBe(1);
      expect(getMcpServer(server.id)!.authStatus).toBe("signed_in");
      expect(getMcpOAuth(server.id)).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });

      setMcpOAuth(server.id, { ...state, refreshToken: "rt-dead" });
      expect(await bearerFor(server.id)).toBe("at-1");
      expect(getMcpServer(server.id)!.authStatus).toBe("signed_in");

      setMcpOAuth(server.id, { ...state, refreshToken: "rt-dead", expiresAt: Date.now() - 1000 });
      expect(await bearerFor(server.id)).toBeNull();
      expect(getMcpServer(server.id)!.authStatus).toBe("needed");
    } finally {
      issuer.stop(true);
      deleteMcpServer(server.id);
    }
  });
});

describe("steering", () => {
  test("a message to a working bot goes into its turn, unless it's sent after or the turn can't take it", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { createRoom, getThread } = await import("../src/data/threads.ts");
    const { activeTurns, postFromPerson, steerText } = await import("../src/responder.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const waiting = (id: string) => (ensureDatabase().query("SELECT answered_at FROM gond_messages WHERE id = ?").get(id) as { answered_at: string | null }).answered_at === null;
    const bot = createBot(botInputSchema.parse({ name: "Steer Me" }), "u-steer");
    const thread = getThread(bot.threadId)!;

    const idle = await postFromPerson(thread, { body: "start the report" });
    expect(idle.steered).toBe(false);
    expect(waiting(idle.id)).toBe(true);

    const heard: string[] = [];
    let takes = true;
    const turn = { botId: bot.id, threadId: thread.id, userId: "u-steer", messageId: idle.id, route: "person" as const, controller: new AbortController(), startedAt: Date.now(), steer: async (text: string) => (heard.push(text), takes) };
    activeTurns().set(`${bot.id}--${thread.id}`, turn);
    try {
      const steered = await postFromPerson(thread, { body: "use last week's numbers" });
      expect(steered.steered).toBe(true);
      expect(waiting(steered.id)).toBe(false);
      expect(heard).toEqual([steerText("use last week's numbers")]);

      const after = await postFromPerson(thread, { body: "then email it", after: true });
      expect(after.steered).toBe(false);
      expect(waiting(after.id)).toBe(true);
      expect(heard).toHaveLength(1);

      takes = false;
      const missed = await postFromPerson(thread, { body: "and a chart" });
      expect(missed.steered).toBe(false);
      expect(waiting(missed.id)).toBe(true);

      const other = createBot(botInputSchema.parse({ name: "Idle Mate" }), "u-steer");
      const room = createRoom("Steer room", [bot.id, other.id], "u-steer");
      activeTurns().set(`${bot.id}--${room.id}`, { ...turn, threadId: room.id });
      takes = true;
      expect((await postFromPerson(room, { body: "@steer-me shorter please" })).steered).toBe(true);
      expect((await postFromPerson(room, { body: "@everyone shorter please" })).steered).toBe(false);
      activeTurns().delete(`${bot.id}--${room.id}`);

      // A turn answering a teammate's request answers them, so the person's line waits for its own turn.
      activeTurns().set(`${bot.id}--${thread.id}`, { ...turn, route: "teammate" });
      const queued = await postFromPerson(thread, { body: "what's the status?" });
      expect(queued.steered).toBe(false);
      expect(waiting(queued.id)).toBe(true);
      activeTurns().set(`${bot.id}--${thread.id}`, turn);
    } finally {
      activeTurns().delete(`${bot.id}--${thread.id}`);
    }
  });
});

describe("stop", () => {
  test("stopping a conversation stops everything its work set going, down the chain", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { createFollowUp, listFollowUps } = await import("../src/data/follow-ups.ts");
    const { listMessages, postMessage } = await import("../src/data/threads.ts");
    const { stopThread } = await import("../src/responder.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const waiting = (threadId: string) => (ensureDatabase().query("SELECT id FROM gond_messages WHERE thread_id = ? AND answered_at IS NULL").all(threadId) as { id: string }[]).length;
    const primary = createBot(botInputSchema.parse({ name: "Halt Primary" }), "u-halt");
    const researcher = createBot(botInputSchema.parse({ name: "Halt Researcher" }), "u-halt");
    const writer = createBot(botInputSchema.parse({ name: "Halt Writer" }), "u-halt");
    const bystander = createBot(botInputSchema.parse({ name: "Halt Bystander" }), "u-halt");
    const handOver = (from: typeof primary, to: typeof primary, brief: string) => {
      const posted = postMessage({ threadId: to.threadId, author: from.id, body: brief, depth: 1, fromThreadId: from.threadId });
      return createDelegation({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: to.id, toThreadId: to.threadId, messageId: posted.id, brief });
    };

    postMessage({ threadId: primary.threadId, author: "you", body: "then do the slides" });
    postMessage({ threadId: primary.threadId, author: bystander.id, body: "Result: done", fromThreadId: bystander.threadId });
    postMessage({ threadId: primary.threadId, author: "system", kind: "prompt", body: "carry on" });

    const first = handOver(primary, researcher, "Research the market");
    const second = handOver(researcher, writer, "Write it up");
    postMessage({ threadId: bystander.threadId, author: primary.id, body: "FYI, starting on the market", fromThreadId: primary.threadId });
    createFollowUp({ botId: primary.id, threadId: primary.threadId, note: "check on the research", dueAt: new Date(Date.now() + 3_600_000) });

    postMessage({ threadId: bystander.threadId, author: "you", body: "unrelated question" });

    const outcome = await stopThread(primary.threadId);
    expect(outcome).toMatchObject({ stopped: 0, dropped: 3, teammates: ["Halt Researcher", "Halt Writer"], sent: 1, followUps: 1 });
    expect(waiting(primary.threadId)).toBe(0);
    expect(listMessages(primary.threadId).at(-1)!.body).toBe("Stopped. 3 waiting messages were dropped.");

    expect(getDelegation(first.id)?.status).toBe("cancelled");
    expect(getDelegation(second.id)?.status).toBe("cancelled");
    expect(waiting(researcher.threadId)).toBe(0);
    expect(waiting(writer.threadId)).toBe(0);

    expect(waiting(bystander.threadId)).toBe(1);
    expect(listFollowUps(primary.id)).toEqual([]);

    const quiet = listMessages(primary.threadId).length;
    expect(await stopThread(primary.threadId)).toMatchObject({ stopped: 0, dropped: 0, teammates: [] });
    expect(listMessages(primary.threadId)).toHaveLength(quiet);
  });

  test("saying stop in the chat is Stop, and the bot says what it stopped", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { postFromPerson } = await import("../src/responder.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const answered = (id: string) => (ensureDatabase().query("SELECT answered_at FROM gond_messages WHERE id = ?").get(id) as { answered_at: string | null }).answered_at !== null;
    const boss = createBot(botInputSchema.parse({ name: "Word Boss" }), "u-word");
    const helper = createBot(botInputSchema.parse({ name: "Word Helper" }), "u-word");
    const thread = getThread(boss.threadId)!;

    const idle = await postFromPerson(thread, { body: "stop" });
    expect(answered(idle.id)).toBe(false);
    const { closePending } = await import("../src/data/threads.ts");
    closePending(thread.id);

    const brief = postMessage({ threadId: helper.threadId, author: boss.id, body: "Find flights", depth: 1, fromThreadId: thread.id });
    const handoff = createDelegation({ fromBotId: boss.id, fromThreadId: thread.id, toBotId: helper.id, toThreadId: helper.threadId, messageId: brief.id, brief: "Find flights" });

    const sent = await postFromPerson(thread, { body: "Cancel that." });
    expect(answered(sent.id)).toBe(true);
    expect(getDelegation(handoff.id)?.status).toBe("cancelled");
    const reply = listMessages(thread.id).at(-1)!;
    expect(reply.author).toBe(boss.id);
    expect(reply.body).toContain("I called off what I handed to Word Helper.");
    expect(reply.body).toContain("I won't pick it back up unless you ask.");
    expect(listMessages(thread.id).some((m) => m.kind === "event" && m.body.startsWith("Stopped."))).toBe(false);

    const order = await postFromPerson(thread, { body: "cancel the order" });
    expect(answered(order.id)).toBe(false);
  });

  test("a routine run with nothing new leaves no trace, and one with news is posted", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { createRoutine, recordRoutineRun } = await import("../src/data/routines.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { botTurn } = await import("../src/responder.ts");

    let answer = "NOTHING_NEW";
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        if (!new URL(request.url).pathname.endsWith("/turn")) return Response.json({});
        await request.json();
        return new Response(`data: ${JSON.stringify({ type: "result", ok: true, text: answer, stopReason: null, recovered: false })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const bot = createBot(botInputSchema.parse({ name: "Quiet Bot" }), "u-quiet");
      const thread = getThread(bot.threadId)!;
      const routine = createRoutine(bot.id, { name: "Inbox", cron: "0 9 * * *", timezone: "UTC", prompt: "Check the inbox.", enabled: true, skillId: null });
      const runs = () => ensureDatabase().query("SELECT status FROM gond_routine_runs WHERE routine_id = ? ORDER BY started_at").all(routine.id) as { status: string }[];

      const quiet = postMessage({ threadId: thread.id, author: "routine", body: "[Routine: Inbox] Check the inbox." });
      recordRoutineRun(routine.id, quiet.id);
      expect(await botTurn(bot, thread, quiet)).toBe("");
      expect(listMessages(thread.id).some((m) => m.id === quiet.id || m.author === bot.id)).toBe(false);
      expect(runs()).toEqual([{ status: "done" }]);

      answer = "Two new emails from the bank.";
      const loud = postMessage({ threadId: thread.id, author: "routine", body: "[Routine: Inbox] Check the inbox." });
      recordRoutineRun(routine.id, loud.id);
      await botTurn(bot, thread, loud);
      expect(listMessages(thread.id).map((m) => m.body)).toEqual(["[Routine: Inbox] Check the inbox.", "Two new emails from the bank."]);

      answer = "NOTHING_NEW";
      const asked = postMessage({ threadId: thread.id, author: "you", body: "Anything?" });
      await botTurn(bot, thread, asked);
      // The quiet word is never posted, whoever woke the bot.
      expect(listMessages(thread.id).at(-1)!.id).toBe(asked.id);
      expect(listMessages(thread.id).some((m) => m.body === "NOTHING_NEW")).toBe(false);
    } finally {
      fake.stop(true);
      process.env.GOND_BOX_URL = boxUrl;
      process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("a reply carries a quote of the message it answers, and the bot reads it", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getMessage, postMessage, dropMessage } = await import("../src/data/threads.ts");
    const { transcriptLines } = await import("../src/transcript.ts");
    const { threadsRoutes } = await import("../src/routes/threads.ts");
    const { Hono } = await import("hono");
    const bot = createBot(botInputSchema.parse({ name: "Quoted" }), "u-quote");
    const other = createBot(botInputSchema.parse({ name: "Elsewhere" }), "u-quote");
    const said = postMessage({ threadId: bot.threadId, author: bot.id, body: "**Want me** to also check the backups on the NAS?", answered: true });
    const app = asPerson(new Hono(), "u-quote").route("/api", threadsRoutes());
    const post = (threadId: string, body: Record<string, unknown>) => app.request(`/api/threads/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const res = await post(bot.threadId, { body: "Yes, and tonight", replyTo: said.id, after: true });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as { message: { id: string; replyTo: unknown } };
    expect(message.replyTo).toEqual({ id: said.id, author: bot.id, text: "Want me to also check the backups on the NAS?" });
    expect(transcriptLines([getMessage(message.id)!], [bot], bot)).toBe('Person: (replying to Quoted (you): "Want me to also check the backups on the NAS?") Yes, and tonight');

    const away = postMessage({ threadId: other.threadId, author: other.id, body: "Elsewhere", answered: true });
    expect((await post(bot.threadId, { body: "x", replyTo: away.id })).status).toBe(400);
    dropMessage(said.id);
    expect(getMessage(message.id)!.replyTo).toBeNull();
  });

  test("a reaction is one per author, shows in the transcript, and can be the whole answer", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getMessage, getThread, listMessages, postMessage, setReaction } = await import("../src/data/threads.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { transcriptLines } = await import("../src/transcript.ts");
    const { botTurn } = await import("../src/responder.ts");

    const bot = createBot(botInputSchema.parse({ name: "Thumbs Bot" }), "u-react");
    const thread = getThread(bot.threadId)!;
    const reply = postMessage({ threadId: thread.id, author: bot.id, body: "Your table is booked.", answered: true });
    setReaction(reply, "you", "❤️");
    setReaction(reply, "you", "👍");
    expect(getMessage(reply.id)!.reactions).toEqual([{ author: "you", emoji: "👍" }]);
    expect(transcriptLines([getMessage(reply.id)!], [bot], bot)).toBe("Thumbs Bot (you): Your table is booked. [reactions: Person 👍]");
    setReaction(reply, "you", null);
    expect(getMessage(reply.id)!.reactions).toEqual([]);

    const routine = postMessage({ threadId: thread.id, author: "routine", body: "[Routine: Inbox] Check the inbox." });
    const tools = (message: typeof routine) => baseTools({ bot, thread, message } as unknown as Parameters<typeof baseTools>[0]);
    expect(String(await tools(routine).react!.execute({ emoji: "👍" }, "c"))).toStartWith("NOT reacted");
    const thanks = postMessage({ threadId: thread.id, author: "you", body: "thank you!" });
    expect(String(await tools(thanks).react!.execute({ emoji: "🎉" }, "c"))).toStartWith("NOT reacted");
    expect(String(await tools(thanks).react!.execute({ emoji: "👍" }, "c"))).toBe("Reacted.");
    expect(getMessage(thanks.id)!.reactions).toEqual([{ author: bot.id, emoji: "👍" }]);

    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        if (!new URL(request.url).pathname.endsWith("/turn")) return Response.json({});
        await request.json();
        const asked = listMessages(thread.id).findLast((m) => m.author === "you")!;
        if (asked.body === "that will be all") setReaction(asked, bot.id, "❤️");
        return new Response(`data: ${JSON.stringify({ type: "result", ok: true, text: "NOTHING_NEW", stopReason: null, recovered: false })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const bye = postMessage({ threadId: thread.id, author: "you", body: "that will be all" });
      expect(await botTurn(bot, thread, bye)).toBe("");
      expect(listMessages(thread.id).at(-1)!.id).toBe(bye.id);
      expect(getMessage(bye.id)!.reactions).toEqual([{ author: bot.id, emoji: "❤️" }]);

      const unreacted = postMessage({ threadId: thread.id, author: "you", body: "Anything?" });
      await botTurn(bot, thread, unreacted);
      expect(listMessages(thread.id).at(-1)!.id).toBe(unreacted.id);
    } finally {
      fake.stop(true);
      process.env.GOND_BOX_URL = boxUrl;
      process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("a resumed session gets only what's new, and older messages fold into a summary", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getThread, postMessage } = await import("../src/data/threads.ts");
    const { botTurn, seenBy } = await import("../src/responder.ts");
    const { getSummary } = await import("../src/data/summaries.ts");
    const { summarizeThread, SUMMARY_BATCH } = await import("../src/summaries.ts");
    const { boxConfig } = await import("../src/box.ts");
    const { engineRun } = await import("../src/engines.ts");
    const { getAi } = await import("../src/data/ai.ts");

    const turns: { path: string; prompt: string; followUp?: string }[] = [];
    const deleted: string[] = [];
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (request.method === "DELETE") deleted.push(path);
        if (!path.endsWith("/turn")) return Response.json({});
        const body = (await request.json()) as { prompt: string; followUp?: string };
        turns.push({ path, prompt: body.prompt, followUp: body.followUp });
        const text = path.includes("--sum-") ? "- Decisions: the person wants Sonic on Fridays" : `Reply ${turns.length}`;
        return new Response(`data: ${JSON.stringify({ type: "result", ok: true, text, stopReason: null, recovered: false })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const bot = createBot(botInputSchema.parse({ name: "Recall Bot" }), "u-recall");
      const thread = getThread(bot.threadId)!;
      const first = postMessage({ threadId: thread.id, author: "you", body: "Remember the order" });
      await botTurn(bot, thread, first);
      expect(turns[0]!.followUp).toBeUndefined();
      expect(seenBy().get(`${bot.id}--${thread.id}`)).toBe(first.createdAt);

      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = postMessage({ threadId: thread.id, author: "you", body: "And the drink" });
      await botTurn(bot, thread, second);
      const resumed = turns[1]!;
      expect(resumed.prompt).toContain("Remember the order");
      expect(resumed.followUp).toContain("New in the conversation since your last turn");
      expect(resumed.followUp).toContain("And the drink");
      expect(resumed.followUp).not.toContain("Remember the order");
      expect(resumed.followUp).not.toContain("Reply 1");

      for (let i = 0; i < SUMMARY_BATCH + 30; i += 1) postMessage({ threadId: thread.id, author: i % 2 ? bot.id : "you", body: `line ${i}`, answered: true });
      const run = engineRun(getAi("u-recall"), "u-recall");
      expect(await summarizeThread({ box: boxConfig("u-recall"), bot, thread, bots: [bot], run, window: 30 })).toBe(true);
      const summary = getSummary(thread.id)!;
      expect(summary.summary).toBe("- Decisions: the person wants Sonic on Fridays");
      const summarizing = turns.at(-1)!;
      expect(summarizing.path).toContain("--sum-");
      expect(summarizing.prompt).toContain("Remember the order");
      expect(summarizing.prompt).not.toContain(`line ${SUMMARY_BATCH + 29}`);
      expect(deleted.some((path) => path.includes("--sum-"))).toBe(true);
      expect(await summarizeThread({ box: boxConfig("u-recall"), bot, thread, bots: [bot], run, window: 30 })).toBe(false);

      seenBy().delete(`${bot.id}--${thread.id}`);
      const third = postMessage({ threadId: thread.id, author: "you", body: "What did we decide?" });
      await botTurn(bot, thread, third);
      expect(turns.at(-1)!.prompt).toContain("Earlier in this conversation, summarized");
      expect(turns.at(-1)!.prompt).toContain("Sonic on Fridays");
    } finally {
      fake.stop(true);
      process.env.GOND_BOX_URL = boxUrl;
      process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("a CLI turn stopped mid-stream is a stop, not a crash: no incident, and the primary bot isn't woken", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { activeTurns, botTurn, stopThread } = await import("../src/responder.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const waiting = (threadId: string) => (ensureDatabase().query("SELECT id FROM gond_messages WHERE thread_id = ? AND answered_at IS NULL").all(threadId) as { id: string }[]).length;

    let turnOpened: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (turnOpened = resolve));
    const fake = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        if (!new URL(request.url).pathname.endsWith("/turn")) return Response.json({});
        turnOpened();
        const body = new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": connected\n\n")) });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const primary = createBot(botInputSchema.parse({ name: "Stream Primary" }), "u-stream");
      const worker = createBot(botInputSchema.parse({ name: "Stream Worker" }), "u-stream");
      const brief = postMessage({ threadId: worker.threadId, author: primary.id, body: "Tidy the folder", depth: 1, fromThreadId: primary.threadId });
      const handoff = createDelegation({ fromBotId: primary.id, fromThreadId: primary.threadId, toBotId: worker.id, toThreadId: worker.threadId, messageId: brief.id, brief: "Tidy the folder" });

      const turn = botTurn(worker, getThread(worker.threadId)!, brief);
      await opened;
      expect([...activeTurns().values()].some((t) => t.botId === worker.id)).toBe(true);
      expect((await stopThread(worker.threadId)).stopped).toBe(1);
      await turn;

      const said = listMessages(worker.threadId).map((m) => m.body);
      expect(said).toContain("Stream Worker was stopped.");
      expect(said.some((body) => body.includes("hit a problem"))).toBe(false);
      expect(getDelegation(handoff.id)?.status).toBe("cancelled");

      expect(listMessages(primary.threadId).some((m) => m.body.startsWith("Incident"))).toBe(false);
      expect(waiting(primary.threadId)).toBe(0);
    } finally {
      fake.stop(true);
      if (boxUrl === undefined) delete process.env.GOND_BOX_URL;
      else process.env.GOND_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.GOND_BOX_TOKEN;
      else process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("an approval closes when the turn waiting on it is stopped", async () => {
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getApproval } = await import("../src/data/approvals.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { requestApproval, decide } = await import("../src/approvals.ts");
    const bot = createBot(botInputSchema.parse({ name: "Halt Asker" }), "u-halt");
    updateBot(bot.id, { approval: "ask" });
    const turn = new AbortController();
    const pending = requestApproval({ bot: { ...bot, approval: "ask" }, threadId: bot.threadId, tool: "Bash", input: { command: "rm -rf build" }, signal: turn.signal });
    const card = listMessages(bot.threadId).at(-1)!;
    expect(card.kind).toBe("approval");
    turn.abort("stopped");
    expect(await pending).toBe("expired");
    expect(getApproval(card.approvalId!)?.status).toBe("expired");

    expect(decide(card.approvalId!, { decision: "allow" })?.status).toBe("expired");
  });
});

describe("handoffs", () => {
  test("a handoff the person stopped closes quietly; one that failed wakes the bot that handed it over", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { listMessages, postMessage } = await import("../src/data/threads.ts");
    const { reportBack } = await import("../src/responder.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const waiting = (threadId: string) => (ensureDatabase().query("SELECT id FROM gond_messages WHERE thread_id = ? AND answered_at IS NULL").all(threadId) as { id: string }[]).map((r) => r.id);
    const primary = createBot(botInputSchema.parse({ name: "Stop Primary" }), "u-stop");
    const worker = createBot(botInputSchema.parse({ name: "Stop Worker" }), "u-stop");
    const handOver = (brief: string) => {
      const posted = postMessage({ threadId: worker.threadId, author: primary.id, body: brief, depth: 1, fromThreadId: primary.threadId });
      return { posted, handoff: createDelegation({ fromBotId: primary.id, fromThreadId: primary.threadId, toBotId: worker.id, toThreadId: worker.threadId, messageId: posted.id, brief }) };
    };

    const stopped = handOver("Tidy the folder");
    await reportBack(worker, stopped.posted, "", true);
    expect(getDelegation(stopped.handoff.id)).toMatchObject({ status: "cancelled", result: "Stopped by the person." });
    const note = listMessages(primary.threadId).at(-1)!;
    expect(note).toMatchObject({ author: "system", kind: "event" });
    expect(note.body).toContain("stopped by the person");

    expect(waiting(primary.threadId)).toEqual([]);

    const failed = handOver("Tidy the other folder");
    await reportBack(worker, failed.posted, "", false);
    expect(getDelegation(failed.handoff.id)?.status).toBe("failed");
    const result = listMessages(primary.threadId).at(-1)!;
    expect(result.author).toBe(worker.id);
    expect(waiting(primary.threadId)).toEqual([result.id]);
  });
  test("a teammate that hands part of its task on reports once the last result is in, a hop up", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { reportBack } = await import("../src/responder.ts");
    const { teamTools } = await import("../src/tools.ts");
    const primary = createBot(botInputSchema.parse({ name: "Chain Primary" }), "u-chain");
    const lead = createBot(botInputSchema.parse({ name: "Chain Lead" }), "u-chain");
    const coder = createBot(botInputSchema.parse({ name: "Chain Coder" }), "u-chain");
    const tester = createBot(botInputSchema.parse({ name: "Chain Tester" }), "u-chain");
    const tools = (bot: typeof primary, message: Parameters<typeof reportBack>[1]) =>
      teamTools({
        box: { url: "http://box.invalid", token: "t", user: "u-chain" },
        bot,
        thread: getThread(bot.threadId)!,
        message,
        askBot: async () => "",
        syncSoul: async () => undefined,
        stopWork: async () => false,
        isWorking: () => false,
      });
    const delegate = async (from: typeof primary, message: Parameters<typeof reportBack>[1], to: typeof primary, brief: string) => {
      const sent = String(await tools(from, message).delegate_bot!.execute({ bot: to.name, brief }, "c"));
      return getDelegation(/handoff (d[^)\s]+)/.exec(sent)![1]!)!;
    };
    const briefOf = (id: string) => listMessages(getDelegation(id)!.toThreadId).find((m) => m.id === getDelegation(id)!.messageId)!;
    const last = (threadId: string) => listMessages(threadId).at(-1)!;

    const asked = postMessage({ threadId: primary.threadId, author: "you", body: "Ship the feature" });
    const toLead = await delegate(primary, asked, lead, "Ship the feature");

    const toCoder = await delegate(lead, briefOf(toLead.id), coder, "Write it");
    const toTester = await delegate(lead, briefOf(toLead.id), tester, "Test it");
    expect(toCoder.parentId).toBe(toLead.id);
    expect(briefOf(toCoder.id).depth).toBe(2);
    await reportBack(lead, briefOf(toLead.id), "Handed to the coder and the tester.", false);
    expect(getDelegation(toLead.id)!.status).toBe("open");

    await reportBack(coder, briefOf(toCoder.id), "Written.", false);
    const coderResult = last(lead.threadId);
    expect(coderResult.depth).toBe(1);

    const toFixer = await delegate(lead, coderResult, coder, "Fix the edge case");
    expect(toFixer.parentId).toBe(toLead.id);
    expect(briefOf(toFixer.id).depth).toBe(2);
    await reportBack(lead, coderResult, "Waiting on the tester and the fix.", false);
    await reportBack(tester, briefOf(toTester.id), "Passes.", false);
    await reportBack(lead, last(lead.threadId), "Tests pass; waiting on the fix.", false);
    expect(getDelegation(toLead.id)!.status).toBe("open");

    await reportBack(coder, briefOf(toFixer.id), "Fixed.", false);
    await reportBack(lead, last(lead.threadId), "Shipped: written, fixed and tested.", false);
    expect(getDelegation(toLead.id)).toMatchObject({ status: "done", result: "Shipped: written, fixed and tested." });
    const result = last(primary.threadId);
    expect(result).toMatchObject({ author: lead.id, depth: 0 });
    expect(result.body).toContain("Shipped");

    expect((await delegate(primary, result, lead, "Now the docs")).status).toBe("open");
  });

  test("a reply to a teammate goes back into the exchange, not the person's chat, and only a result for the bot that handed it out is for the person", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { createDelegation, finishDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { answerGoesTo, deliverReply, promptFor } = await import("../src/responder.ts");

    const clo = createBot(botInputSchema.parse({ name: "Exchange Clo" }), "u-exchange");
    const jeff = createBot(botInputSchema.parse({ name: "Exchange Jeff" }), "u-exchange");
    const jeffThread = getThread(jeff.threadId)!;
    const cloThread = getThread(clo.threadId)!;

    const hello = postMessage({ threadId: jeff.threadId, author: clo.id, body: "Hi Jeff, what's your job?", depth: 1, fromThreadId: clo.threadId });
    expect(answerGoesTo(hello)).toBe("teammate");
    expect(promptFor(jeff, jeffThread, hello, [clo, jeff])).toContain("your answer goes back to them, not to the person");
    deliverReply(jeff, jeffThread, hello, "Hi Clo, I'm the generalist.");
    expect(listMessages(jeff.threadId).some((m) => m.author === jeff.id)).toBe(false);
    const back = listMessages(clo.threadId).at(-1)!;
    expect(back).toMatchObject({ author: jeff.id, body: "Hi Clo, I'm the generalist.", fromThreadId: jeff.threadId, depth: 2 });
    const { ensureDatabase } = await import("../src/db/init.ts");
    expect((ensureDatabase().query("SELECT answered_at FROM gond_messages WHERE id = ?").get(back.id) as { answered_at: string | null }).answered_at).not.toBeNull();

    const brief = postMessage({ threadId: jeff.threadId, author: clo.id, body: "Write the report", depth: 1, fromThreadId: clo.threadId });
    const handoff = createDelegation({ fromBotId: clo.id, fromThreadId: clo.threadId, toBotId: jeff.id, toThreadId: jeff.threadId, messageId: brief.id, brief: "Write the report" });
    const before = listMessages(clo.threadId).length;
    expect(answerGoesTo(brief)).toBe("chain");
    deliverReply(jeff, jeffThread, brief, "Here's the report.");
    expect(listMessages(jeff.threadId).some((m) => m.body === "Here's the report.")).toBe(false);
    expect(listMessages(clo.threadId).length).toBe(before);

    const result = postMessage({ threadId: clo.threadId, author: jeff.id, body: "Result for the task you handed me:\n\nHere's the report.", fromThreadId: jeff.threadId });
    finishDelegation(handoff.id, "done", "Here's the report.", result.id);
    // The result is for the person, and the prompt says so, so the bot never thanks Jeff in their chat.
    expect(answerGoesTo(result)).toBe("person");
    const told = promptFor(clo, cloThread, result, [clo, jeff]);
    expect(told).toContain("This is the result of the task you handed Exchange Jeff. Your answer goes to the person");
    expect(told).toContain("Don't thank or address Exchange Jeff");
    expect(told).not.toContain("goes back to them");
    deliverReply(clo, cloThread, result, "Jeff finished the report: here it is.");
    expect(listMessages(clo.threadId).at(-1)).toMatchObject({ author: clo.id, body: "Jeff finished the report: here it is.", fromThreadId: null });

    const asked = postMessage({ threadId: clo.threadId, author: "you", body: "Hi" });
    expect(answerGoesTo(asked)).toBe("person");
    deliverReply(clo, cloThread, asked, "Hello.");
    expect(listMessages(clo.threadId).at(-1)).toMatchObject({ author: clo.id, body: "Hello.", fromThreadId: null });

    // Gond's own report and a hidden prompt answer the person, and hear that teammates' lines here were answered already.
    const incident = postMessage({ threadId: clo.threadId, author: "system", body: "Incident: a run stopped.", fromThreadId: jeff.threadId });
    expect(answerGoesTo(incident)).toBe("person");
    const report = promptFor(clo, cloThread, incident, [clo, jeff]);
    expect(report).not.toContain("This message came from");
    expect(report).toContain("Your answer goes to the person only");
    const nudge = postMessage({ threadId: clo.threadId, author: "system", kind: "prompt", body: "Carry on." });
    expect(promptFor(clo, cloThread, nudge, [clo, jeff])).toContain("Exchange Jeff wrote here as a teammate and was answered already");
  });

  test("a teammate whose run keeps breaking reports each time as a failed result, and the carry-on briefs never run out of hops", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { botTurn } = await import("../src/responder.ts");
    const { teamTools } = await import("../src/tools.ts");

    const fake = Bun.serve({
      port: 0,
      fetch: (request: Request) => (new URL(request.url).pathname.endsWith("/turn") ? new Response("timed out", { status: 500 }) : Response.json(new URL(request.url).pathname === "/health" ? { ok: true, agents: 0 } : {})),
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const primary = createBot(botInputSchema.parse({ name: "Carry Primary" }), "u-carry");
      const worker = createBot(botInputSchema.parse({ name: "Carry Worker" }), "u-carry");
      let answering = postMessage({ threadId: primary.threadId, author: "you", body: "Run the long job" });
      for (let round = 0; round < 6; round += 1) {
        const sent = String(
          await teamTools({
            box: { url: "http://box.invalid", token: "t", user: "u-carry" },
            bot: primary,
            thread: getThread(primary.threadId)!,
            message: answering,
            askBot: async () => "",
            syncSoul: async () => undefined,
            stopWork: async () => false,
            isWorking: () => false,
          }).delegate_bot!.execute({ bot: worker.name, brief: "Carry on with the long job" }, "c"),
        );
        expect(sent).toContain("Assigned");
        const handoff = getDelegation(/handoff (d[^)\s]+)/.exec(sent)![1]!)!;
        const brief = listMessages(worker.threadId).find((m) => m.id === handoff.messageId)!;
        await botTurn(worker, getThread(worker.threadId)!, brief);
        expect(getDelegation(handoff.id)!.status).toBe("failed");

        answering = listMessages(primary.threadId).at(-1)!;
        expect(answering).toMatchObject({ author: worker.id, depth: 0 });
        expect(answering.body).toContain("my run stopped with");
        expect(listMessages(primary.threadId).some((m) => m.body.startsWith("Incident"))).toBe(false);
      }
    } finally {
      fake.stop(true);
      process.env.GOND_BOX_URL = boxUrl;
      process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("stopping a teammate that waits on its own handoffs closes its handoff too", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { markAnswered, postMessage } = await import("../src/data/threads.ts");
    const { stopThread } = await import("../src/responder.ts");
    const primary = createBot(botInputSchema.parse({ name: "Wait Primary" }), "u-wait");
    const lead = createBot(botInputSchema.parse({ name: "Wait Lead" }), "u-wait");
    const helper = createBot(botInputSchema.parse({ name: "Wait Helper" }), "u-wait");
    const brief = postMessage({ threadId: lead.threadId, author: primary.id, body: "Do it", depth: 1, fromThreadId: primary.threadId });
    markAnswered(brief.id);
    const parent = createDelegation({ fromBotId: primary.id, fromThreadId: primary.threadId, toBotId: lead.id, toThreadId: lead.threadId, messageId: brief.id, brief: "Do it" });
    const inner = postMessage({ threadId: helper.threadId, author: lead.id, body: "Half of it", depth: 2, fromThreadId: lead.threadId });
    const child = createDelegation({ fromBotId: lead.id, fromThreadId: lead.threadId, toBotId: helper.id, toThreadId: helper.threadId, messageId: inner.id, brief: "Half of it", parentId: parent.id });
    await stopThread(lead.threadId);
    expect(getDelegation(child.id)!.status).toBe("cancelled");
    expect(getDelegation(parent.id)).toMatchObject({ status: "cancelled", result: "Stopped by the person." });
  });
});

describe("the primary bot", () => {
  test("the first bot is primary, and hiding or deleting it hands the role on", async () => {
    const { createBot, deleteBot, getPrimary, listBots, updateBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const first = createBot(botInputSchema.parse({ name: "First" }), "u-primary");
    expect(first.primary).toBe(true);
    const second = createBot(botInputSchema.parse({ name: "Second" }), "u-primary");
    const third = createBot(botInputSchema.parse({ name: "Third" }), "u-primary");
    expect(second.primary).toBe(false);
    expect(listBots({ userId: "u-primary" }).filter((b) => b.primary).map((b) => b.id)).toEqual([first.id]);

    updateBot(first.id, { hidden: true });
    expect(getPrimary("u-primary")?.id).toBe(second.id);
    expect(listBots({ userId: "u-primary", includeHidden: true }).filter((b) => b.primary).map((b) => b.id)).toEqual([second.id]);
    updateBot(first.id, { hidden: false });
    expect(getPrimary("u-primary")?.id).toBe(second.id);

    deleteBot(second.id);
    expect(getPrimary("u-primary")?.id).toBe(first.id);
    deleteBot(first.id);
    expect(getPrimary("u-primary")?.id).toBe(third.id);
  });

  test("setPrimary is exclusive and refuses hidden bots and other people's", async () => {
    const { createBot, getPrimary, listBots, setPrimary, updateBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const a = createBot(botInputSchema.parse({ name: "A" }), "u-transfer");
    const b = createBot(botInputSchema.parse({ name: "B" }), "u-transfer");
    const hidden = createBot(botInputSchema.parse({ name: "Hidden" }), "u-transfer");
    updateBot(hidden.id, { hidden: true });
    const theirs = createBot(botInputSchema.parse({ name: "Theirs" }), "u-transfer-other");

    expect(setPrimary("u-transfer", b.id)?.primary).toBe(true);
    expect(listBots({ userId: "u-transfer", includeHidden: true }).filter((bot) => bot.primary).map((bot) => bot.id)).toEqual([b.id]);
    expect(setPrimary("u-transfer", hidden.id)).toBeNull();
    expect(setPrimary("u-transfer", theirs.id)).toBeNull();
    expect(getPrimary("u-transfer")?.id).toBe(b.id);
    expect(getPrimary("u-transfer-other")?.id).toBe(theirs.id);
    expect(setPrimary("u-transfer", a.id)?.id).toBe(a.id);
    expect(getPrimary("u-transfer")?.id).toBe(a.id);
  });

  test("the route transfers it, answers 404 for another person's bot, and a PATCH can't set it", async () => {
    const { Hono } = await import("hono");
    const { botsRoutes } = await import("../src/routes/bots.ts");
    const { createBot, getPrimary, updateBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const a = createBot(botInputSchema.parse({ name: "Route A" }), "u-route");
    const b = createBot(botInputSchema.parse({ name: "Route B" }), "u-route");
    const hidden = createBot(botInputSchema.parse({ name: "Route Hidden" }), "u-route");
    updateBot(hidden.id, { hidden: true });
    const theirs = createBot(botInputSchema.parse({ name: "Route Theirs" }), "u-route-other");
    const app = asPerson(new Hono(), "u-route").route("/api", botsRoutes());

    const moved = await app.request(`/api/bots/${b.id}/primary`, { method: "POST" });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { bot: { primary: boolean } }).bot.primary).toBe(true);
    expect(getPrimary("u-route")?.id).toBe(b.id);
    expect((await app.request(`/api/bots/${theirs.id}/primary`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`/api/bots/${hidden.id}/primary`, { method: "POST" })).status).toBe(400);

    const patched = await app.request(`/api/bots/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ primary: true, isPrimary: true }) });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { bot: { primary: boolean } }).bot.primary).toBe(false);
    expect(getPrimary("u-route")?.id).toBe(b.id);
  });

  test("a broken run reaches the primary bot", async () => {
    const { createBot, setPrimary } = await import("../src/data/bots.ts");
    const { postMessage, getThread, listMessages } = await import("../src/data/threads.ts");
    const { botTurn } = await import("../src/responder.ts");
    const { botInputSchema } = await import("@gond/shared");
    const fake = Bun.serve({
      port: 0,
      fetch: (request: Request) => (new URL(request.url).pathname.endsWith("/turn") ? new Response("timed out", { status: 500 }) : Response.json(new URL(request.url).pathname === "/health" ? { ok: true, agents: 0 } : {})),
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const first = createBot(botInputSchema.parse({ name: "Incident First" }), "u-incident");
      const primary = createBot(botInputSchema.parse({ name: "Incident Primary" }), "u-incident");
      const worker = createBot(botInputSchema.parse({ name: "Incident Worker" }), "u-incident");
      setPrimary("u-incident", primary.id);
      const asked = postMessage({ threadId: worker.threadId, author: "you", body: "Do the thing" });
      await botTurn(worker, getThread(worker.threadId)!, asked);
      expect(listMessages(primary.threadId).some((m) => m.body.startsWith("Incident: Incident Worker"))).toBe(true);
      expect(listMessages(first.threadId).some((m) => m.body.startsWith("Incident"))).toBe(false);
    } finally {
      fake.stop(true);
      process.env.GOND_BOX_URL = boxUrl;
      process.env.GOND_BOX_TOKEN = boxToken;
    }
  });
});

describe("rooms a bot opens", () => {
  test("create_room opens a room of the bot's own teammates, and its first line wakes them", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { botLinesSincePerson, claimPendingMessages, getThread, listMessages, postMessage, releaseClaim } = await import("../src/data/threads.ts");
    const { teamTools } = await import("../src/tools.ts");
    const primary = createBot(botInputSchema.parse({ name: "Room Primary" }), "u-room");
    const sound = createBot(botInputSchema.parse({ name: "Room Sound" }), "u-room");
    const art = createBot(botInputSchema.parse({ name: "Room Art" }), "u-room");
    const stranger = createBot(botInputSchema.parse({ name: "Room Stranger" }), "u-room-other");
    const asked = postMessage({ threadId: primary.threadId, author: "you", body: "Get sound and art talking" });
    const tools = teamTools({ bot: primary, thread: getThread(primary.threadId)!, message: asked, stopWork: async () => false, isWorking: () => false } as unknown as Parameters<typeof teamTools>[0]);

    expect(await tools.create_room!.execute({ name: "Cues", bots: ["Room Stranger"] }, "c1")).toContain("NOT created");
    expect(await tools.create_room!.execute({ name: "Cues", bots: ["Room Primary"] }, "c2")).toContain("NOT created");

    const answer = String(await tools.create_room!.execute({ name: "Cues", bots: ["@roomsound", art.id], message: "Agree the spinner cue." }, "c3"));
    const roomId = /id (room[^)\s]+)/.exec(answer)![1]!;
    const room = getThread(roomId)!;
    expect(room.kind).toBe("room");
    expect(room.userId).toBe("u-room");
    expect([...room.members].sort()).toEqual([primary.id, sound.id, art.id].sort());
    expect(room.members).not.toContain(stranger.id);

    const opener = listMessages(roomId).find((m) => m.author === primary.id)!;
    expect(opener.body).toBe("@roomsound @roomart Agree the spinner cue.");

    const pending = claimPendingMessages("room-test", () => 1000);
    for (const m of pending) releaseClaim(m.id);
    expect(pending.map((m) => m.id)).toContain(opener.id);
    expect(botLinesSincePerson(roomId)).toBe(1);
    postMessage({ threadId: roomId, author: "you", body: "Carry on" });
    expect(botLinesSincePerson(roomId)).toBe(0);
  });
});

describe("tools for running the work", () => {
  const setup = async (userId: string) => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getThread, postMessage } = await import("../src/data/threads.ts");
    const { baseTools, teamTools } = await import("../src/tools.ts");
    const primary = createBot(botInputSchema.parse({ name: `${userId} Primary` }), userId);
    const dev = createBot(botInputSchema.parse({ name: `${userId} Dev` }), userId);
    const asked = postMessage({ threadId: primary.threadId, author: "you", body: "Run the waves" });
    const stopped: string[] = [];
    const context = {
      box: { url: "http://box.invalid", token: "t", user: userId },
      bot: primary,
      thread: getThread(primary.threadId)!,
      message: asked,
      askBot: async () => "",
      syncSoul: async () => undefined,
      stopWork: async (id: string) => {
        stopped.push(id);
        return false;
      },
      isWorking: () => false,
    };
    const tools = { ...baseTools(context), ...teamTools(context) };
    const run = async (name: string, input: Record<string, unknown>) => String(await tools[name]!.execute(input, "c"));
    return { primary, dev, run, stopped };
  };

  test("handoffs are listed, amended and withdrawn, and the teammate hears of it", async () => {
    const { getDelegation } = await import("../src/data/delegations.ts");
    const { claimPendingMessages, listMessages, releaseClaim } = await import("../src/data/threads.ts");
    const { primary, dev, run, stopped } = await setup("u-waves");
    const sent = await run("delegate_bot", { bot: dev.name, brief: "Build the monthly clock" });
    const first = /handoff (d[^)\s]+)/.exec(sent)![1]!;
    expect(await run("list_handoffs", {})).toContain(`${first} · to ${dev.name} · open`);
    expect(await run("list_handoffs", { id: first })).toContain("Build the monthly clock");

    const amended = await run("amend_handoff", { handoff: dev.name, brief: "There are no months: build the yearly turn" });
    const second = /handoff (d[^,\s]+), replacing/.exec(amended)![1]!;
    expect(getDelegation(first)!.status).toBe("cancelled");
    expect(getDelegation(second)!.status).toBe("open");
    expect(stopped).toEqual([getDelegation(first)!.messageId]);

    const pending = claimPendingMessages("waves-test", () => 1000);
    for (const m of pending) releaseClaim(m.id);
    expect(pending.map((m) => m.id)).not.toContain(getDelegation(first)!.messageId);
    expect(pending.map((m) => m.id)).toContain(getDelegation(second)!.messageId);
    expect(listMessages(dev.threadId).some((m) => m.body.startsWith("I've withdrawn the task"))).toBe(true);

    expect(await run("cancel_handoff", { handoff: second, reason: "Sketch took it" })).toContain("Withdrawn");
    expect(getDelegation(second)!).toMatchObject({ status: "cancelled", result: "Sketch took it" });
    expect(await run("cancel_handoff", { handoff: second, reason: "again" })).toContain("already cancelled");
    expect(await run("list_handoffs", {})).toContain("withdrawn");

    const other = await setup("u-waves-other");
    expect(await other.run("list_handoffs", { id: first })).toContain("NOT found");
    expect(await other.run("cancel_handoff", { handoff: first, reason: "x" })).toContain("isn't yours");
    expect(primary.id).not.toBe(other.primary.id);
  });

  test("a follow-up wakes the bot once, with its note, when it is due", async () => {
    const { runDueFollowUps } = await import("../src/dispatcher.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { primary, run } = await setup("u-follow");
    expect(await run("follow_up", { minutes: 0, note: "x" })).toContain("NOT set");
    const set = await run("follow_up", { minutes: 45, note: "Check Bolt's build" });
    expect(set).toContain("Set (id");
    expect(await run("list_handoffs", {})).toContain("Check Bolt's build");
    runDueFollowUps(new Date(Date.now() + 10 * 60_000));
    expect(listMessages(primary.threadId).filter((m) => m.kind === "prompt")).toHaveLength(0);
    runDueFollowUps(new Date(Date.now() + 50 * 60_000));
    runDueFollowUps(new Date(Date.now() + 60 * 60_000));
    const prompts = listMessages(primary.threadId).filter((m) => m.kind === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.body).toContain("Check Bolt's build");
    const dropped = /id (f[^)\s]+)/.exec(await run("follow_up", { minutes: 5, note: "never mind" }))![1]!;
    expect(await run("follow_up", { cancel: dropped })).toContain("Dropped");
  });

  test("routines can be changed, run now and deleted, only the bot's own", async () => {
    const { listRoutines } = await import("../src/data/routines.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { primary, run } = await setup("u-routines");
    await run("create_routine", { name: "Standup", cron: "0 9 * * *", prompt: "Say what moved" });
    expect(await run("update_routine", { routine: "standup", cron: "not a cron" })).toContain("bad cron");
    expect(await run("update_routine", { routine: "Standup", cron: "30 9 * * 1-5", enabled: true })).toContain("on, next run");
    expect(listRoutines(primary.id)[0]).toMatchObject({ cron: "30 9 * * 1-5", enabled: true });
    expect(await run("run_routine", { routine: "Standup" })).toContain("queued");
    expect(listMessages(primary.threadId).some((m) => m.author === "routine" && m.body.includes("Say what moved"))).toBe(true);
    const other = await setup("u-routines-other");
    expect(await other.run("delete_routine", { routine: listRoutines(primary.id)[0]!.id })).toContain("NOT deleted");
    expect(await run("delete_routine", { routine: "Standup" })).toContain("Deleted");
    expect(listRoutines(primary.id)).toHaveLength(0);
  });

  test("a bot reads and searches only its own person's conversations", async () => {
    const { createRoom, postMessage } = await import("../src/data/threads.ts");
    const { dev, run } = await setup("u-reading");
    postMessage({ threadId: dev.threadId, author: dev.id, body: "The export filter needs *.json", answered: true });
    const room = createRoom("Audio sync", [dev.id], "u-reading");
    postMessage({ threadId: room.id, author: "you", body: "Spinner cue first, please" });
    expect(await run("read_conversation", { conversation: dev.name })).toContain("The export filter needs *.json");
    expect(await run("read_conversation", { conversation: "audio sync" })).toContain("Person: Spinner cue first");
    expect(await run("search_messages", { query: "spinner" })).toContain('the room "Audio sync"');
    const other = await setup("u-reading-other");
    expect(await other.run("read_conversation", { conversation: room.id })).toContain("NOT found");
    expect(await other.run("read_conversation", { conversation: dev.id })).toContain("NOT found");
    expect(await other.run("search_messages", { query: "spinner" })).toContain("Nothing said matches");
  });
});

describe("skills", () => {
  test("each person has their own library of skill folders, and a route never shows anyone else's", async () => {
    await seedUsers(["u-sk-a", "user"], ["u-sk-b", "user"]);
    const { Hono } = await import("hono");
    const { skillsRoutes } = await import("../src/routes/skills.ts");
    const { listSkills, getSkill, skillFiles } = await import("../src/data/skills.ts");
    const { unpackSkill } = await import("../src/skill-bundle.ts");
    const a = asPerson(new Hono(), "u-sk-a").route("/api", skillsRoutes());
    const b = asPerson(new Hono(), "u-sk-b").route("/api", skillsRoutes());
    const json = { "Content-Type": "application/json" };

    const made = await a.request("/api/skills", { method: "POST", headers: json, body: JSON.stringify({ name: "Weekly report", description: "Numbers for Monday.", instructions: "Run scripts/report.py." }) });
    expect(made.status).toBe(201);
    const { skill } = (await made.json()) as { skill: { id: string; slug: string } };
    expect(skill.slug).toBe("weekly-report");

    const theirs = (await (await b.request("/api/skills", { method: "POST", headers: json, body: JSON.stringify({ name: "Weekly report", instructions: "Theirs." }) })).json()) as { skill: { slug: string } };
    expect(theirs.skill.slug).toBe("weekly-report");
    expect(listSkills("u-sk-a").map((s) => s.slug)).toEqual(["weekly-report"]);

    expect((await a.request(`/api/skills/${skill.id}/file`, { method: "PUT", headers: json, body: JSON.stringify({ path: "scripts/report.py", content: "#!/usr/bin/env python3\nprint('hi')\n" }) })).status).toBe(200);
    expect((await a.request(`/api/skills/${skill.id}/file`, { method: "PUT", headers: json, body: JSON.stringify({ path: "../escape.py", content: "x" }) })).status).toBe(400);
    const form = new FormData();
    form.append("dir", "assets");
    form.append("file", new File([new Uint8Array([0, 1, 2, 3])], "logo.png"));
    expect((await a.request(`/api/skills/${skill.id}/files`, { method: "POST", body: form })).status).toBe(200);
    expect((await a.request(`/api/skills/${skill.id}/file`, { method: "PATCH", headers: json, body: JSON.stringify({ path: "assets/logo.png", to: "assets/brand.png" }) })).status).toBe(200);
    const files = getSkill(skill.id)!.files;
    expect(files).toEqual([
      { path: "assets/brand.png", size: 4, executable: false, text: false },
      { path: "scripts/report.py", size: 35, executable: true, text: true },
    ]);
    const read = (await (await a.request(`/api/skills/${skill.id}/file?path=scripts/report.py`)).json()) as { content: string };
    expect(read.content).toContain("print('hi')");

    expect((await b.request(`/api/skills/${skill.id}/file?path=scripts/report.py`)).status).toBe(404);
    expect((await b.request(`/api/skills/${skill.id}/download`)).status).toBe(404);
    expect((await b.request(`/api/skills/${skill.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "Mine now" }) })).status).toBe(404);
    expect((await b.request(`/api/skills/${skill.id}`, { method: "DELETE" })).status).toBe(404);
    const bList = (await (await b.request("/api/skills")).json()) as { skills: { id: string }[] };
    expect(bList.skills.some((s) => s.id === skill.id)).toBe(false);

    const download = await a.request(`/api/skills/${skill.id}/download`);
    expect(download.headers.get("Content-Disposition")).toContain("weekly-report.skill");
    const zip = new Uint8Array(await download.arrayBuffer());
    const unpacked = unpackSkill(zip);
    if ("error" in unpacked) throw new Error(unpacked.error);
    expect(unpacked.files.map((f) => f.path)).toEqual(["assets/brand.png", "scripts/report.py"]);
    const upload = new FormData();
    upload.append("file", new File([zip], "weekly-report.skill"));
    const imported = await b.request("/api/skills/import", { method: "POST", body: upload });
    expect(imported.status).toBe(201);
    const copy = ((await imported.json()) as { skill: { id: string; slug: string; name: string; description: string; source: string } }).skill;
    expect(copy).toMatchObject({ slug: "weekly-report-2", name: "Weekly report", description: "Numbers for Monday.", source: "imported" });
    expect(skillFiles(copy.id).find((f) => f.path === "assets/brand.png")!.data).toEqual(new Uint8Array([0, 1, 2, 3]));

    const md = new FormData();
    md.append("file", new File(["---\nname: pdf-filler\ndescription: Fill PDF forms.\n---\n\n# Fill\nSteps."], "SKILL.md"));
    const fromMd = ((await (await b.request("/api/skills/import", { method: "POST", body: md })).json()) as { skill: { name: string; slug: string } }).skill;
    expect(fromMd).toMatchObject({ name: "Pdf filler", slug: "pdf-filler" });
    const junk = new FormData();
    junk.append("file", new File(["not a zip"], "x.skill"));
    expect((await b.request("/api/skills/import", { method: "POST", body: junk })).status).toBe(400);

    expect((await a.request(`/api/skills/${skill.id}/file?path=assets/brand.png`, { method: "DELETE" })).status).toBe(200);
    expect((await a.request(`/api/skills/${skill.id}`, { method: "DELETE" })).status).toBe(204);
    expect(skillFiles(skill.id)).toEqual([]);
  });

  test("a bot saves what it just did as a skill, files and all, and updates it", async () => {
    await seedUsers(["u-sk-bot", "user"]);
    const { createBot } = await import("../src/data/bots.ts");
    const { getThread } = await import("../src/data/threads.ts");
    const { getSkillBySlug, skillFiles } = await import("../src/data/skills.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Analyst" }), "u-sk-bot");
    const context = { box: { url: "http://box.invalid", token: "t", user: "u-sk-bot" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
    const tools = baseTools(context);
    const saved = await tools.save_skill!.execute({ name: "Churn report", description: "Churn by cohort.", instructions: "Run `python3 scripts/churn.py <csv>`.", files: [{ path: "scripts/churn.py", content: "#!/usr/bin/env python3\nimport sys\n" }, { path: "references/notes.md", content: "Cohorts are monthly." }] }, "call");
    expect(String(saved)).toContain("Saved as /churn-report with 2 files");
    const skill = getSkillBySlug("u-sk-bot", "churn-report")!;
    expect(skill.source).toBe("bot");
    expect(skill.files.map((f) => [f.path, f.executable])).toEqual([["references/notes.md", false], ["scripts/churn.py", true]]);
    expect(String(await tools.save_skill!.execute({ name: "Bad", instructions: "x", files: [{ path: "../../etc/x", content: "y" }] }, "call"))).toContain("NOT saved");

    expect(getSkillBySlug("u-admin", "churn-report")).toBeNull();
    expect(String(await tools.use_skill!.execute({ slug: "/churn-report" }, "call"))).toContain("~/.skills/churn-report/");

    expect(String(await tools.update_skill!.execute({ slug: "churn-report", files: [{ path: "references/notes.md", content: "Cohorts are weekly." }] }, "call"))).toContain("Updated /churn-report");
    const notes = skillFiles(skill.id).find((f) => f.path === "references/notes.md")!;
    expect(new TextDecoder().decode(notes.data)).toBe("Cohorts are weekly.");
    expect(skillFiles(skill.id)).toHaveLength(2);
  });

  test("the library from before is the admin's, and a person's skills go with them", async () => {
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { adoptOrphans, deleteUserData } = await import("../src/data/users.ts");
    const { createSkill, listSkills } = await import("../src/data/skills.ts");
    ensureDatabase().query("INSERT INTO gond_skills (id, user_id, slug, name, description, instructions, source, created_at, updated_at) VALUES ('sk-old', NULL, 'old', 'Old', '', 'Do it.', 'written', 'x', 'x')").run();
    adoptOrphans("u-admin");
    expect(listSkills("u-admin").map((s) => s.slug)).toContain("old");
    await seedUsers(["u-sk-gone", "user"]);
    createSkill("u-sk-gone", { name: "Temp", description: "", instructions: "x" }, "written", { files: [{ path: "a.txt", data: new TextEncoder().encode("a"), executable: false }] });
    deleteUserData("u-sk-gone");
    expect(listSkills("u-sk-gone")).toEqual([]);
    expect((ensureDatabase().query("SELECT COUNT(*) AS n FROM gond_skill_files f LEFT JOIN gond_skills s ON s.id = f.skill_id WHERE s.id IS NULL").get() as { n: number }).n).toBe(0);
  });
});

describe("the rename", () => {
  async function legacyEncrypt(plain: string) {
    const { createCipheriv, hkdfSync, randomBytes } = await import("node:crypto");
    const { masterKey } = await import("../src/secrets.ts");
    const key = Buffer.from(hkdfSync("sha256", masterKey(), Buffer.alloc(0), "kru:secrets", 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  test("a fresh database has only gond_ objects, at the final version", async () => {
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { LATEST_VERSION } = await import("../src/db/migrations.ts");
    const db = ensureDatabase();
    const legacy = db.query("SELECT name FROM sqlite_master WHERE name LIKE 'kru\\_%' ESCAPE '\\'").all();
    expect(legacy).toEqual([]);
    expect((db.query("SELECT MAX(version) AS v FROM gond_schema").get() as { v: number }).v).toBe(LATEST_VERSION);
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'gond\\_%' ESCAPE '\\'").all() as { name: string }[]).map((r) => r.name);
    for (const name of ["gond_messages_thread", "gond_messages_pending", "gond_approvals_pending", "gond_bots_user", "gond_threads_user", "gond_providers_user", "gond_follow_ups_due", "gond_skills_user", "gond_delegations_parent", "gond_delegations_result"]) {
      expect(indexes).toContain(name);
    }
  });

  test("a database from before the rename comes over with its rows and foreign keys", async () => {
    const { Database } = await import("bun:sqlite");
    const { runMigrations, RENAME_VERSION, LATEST_VERSION } = await import("../src/db/migrations.ts");
    const db = new Database(path.join(dir, "upgrade.db"), { create: true, strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    expect(runMigrations(db, RENAME_VERSION - 1)).toBe(RENAME_VERSION - 1);
    db.query("INSERT INTO kru_threads (id, kind, bot_id, created_at, updated_at) VALUES ('t1', 'bot', 'b1', 'x', 'x')").run();
    db.query("INSERT INTO kru_bots (id, name, color, model, thread_id, user_id, created_at, updated_at) VALUES ('b1', 'Pip', '#E04E0A', 'opus', 't1', 'u-admin', 'x', 'x')").run();
    db.query("INSERT INTO kru_messages (id, thread_id, author, body, created_at) VALUES ('m1', 't1', 'you', 'hello', 'x')").run();
    db.query("INSERT INTO kru_secrets (user_id, name, value, created_at, updated_at) VALUES ('u-admin', 'TOKEN', 'v1.x.y.z', 'x', 'x')").run();
    db.exec("ALTER TABLE gond_schema RENAME TO kru_schema");

    expect(runMigrations(db)).toBe(LATEST_VERSION);
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'kru\\_%' ESCAPE '\\'").all()).toEqual([]);
    expect((db.query("SELECT name FROM gond_bots WHERE id = 'b1'").get() as { name: string }).name).toBe("Pip");
    expect((db.query("SELECT body FROM gond_messages WHERE thread_id = 't1'").get() as { body: string }).body).toBe("hello");
    expect((db.query("SELECT value FROM gond_secrets WHERE name = 'TOKEN'").get() as { value: string }).value).toBe("v1.x.y.z");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const sql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'gond_messages_thread'").get() as { sql: string }).sql;
    expect(sql).toMatch(/gond_messages_thread ON "?gond_messages"? /);
    expect((db.query("SELECT sql FROM sqlite_master WHERE name = 'gond_messages'").get() as { sql: string }).sql).toContain("REFERENCES \"gond_threads\"");
    db.query("DELETE FROM gond_threads WHERE id = 't1'").run();
    expect(db.query("SELECT id FROM gond_messages").all()).toEqual([]);
    db.close();
  });

  test("secrets from before the rename are rewritten once at start", async () => {
    const { ensureDatabase, resetDbReady } = await import("../src/db/init.ts");
    const { decryptSecret } = await import("../src/secrets.ts");
    const { readSecret } = await import("../src/data/secrets.ts");
    const { oidcProvider } = await import("../src/data/oidc.ts");
    const db = ensureDatabase();
    db.query("INSERT INTO gond_secrets (user_id, name, value, created_at, updated_at) VALUES ('u-legacy', 'OLD_KEY', ?, 'x', 'x')").run(await legacyEncrypt("old-plain-value"));
    db.query("INSERT INTO gond_composio_keys (user_id, api_key, updated_at) VALUES ('u-legacy', ?, 'x')").run(await legacyEncrypt("composio-old"));
    db.query("UPDATE gond_settings SET oidc = ? WHERE id = 1").run(JSON.stringify({ enabled: true, issuer: "https://id.example.com", clientId: "gond", clientSecret: await legacyEncrypt("oidc-old") }));
    expect(decryptSecret((db.query("SELECT value FROM gond_secrets WHERE name = 'OLD_KEY'").get() as { value: string }).value)).toBe("old-plain-value");

    resetDbReady();
    ensureDatabase();
    const secret = (db.query("SELECT value FROM gond_secrets WHERE name = 'OLD_KEY'").get() as { value: string }).value;
    expect(secret.startsWith("v2.")).toBe(true);
    expect(readSecret("u-legacy", "OLD_KEY")).toBe("old-plain-value");
    const composio = (db.query("SELECT api_key FROM gond_composio_keys WHERE user_id = 'u-legacy'").get() as { api_key: string }).api_key;
    expect(composio.startsWith("v2.")).toBe(true);
    expect(decryptSecret(composio)).toBe("composio-old");
    const oidc = (db.query("SELECT oidc FROM gond_settings WHERE id = 1").get() as { oidc: string }).oidc;
    expect((JSON.parse(oidc) as { clientSecret: string }).clientSecret.startsWith("v2.")).toBe(true);
    expect(oidcProvider()?.clientSecret).toBe("oidc-old");

    resetDbReady();
    ensureDatabase();
    expect((db.query("SELECT value FROM gond_secrets WHERE name = 'OLD_KEY'").get() as { value: string }).value).toBe(secret);
  });
});

describe("the computer", () => {
  function fakeBox() {
    const png = Buffer.alloc(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(1024, 16);
    png.writeUInt32BE(640, 20);
    const state = { control: "free" as "free" | "bots" | "person", actions: [] as Record<string, unknown>[], batches: [] as { bot: string; target: string; steps: Record<string, unknown>[]; saveTo?: string }[], controlCalls: [] as Record<string, unknown>[], controlBots: [] as string[], primaries: [] as boolean[], bot: "b1", full: 0, uploads: new Map<string, Uint8Array>(), previews: [] as { path: string; type: string | null }[] };
    const server = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        const url = new URL(request.url);
        // One screen stands in for every bot's: its control is the one the tests set.
        const status = (bot = state.bot) => ({ bot, running: true, ready: true, width: 2048, height: 1280, viewers: 0, control: state.control });
        if (url.pathname === "/desktop" && request.method === "GET") return Response.json({ screens: [status()] });
        const control = /^\/desktop\/([\w-]+)\/control$/.exec(url.pathname);
        if (control) {
          const body = (await request.json()) as { holder: "person" | "free"; from?: "bots" };
          state.controlCalls.push(body);
          state.controlBots.push(control[1]!);
          if (!body.from || state.control === "bots") state.control = body.holder;
          return Response.json(status(control[1]!));
        }
        if (url.pathname === "/files/raw" && request.method === "PUT") {
          const path = url.searchParams.get("path")!;
          if (path.includes("broken")) return Response.json({ error: "disk full" }, { status: 500 });
          state.uploads.set(path, new Uint8Array(await request.arrayBuffer()));
          return Response.json({ ok: true, size: state.uploads.get(path)!.byteLength });
        }
        if (url.pathname === "/files/preview") {
          const path = url.searchParams.get("path")!;
          if (!state.uploads.has(path)) return Response.json({ error: "No such file" }, { status: 404 });
          state.previews.push({ path, type: url.searchParams.get("type") });
          return Response.json({ ok: true, mediaType: "image/jpeg", data: "c21hbGw=", size: 5 });
        }
        if (url.pathname === "/computer") {
          const { primary, ...body } = (await request.json()) as { bot: string; primary?: boolean; target: string; steps: Record<string, unknown>[]; saveTo?: string };
          state.batches.push(body);
          state.primaries.push(Boolean(primary));
          state.bot = body.bot;
          if (state.full > 0) {
            state.full -= 1;
            return Response.json({ error: "3 of your bots are using their screens", code: "screens_full" }, { status: 429 });
          }
          state.actions.push(...body.steps);
          if (body.steps.some((step) => step.type === "bogus")) return Response.json({ error: "Step 1: Unknown step \"bogus\"" }, { status: 400 });
          const input = body.steps.some((step) => step.type !== "screenshot" && step.type !== "wait");
          if (input && state.control === "person") return Response.json({ error: "The person has control", code: "person_has_control" }, { status: 409 });
          if (input) state.control = "bots";
          const page = body.target === "browser" ? { url: "https://example.com/", title: "Example", tabs: [{ index: 0, title: "Example", url: "https://example.com/", active: true }] } : {};
          const size = body.target === "browser" ? { width: 1280, height: 800 } : { width: 1024, height: 640 };
          return Response.json({ ok: true, target: body.target, control: state.control, screen: { width: 2048, height: 1280 }, ...size, ...page, done: body.steps.map((step) => String(step.type)), error: null, ...(body.saveTo ? {} : { image: png.toString("base64") }) });
        }
        return Response.json({ error: "no" }, { status: 404 });
      },
    });
    return { server, state };
  }

  async function until(check: () => unknown, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function openCard(threadId: string): Promise<void> {
    const { listMessages } = await import("../src/data/threads.ts");
    const { getApproval } = await import("../src/data/approvals.ts");
    await until(() => {
      const id = listMessages(threadId).at(-1)?.approvalId;
      return id && getApproval(id)?.status === "pending";
    });
  }

  const desktopMemory = globalThis as { __gondDesktopWaiters?: Map<string, Set<unknown>> } & Record<string, unknown>;
  const untilWaiting = () => until(() => [...(desktopMemory.__gondDesktopWaiters ?? new Map<string, Set<unknown>>())].some(([key, set]) => key.startsWith("u-admin\n") && set.size));

  async function withBox<T>(run: (box: ReturnType<typeof fakeBox>) => Promise<T>): Promise<T> {
    const box = fakeBox();
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${box.server.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      return await run(box);
    } finally {
      box.server.stop(true);
      for (const key of Object.keys(desktopMemory)) if (key.startsWith("__gondDesktop")) delete desktopMemory[key];
      if (boxUrl === undefined) delete process.env.GOND_BOX_URL;
      else process.env.GOND_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.GOND_BOX_TOKEN;
      else process.env.GOND_BOX_TOKEN = boxToken;
    }
  }

  test("a login card types what the person gave without the bot seeing it, and only a remembered sign-in is stored, encrypted", async () => {
    await withBox(async ({ state }) => {
      const { createBot } = await import("../src/data/bots.ts");
      const { getThread, listMessages } = await import("../src/data/threads.ts");
      const { decide } = await import("../src/approvals.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool } = await import("../src/computer-tool.ts");
      const { baseTools } = await import("../src/tools.ts");
      const { listSecrets, readLogin, setSecret, allSecretValues } = await import("../src/data/secrets.ts");
      const { secretsRoutes } = await import("../src/routes/secrets.ts");
      const { ensureDatabase } = await import("../src/db/init.ts");
      const { releaseComputer } = await import("../src/desktop.ts");
      const { botInputSchema } = await import("@gond/shared");
      const { Hono } = await import("hono");
      const bot = createBot(botInputSchema.parse({ name: "Courier", approval: "auto" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      const box = boxConfig("u-admin")!;
      const context = { box, bot, thread, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const routes = asPerson(new Hono(), "u-admin").route("/api", secretsRoutes());
      const raw = () => JSON.stringify(ensureDatabase().query("SELECT * FROM gond_secrets").all()) + JSON.stringify(ensureDatabase().query("SELECT * FROM gond_secret_requests").all());

      const asking = baseTools(context).request_login!.execute({ site: "Uber Eats", fields: [{ kind: "email" }, { kind: "password" }, { kind: "code", label: "The 4-digit code" }], reason: "to order your Dr Pepper" }, "c1");
      await until(() => listMessages(thread.id).at(-1)?.kind === "secret");
      const card = listMessages(thread.id).at(-1)!;
      expect(card.kind).toBe("secret");
      expect(card.body).toBe("Sign in to Uber Eats: to order your Dr Pepper");
      const shown = (await (await routes.request(`/api/secret-requests/${card.approvalId}`)).json()) as { request: { target: string; site: string; fields: { name: string; label: string; kind: string }[] } };
      expect(shown.request.target).toBe("login");
      expect(shown.request.fields.map((f) => f.name)).toEqual(["UBER_EATS_EMAIL", "UBER_EATS_PASSWORD", "UBER_EATS_CODE"]);
      expect((await routes.request(`/api/secret-requests/${card.approvalId}`, { method: "POST", body: JSON.stringify({ values: { UBER_EATS_EMAIL: "me@example.com" } }) })).status).toBe(400);
      const values = { UBER_EATS_EMAIL: "me@example.com", UBER_EATS_PASSWORD: "pw-plain-1234", UBER_EATS_CODE: "4821" };
      expect((await routes.request(`/api/secret-requests/${card.approvalId}`, { method: "POST", body: JSON.stringify({ values, remember: true }) })).status).toBe(200);
      const told = String(await asking);
      expect(told).toContain("UBER_EATS_PASSWORD");
      for (const value of Object.values(values)) expect(told).not.toContain(value);

      for (const value of Object.values(values)) expect(raw()).not.toContain(value);
      expect(listSecrets("u-admin").filter((s) => s.site === "Uber Eats").map((s) => s.name)).toEqual(["UBER_EATS_EMAIL", "UBER_EATS_PASSWORD"]);
      expect(readLogin("u-admin", "UBER_EATS_PASSWORD")).toBe("pw-plain-1234");
      expect(allSecretValues()).toContain("4821");

      const tools = computerTool({ box, bot, thread });
      expect(String(await tools.browser.execute({ actions: [{ type: "type_login", name: "STRIPE_KEY" }] }, "t0"))).toContain("NOT typed");
      const typed = await tools.browser.execute({ actions: [{ type: "click", x: 5, y: 5 }, { type: "type_login", name: "uber_eats_password", submit: true }] }, "t1");
      expect(JSON.stringify(typed)).not.toContain("pw-plain-1234");
      expect(state.batches.at(-1)).toEqual({ bot: bot.id, target: "browser", steps: [{ type: "click", x: 5, y: 5 }, { type: "type", text: "pw-plain-1234", secret: true }, { type: "key", key: "Enter" }] });

      setSecret("u-admin", "STRIPE_KEY", "sk_not_a_login");
      expect(readLogin("u-admin", "STRIPE_KEY")).toBeNull();

      const other = createBot(botInputSchema.parse({ name: "Runner", approval: "auto" }), "u-admin");
      const otherThread = getThread(other.threadId)!;
      expect(String(await computerTool({ box, bot: other, thread: otherThread }).browser.execute({ actions: [{ type: "type_login", name: "UBER_EATS_PASSWORD" }] }, "t2"))).toContain("NOT typed");
      const again = baseTools({ ...context, bot: other, thread: otherThread }).request_login!.execute({ site: "Uber Eats", fields: ["email", "password"] }, "c2");
      await openCard(otherThread.id);
      const approval = listMessages(otherThread.id).at(-1)!;
      expect(approval.kind).toBe("approval");
      expect(approval.body).toBe("Sign in to Uber Eats with your saved details");
      decide(approval.approvalId!, { decision: "allow" });
      expect(String(await again)).toContain("saved details for Uber Eats are ready");
      await computerTool({ box, bot: other, thread: otherThread }).browser.execute({ actions: [{ type: "type_login", name: "UBER_EATS_EMAIL" }] }, "t3");
      expect(state.actions.at(-1)).toEqual({ type: "type", text: "me@example.com", secret: true });

      expect((await routes.request("/api/secrets/UBER_EATS_PASSWORD", { method: "DELETE" })).status).toBe(200);
      expect(readLogin("u-admin", "UBER_EATS_PASSWORD")).toBeNull();
      expect((await asPerson(new Hono(), "u-other").route("/api", secretsRoutes()).request("/api/secrets/UBER_EATS_EMAIL", { method: "DELETE" })).status).toBe(404);
      await releaseComputer("u-admin", thread.id, { botId: bot.id });
      await releaseComputer("u-admin", otherThread.id, { botId: other.id });
    });
  });

  test("a stored secret that isn't a sign-in is typed only after the person allows it, and the bot never sees it", async () => {
    await withBox(async ({ state }) => {
      const { createBot } = await import("../src/data/bots.ts");
      const { getThread, listMessages } = await import("../src/data/threads.ts");
      const { decide } = await import("../src/approvals.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool } = await import("../src/computer-tool.ts");
      const { setSecret } = await import("../src/data/secrets.ts");
      const { releaseComputer } = await import("../src/desktop.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Proxmox", approval: "auto" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      setSecret("u-admin", "PVE_ROOT_PASSWORD", "root-pw-5678");
      const tools = computerTool({ box: boxConfig("u-admin")!, bot, thread });

      const denied = tools.computer.execute({ actions: [{ type: "type_login", name: "PVE_ROOT_PASSWORD" }] }, "t1");
      await openCard(thread.id);
      const card = listMessages(thread.id).at(-1)!;
      expect(card.kind).toBe("approval");
      expect(card.body).toBe("Type PVE_ROOT_PASSWORD into the screen");
      decide(card.approvalId!, { decision: "deny" });
      const before = state.batches.length;
      expect(String(await denied)).toContain("NOT typed");
      expect(state.batches.length).toBe(before);

      const typing = tools.computer.execute({ actions: [{ type: "type_login", name: "PVE_ROOT_PASSWORD", submit: true }] }, "t2");
      await openCard(thread.id);
      decide(listMessages(thread.id).at(-1)!.approvalId!, { decision: "allow" });
      expect(JSON.stringify(await typing)).not.toContain("root-pw-5678");
      expect(state.batches.at(-1)!.steps).toEqual([{ type: "type", text: "root-pw-5678", secret: true }, { type: "key", key: "Enter" }]);
      await releaseComputer("u-admin", thread.id, { botId: bot.id });
    });
  });

  test("under Always ask the tool asks once per turn, and a denial holds for the turn; screenshots never ask", async () => {
    await withBox(async ({ state }) => {
      const { createBot, deleteBot } = await import("../src/data/bots.ts");
      const { getThread, listMessages } = await import("../src/data/threads.ts");
      const { decide } = await import("../src/approvals.ts");
      const { listRules } = await import("../src/data/approvals.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool, DENIED_TEXT } = await import("../src/computer-tool.ts");
      const { driversOf, releaseComputer } = await import("../src/desktop.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Eyes", approval: "ask" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      const make = () => computerTool({ box: boxConfig("u-admin")!, bot, thread }).computer;
      const count = () => listMessages(bot.threadId).length;

      let tool = make();
      const before = count();
      const shot = (await tool.execute({ actions: [{ type: "screenshot" }] }, "c1")) as { type: string; text?: string }[];
      expect(Array.isArray(shot)).toBe(true);
      expect(shot[0]).toEqual({ type: "text", text: "Screenshot 1024x640 (screen 2048x1280)" });
      expect(shot[1]!.type).toBe("image");
      expect(count()).toBe(before);
      expect(driversOf("u-admin")).toEqual([]);

      let pending = tool.execute({ actions: [{ type: "click", x: 100, y: 50 }] }, "c2");
      await openCard(bot.threadId);
      let card = listMessages(bot.threadId).at(-1)!;
      expect(card.kind).toBe("approval");
      expect(card.body).toBe("Use the computer (the mouse and keyboard on Eyes's screen)");
      decide(card.approvalId!, { decision: "allow" });
      const clicked = (await pending) as { type: string }[];
      expect(clicked[1]!.type).toBe("image");
      expect(state.actions.at(-1)).toEqual({ type: "click", x: 200, y: 100 });
      expect(driversOf("u-admin")).toEqual([{ botId: bot.id, threadId: thread.id }]);
      const asked = count();
      const batch = (await tool.execute({ actions: [{ type: "type", text: "hello" }, { type: "key", key: "Enter" }] }, "c3")) as { type: string; text?: string }[];
      expect(batch[0]!.text).toContain("All 2 actions ran.");
      expect(count()).toBe(asked);
      await releaseComputer("u-admin", thread.id, { botId: bot.id });
      expect(driversOf("u-admin")).toEqual([]);
      expect(state.controlCalls.at(-1)).toEqual({ holder: "free", from: "bots" });
      expect(state.control).toBe("free");

      tool = make();
      pending = tool.execute({ action: "left_click", coordinate: [1, 1] }, "c6");
      await openCard(bot.threadId);
      card = listMessages(bot.threadId).at(-1)!;
      expect(card.kind).toBe("approval");
      decide(card.approvalId!, { decision: "deny" });
      expect(await pending).toBe(DENIED_TEXT);
      const denied = count();
      expect(await tool.execute({ action: "type", text: "x" }, "c7")).toBe(DENIED_TEXT);
      expect(count()).toBe(denied);
      expect(driversOf("u-admin")).toEqual([]);
      const shotAgain = (await tool.execute({ action: "screenshot" }, "c8")) as unknown[];
      expect(shotAgain).toHaveLength(2);

      tool = make();
      pending = tool.execute({ action: "left_click", coordinate: [1, 1] }, "c9");
      await openCard(bot.threadId);
      card = listMessages(bot.threadId).at(-1)!;
      expect(decide(card.approvalId!, { decision: "always" })?.rule).toBe("computer");
      await pending;
      expect(listRules(bot.id)).toContain("computer");
      const saved = count();
      tool = make();
      await tool.execute({ action: "left_click", coordinate: [1, 1] }, "c10");
      expect(count()).toBe(saved);
      await releaseComputer("u-admin", thread.id);

      deleteBot(bot.id);

      for (const level of ["auto", "full"] as const) {
        const fresh = createBot(botInputSchema.parse({ name: `Eyes ${level}`, approval: level }), "u-admin");
        const freshThread = getThread(fresh.threadId)!;
        expect(listRules(fresh.id)).toEqual([]);
        tool = computerTool({ box: boxConfig("u-admin")!, bot: fresh, thread: freshThread }).computer;
        const quiet = listMessages(fresh.threadId).length;
        await tool.execute({ action: "left_click", coordinate: [1, 1] }, `c-${level}`);
        expect(listMessages(fresh.threadId)).toHaveLength(quiet);
        expect(driversOf("u-admin")).toEqual([{ botId: fresh.id, threadId: freshThread.id }]);
        await releaseComputer("u-admin", freshThread.id);
        deleteBot(fresh.id);
      }
    });
  });

  test("a batch the person's control turned away waits for the screen back, then carries on from what they left", async () => {
    await withBox(async ({ state }) => {
      const { createBot, deleteBot } = await import("../src/data/bots.ts");
      const { getThread, listMessages } = await import("../src/data/threads.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool, HANDED_BACK_TEXT, PERSON_HAS_CONTROL_TEXT } = await import("../src/computer-tool.ts");
      const { handedBack, releaseComputer, tookControl } = await import("../src/desktop.ts");
      const { tellHandedBack, stopThread } = await import("../src/responder.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Hands", approval: "full" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      const tool = computerTool({ box: boxConfig("u-admin")!, bot, thread }).computer;
      state.control = "person";
      let settled = false;
      const pending = tool.execute({ action: "left_click", coordinate: [5, 5] }, "c1").finally(() => (settled = true));
      await untilWaiting();
      const looked = (await tool.execute({ action: "screenshot" }, "c2")) as unknown[];
      expect(looked).toHaveLength(2);
      expect(settled).toBe(false);
      state.control = "free";
      expect(handedBack("u-admin", bot.id)).toEqual([]);
      const back = (await pending) as { type: string; text?: string }[];
      expect(back[0]).toEqual({ type: "text", text: HANDED_BACK_TEXT });
      expect(back.at(-1)!.type).toBe("image");

      const aborted = new AbortController();
      const gaveUp = computerTool({ box: boxConfig("u-admin")!, bot, thread, signal: aborted.signal }).computer;
      state.control = "person";
      const waiting = gaveUp.execute({ action: "left_click", coordinate: [5, 5] }, "c3");
      await untilWaiting();
      aborted.abort();
      expect(await waiting).toBe(PERSON_HAS_CONTROL_TEXT);
      const before = listMessages(thread.id).length;
      state.control = "free";
      await tellHandedBack("u-admin", "b-someone-else");
      expect(listMessages(thread.id)).toHaveLength(before);
      await tellHandedBack("u-admin", bot.id);
      const told = listMessages(thread.id).slice(before);
      expect(told.map((m) => [m.author, m.kind])).toEqual([["system", "prompt"]]);
      expect(told[0]!.body).toContain("given it back");

      await releaseComputer("u-admin", thread.id, { botId: bot.id });
      tookControl("u-admin", bot.id);
      expect(handedBack("u-admin", bot.id)).toEqual([]);
      const { markDriving } = await import("../src/desktop.ts");
      markDriving("u-admin", { botId: bot.id, threadId: thread.id });
      tookControl("u-admin", "b-someone-else");
      expect(handedBack("u-admin", "b-someone-else")).toEqual([]);
      tookControl("u-admin", bot.id);
      await stopThread(thread.id, { quiet: true });
      expect(handedBack("u-admin", bot.id)).toEqual([]);
      await releaseComputer("u-admin", thread.id);
      deleteBot(bot.id);
    });
  });

  test("share posts the batch's last screenshot in the conversation, and only when asked", async () => {
    await withBox(async () => {
      const { createBot, deleteBot } = await import("../src/data/bots.ts");
      const { getThread, listMessages } = await import("../src/data/threads.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool } = await import("../src/computer-tool.ts");
      const { releaseComputer } = await import("../src/desktop.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Cart", approval: "full" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      const { browser } = computerTool({ box: boxConfig("u-admin")!, bot, thread, message: { depth: 0 } });
      const before = listMessages(thread.id).length;
      await browser.execute({ actions: [{ type: "screenshot" }] }, "c1");
      expect(listMessages(thread.id)).toHaveLength(before);
      const answer = (await browser.execute({ actions: [{ type: "screenshot" }], view: "text", share: "Your cart, nothing placed yet" }, "c2")) as { type: string; text?: string }[];
      expect(answer.at(-1)!.text).toContain("Shared this screenshot");
      const posted = listMessages(thread.id).slice(before);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.author).toBe(bot.id);
      expect(posted[0]!.body).toBe("Your cart, nothing placed yet");
      expect(posted[0]!.attachments.map((a) => a.mediaType)).toEqual([expect.stringMatching(/^image\//)]);

      const { send_screenshot } = computerTool({ box: boxConfig("u-admin")!, bot, thread, message: { depth: 0 } });
      expect(await send_screenshot.execute({ caption: "" }, "c3")).toContain("NOT sent");
      const sentBefore = listMessages(thread.id).length;
      expect(await send_screenshot.execute({ caption: "Order received", target: "desktop" }, "c4")).toContain("Shared this screenshot");
      const shot = listMessages(thread.id).slice(sentBefore);
      expect(shot.map((m) => m.body)).toEqual(["Order received"]);
      expect(shot[0]!.attachments).toHaveLength(1);
      await releaseComputer("u-admin", thread.id);
      deleteBot(bot.id);
    });
  });

  test("a lock the box still holds for bots nobody runs is given back to the person", async () => {
    await withBox(async ({ state }) => {
      const { desktopState, driversOf } = await import("../src/desktop.ts");
      expect(driversOf("u-admin")).toEqual([]);
      state.control = "bots";
      expect((await desktopState("u-admin")).screens).toEqual([{ botId: "b1", running: true, ready: true, width: 2048, height: 1280, viewers: 0, control: "free" }]);
      expect(state.controlCalls.at(-1)).toEqual({ holder: "free", from: "bots" });
      expect(state.controlBots.at(-1)).toBe("b1");
    });
  });

  test("a photo the person sends is saved in the bot's inbox, shown as a small copy, and named in the prompt", async () => {
    await withBox(async ({ state }) => {
      const { createBot, deleteBot, listBots } = await import("../src/data/bots.ts");
      const { getThread, postMessage, storeAttachment } = await import("../src/data/threads.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { deliverAttachments } = await import("../src/inbox.ts");
      const { promptFor } = await import("../src/responder.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Looker" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      const photo = storeAttachment({ name: "20261019_144246.jpg", mediaType: "image/jpeg", data: new Uint8Array(6 * 1024 * 1024).fill(7) });
      const pdf = storeAttachment({ name: "menu.pdf", mediaType: "application/pdf", data: new TextEncoder().encode("%PDF-1.4") });
      const zip = storeAttachment({ name: "../site.zip", mediaType: "application/zip", data: new Uint8Array([1, 2, 3]) });
      const message = postMessage({ threadId: thread.id, author: "you", body: "", attachments: [photo, pdf, zip] });

      const { files, inline } = await deliverAttachments(boxConfig("u-admin")!, bot, message);
      const photoPath = `.bots/${bot.id}/inbox/${photo.id.replace(/^f-/, "").slice(0, 8)}-20261019_144246.jpg`;
      expect(state.uploads.get(photoPath)?.byteLength).toBe(6 * 1024 * 1024);
      expect([...state.uploads.keys()].some((path) => path.endsWith("-site.zip") && !path.includes(".."))).toBe(true);
      expect(state.previews).toEqual([{ path: photoPath, type: "image/jpeg" }]);
      expect(inline).toEqual([
        { name: "20261019_144246.jpg", mediaType: "image/jpeg", data: "c21hbGw=" },
        { name: "menu.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") },
      ]);
      expect(files.map((f) => f.shown)).toEqual([true, true, false]);

      const prompt = promptFor(bot, thread, message, listBots({ userId: "u-admin" }), files);
      expect(prompt).toContain("The message came with 3 files");
      expect(prompt).toContain("-20261019_144246.jpg (image/jpeg, 6.0 MB): the picture is shown to you with this message");
      expect(prompt).toContain("-site.zip (application/zip, 1 KB): open it with your tools");

      const elsewhere = await deliverAttachments(boxConfig("u-admin")!, bot, message, undefined, { pdf: false });
      expect(elsewhere.inline.map((file) => file.name)).toEqual(["20261019_144246.jpg"]);
      expect(elsewhere.files.map((f) => f.shown)).toEqual([true, false, false]);
      deleteBot(bot.id);
    });
  });

  test("the browser and the desktop share one approval per reply, and a bad batch is the tool's answer", async () => {
    await withBox(async ({ state }) => {
      const { createBot, deleteBot } = await import("../src/data/bots.ts");
      const { getThread, listMessages } = await import("../src/data/threads.ts");
      const { decide } = await import("../src/approvals.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool } = await import("../src/computer-tool.ts");
      const { releaseComputer } = await import("../src/desktop.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Shopper", approval: "ask" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      const tools = computerTool({ box: boxConfig("u-admin")!, bot, thread });
      const pending = tools.browser.execute({ actions: [{ type: "navigate", url: "example.com" }, { type: "click", x: 640, y: 400 }] }, "b1");
      await openCard(bot.threadId);
      const card = listMessages(bot.threadId).at(-1)!;
      expect(card.body).toBe("Use the computer (the browser on Shopper's screen)");
      decide(card.approvalId!, { decision: "allow" });
      const page = (await pending) as { type: string; text?: string }[];
      expect(page[0]!.text).toBe("Page 1280x800: Example at https://example.com/\nAll 2 actions ran.");
      expect(state.batches.at(-1)).toEqual({ bot: bot.id, target: "browser", steps: [{ type: "navigate", url: "example.com" }, { type: "click", x: 640, y: 400 }] });
      const asked = listMessages(bot.threadId).length;
      await tools.computer.execute({ actions: [{ type: "key", key: "Escape" }] }, "b2");
      expect(listMessages(bot.threadId)).toHaveLength(asked);
      expect(String(await tools.browser.execute({ actions: [{ type: "bogus" }] }, "b3"))).toContain("no such type");
      expect(String(await tools.computer.execute({ actions: [{ type: "back" }] }, "b4"))).toContain("browser tool");
      expect(String(await tools.computer.execute({ actions: [{ type: "type_login", name: "NOPE" }] }, "b5"))).toContain("NOT typed");
      await releaseComputer("u-admin", thread.id, { botId: bot.id });
      deleteBot(bot.id);
    });
  });

  test("an engine that takes no pictures gets the screenshot as a file in the bot's home", async () => {
    await withBox(async ({ state }) => {
      const { createBot, deleteBot } = await import("../src/data/bots.ts");
      const { getThread } = await import("../src/data/threads.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool } = await import("../src/computer-tool.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Blind", approval: "full" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      const tool = computerTool({ box: boxConfig("u-admin")!, bot, thread, imageResults: false }).computer;
      expect(await tool.execute({ actions: [{ type: "screenshot" }] }, "c1")).toBe(`Screenshot 1024x640 (screen 2048x1280)\nThe screenshot is saved to ~/.bots/${bot.id}/screen.png.`);
      expect(state.batches.at(-1)).toEqual({ bot: bot.id, target: "desktop", steps: [{ type: "screenshot" }], saveTo: `.bots/${bot.id}/screen.png` });
      deleteBot(bot.id);
    });
  });

  test("the lock is freed when the last driver leaves, and the desktop event reaches only its owner", async () => {
    await withBox(async ({ state }) => {
      await seedUsers(["u-other", "user"]);
      const { markDriving, releaseComputer, driversOf, desktopState } = await import("../src/desktop.ts");
      const { subscribe } = await import("../src/events.ts");
      const { eventsRoutes } = await import("../src/routes/events.ts");
      const { Hono } = await import("hono");
      const seen: { userId: string }[] = [];
      const stop = subscribe((event) => {
        if (event.topic === "desktop") seen.push(event);
      });
      const reader = async (who: string) => {
        const app = asPerson(new Hono(), who);
        app.route("/api", eventsRoutes());
        const controller = new AbortController();
        const res = await app.request("/api/events", { signal: controller.signal });
        const decoder = new TextDecoder();
        let text = "";
        const read = res.body!.getReader();
        const pump = (async () => {
          for (;;) {
            const { value, done } = await read.read();
            if (done) break;
            text += decoder.decode(value);
          }
        })().catch(() => undefined);
        return { text: () => text, close: () => (controller.abort(), pump) };
      };
      const owner = await reader("u-admin");
      const other = await reader("u-other");
      try {
        state.control = "bots" as typeof state.control;
        expect(markDriving("u-admin", { botId: "b1", threadId: "t1" })).toBe(true);
        expect(markDriving("u-admin", { botId: "b1", threadId: "t1" })).toBe(false);
        expect(markDriving("u-admin", { botId: "b1", threadId: "t-room" })).toBe(true);
        expect(markDriving("u-admin", { botId: "b2", threadId: "t2" })).toBe(true);
        const before = state.controlCalls.length;
        await releaseComputer("u-admin", "t1", { botId: "b1" });
        expect(driversOf("u-admin")).toEqual([{ botId: "b1", threadId: "t-room" }, { botId: "b2", threadId: "t2" }]);
        expect(state.controlCalls).toHaveLength(before);
        expect(state.control as string).toBe("bots");
        await releaseComputer("u-admin", "t2");
        expect(state.controlBots.slice(before)).toEqual(["b2"]);
        await releaseComputer("u-admin", "t-room");
        expect(driversOf("u-admin")).toEqual([]);
        expect(state.controlCalls.at(-1)).toEqual({ holder: "free", from: "bots" });
        expect(state.controlBots.slice(before)).toEqual(["b2", "b1"]);
        expect(state.control as string).toBe("free");
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(seen.every((event) => event.userId === "u-admin")).toBe(true);
        expect((await desktopState("u-admin")).screens[0]!.control).toBe("free");
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(owner.text()).toContain('"topic":"desktop"');
        expect(other.text()).not.toContain('"topic":"desktop"');
      } finally {
        stop();
        await owner.close();
        await other.close();
      }
    });
  });

  test("the control route hands a bot's screen to the person and back, never to the bots, and only for their own bot", async () => {
    await withBox(async ({ state }) => {
      await seedUsers(["u-screen-other", "user"]);
      const { boxRoutes } = await import("../src/routes/box.ts");
      const { createBot, deleteBot } = await import("../src/data/bots.ts");
      const { botInputSchema } = await import("@gond/shared");
      const { Hono } = await import("hono");
      const bot = createBot(botInputSchema.parse({ name: "Screen Owner" }), "u-admin");
      state.bot = bot.id;
      const app = asPerson(new Hono(), "u-admin");
      app.route("/api", boxRoutes());
      const control = (holder: string) => app.request(`/api/box/desktop/${bot.id}/control`, { method: "POST", body: JSON.stringify({ holder }) });
      expect((await control("bots")).status).toBe(400);
      const taken = await control("person");
      expect(taken.status).toBe(200);
      expect(((await taken.json()) as { desktop: { screens: { botId: string; control: string }[]; drivers: unknown[] } }).desktop).toMatchObject({ screens: [{ botId: bot.id, control: "person" }], drivers: [] });
      expect(state.control).toBe("person");
      expect(state.controlBots.at(-1)).toBe(bot.id);
      const freed = await control("free");
      expect(((await freed.json()) as { desktop: { screens: { control: string }[] } }).desktop.screens[0]!.control).toBe("free");
      const status = await app.request("/api/box/desktop");
      expect(((await status.json()) as { desktop: { screens: { running: boolean }[] } }).desktop.screens[0]).toMatchObject({ running: true });
      const stranger = asPerson(new Hono(), "u-screen-other").route("/api", boxRoutes());
      expect((await stranger.request(`/api/box/desktop/${bot.id}/control`, { method: "POST", body: JSON.stringify({ holder: "person" }) })).status).toBe(404);
      deleteBot(bot.id);
    });
  });

  test("a batch waits while every screen is in use, and the bot hears so if none frees up", async () => {
    await withBox(async ({ state }) => {
      const { createBot, deleteBot } = await import("../src/data/bots.ts");
      const { getThread } = await import("../src/data/threads.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { computerTool, SCREENS_FULL_TEXT } = await import("../src/computer-tool.ts");
      const { releaseComputer } = await import("../src/desktop.ts");
      const { botInputSchema } = await import("@gond/shared");
      const bot = createBot(botInputSchema.parse({ name: "Queued", approval: "full" }), "u-admin");
      const thread = getThread(bot.threadId)!;
      state.full = 1;
      const shot = (await computerTool({ box: boxConfig("u-admin")!, bot, thread }).computer.execute({ actions: [{ type: "screenshot" }] }, "c1")) as unknown[];
      expect(shot).toHaveLength(2);
      expect(state.primaries.at(-1)).toBe(false);
      state.full = 1_000;
      const stop = new AbortController();
      const waiting = computerTool({ box: boxConfig("u-admin")!, bot, thread, signal: stop.signal }).computer.execute({ actions: [{ type: "screenshot" }] }, "c2");
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop.abort();
      expect(await waiting).toBe(SCREENS_FULL_TEXT);
      await releaseComputer("u-admin", thread.id);
      deleteBot(bot.id);
    });
  });
});

describe("cards that expire", () => {
  test("a restart sends what was being answered back to wait, marked as cut off, and expires the open cards", async () => {
    const { createApproval, getApproval } = await import("../src/data/approvals.ts");
    const { createSecretRequest, getSecretRequest } = await import("../src/data/secrets.ts");
    const { postMessage, getMessage } = await import("../src/data/threads.ts");
    const { createBot } = await import("../src/data/bots.ts");
    const { ensureDatabase, releaseClaims } = await import("../src/db/init.ts");
    const { takeInterrupted } = await import("../src/resume.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Cut Off" }), "u-admin");
    const card = createApproval({ botId: bot.id, threadId: bot.threadId, tool: "Bash", summary: "Run: ls", input: { command: "ls" } });
    const login = createSecretRequest({ botId: bot.id, threadId: bot.threadId, name: "ROUTER", reason: "to add DHCP reservations", target: "login", site: "TP-Link router", fields: [{ name: "ROUTER_PASSWORD", label: "Password", kind: "password" }] });
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "Add the DHCP reservations" });
    ensureDatabase().query("UPDATE gond_messages SET claimed_by = 'old-api' WHERE id = ?").run(asked.id);

    releaseClaims(ensureDatabase());
    expect(getApproval(card.id)?.status).toBe("expired");
    expect(getSecretRequest(login.id)?.status).toBe("expired");
    expect((ensureDatabase().query("SELECT claimed_by FROM gond_messages WHERE id = ?").get(asked.id) as { claimed_by: string | null }).claimed_by).toBeNull();
    expect(getMessage(asked.id)).toBeTruthy();
    expect(takeInterrupted(asked.id)).toContain("you were cut off");
    expect(takeInterrupted(asked.id)).toBeNull();
  });

  test("a turn the computer cut off waits and is answered again once it's back, told what already ran", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@gond/shared");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { botTurn, computerAway } = await import("../src/responder.ts");
    let up = false;
    const prompts: string[] = [];
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ ok: true, agents: 0, updating: !up });
        if (!path.endsWith("/turn")) return Response.json({});
        const body = (await request.json()) as { prompt: string };
        prompts.push(body.prompt);
        const result = up ? { type: "result", ok: true, text: "The reservations are in.", stopReason: null, recovered: false } : { type: "result", ok: false, text: "", error: "The box closed the turn", stopReason: null, recovered: false };
        return new Response(`data: ${JSON.stringify(result)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      const bot = createBot(botInputSchema.parse({ name: "Resumer" }), "u-resume");
      const thread = getThread(bot.threadId)!;
      const asked = postMessage({ threadId: thread.id, author: "you", body: "Add the DHCP reservations" });
      const state = () => ensureDatabase().query("SELECT answered_at, claimed_by FROM gond_messages WHERE id = ?").get(asked.id) as { answered_at: string | null; claimed_by: string | null };

      expect(await botTurn(bot, thread, asked)).toBe("");
      expect(state()).toEqual({ answered_at: null, claimed_by: null });
      expect(computerAway()).toBe(true);
      expect(listMessages(thread.id).filter((m) => m.id !== asked.id)).toEqual([]);

      up = true;
      (globalThis as { __gondComputerAway?: number }).__gondComputerAway = 0;
      expect(await botTurn(bot, thread, asked)).toBe("The reservations are in.");
      expect(prompts.at(-1)).toContain("you were cut off");
      expect(state().answered_at).not.toBeNull();
    } finally {
      fake.stop(true);
      if (boxUrl === undefined) delete process.env.GOND_BOX_URL;
      else process.env.GOND_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.GOND_BOX_TOKEN;
      else process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("a card that times out says so in a fixed line and ends the turn; a stopped one says nothing", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { askApproval, endTurnOnExpiry, CARD_EXPIRED_LINE } = await import("../src/approvals.ts");
    const { requestSecret } = await import("../src/secret-requests.ts");
    const { stopCauseOf, unansweredEnding } = await import("../src/responder.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Waiter", approval: "ask" }), "u-admin");
    const lines = () => listMessages(bot.threadId).filter((m) => m.author === bot.id && m.kind === "message").map((m) => m.body);
    jest.useFakeTimers();
    try {
      const turn = new AbortController();
      endTurnOnExpiry(turn.signal, () => turn.abort("expired"));
      const asking = askApproval({ bot, threadId: bot.threadId, tool: "Bash", input: { command: "sudo reboot" }, signal: turn.signal });
      jest.advanceTimersByTime(15 * 60_000);
      expect((await asking).decision).toBe("expired");
      expect(lines()).toEqual([CARD_EXPIRED_LINE]);
      expect(stopCauseOf(turn.signal)).toBe("expired");
      expect(unansweredEnding("Waiter", "expired", "x")).toEqual({ event: null, incident: false });

      const login = requestSecret({ bot, threadId: bot.threadId, name: "ROUTER", reason: "to add reservations", target: "login", site: "Router", fields: [{ name: "ROUTER_PASSWORD", label: "Password", kind: "password" }] });
      jest.advanceTimersByTime(15 * 60_000);
      expect(await login).toBe("expired");
      expect(lines()).toEqual([CARD_EXPIRED_LINE, CARD_EXPIRED_LINE]);

      const stopped = new AbortController();
      const asked = askApproval({ bot, threadId: bot.threadId, tool: "Bash", input: { command: "sudo ls" }, signal: stopped.signal });
      stopped.abort("stopped");
      expect((await asked).decision).toBe("expired");
      expect(lines()).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("changing a secret", () => {
  test("the person replaces a saved value without ever seeing the old one, and it is encrypted afresh", async () => {
    await seedUsers(["u-sec-a", "user"], ["u-sec-b", "user"]);
    const { Hono } = await import("hono");
    const { setSecret, readSecret, readLogin, listSecrets } = await import("../src/data/secrets.ts");
    const { holdLogin, heldLogin } = await import("../src/logins.ts");
    const { createBot } = await import("../src/data/bots.ts");
    const { secretsRoutes } = await import("../src/routes/secrets.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Keyholder" }), "u-sec-a");
    setSecret("u-sec-a", "CURA_TOKEN", "old-token-123456", bot.id);
    setSecret("u-sec-a", "UBER_EATS_PASSWORD", "old-password-1", bot.id, "Uber Eats");
    holdLogin(bot.threadId, "UBER_EATS_PASSWORD", "old-password-1");
    const stored = (name: string) => (ensureDatabase().query("SELECT value FROM gond_secrets WHERE user_id = 'u-sec-a' AND name = ?").get(name) as { value: string }).value;
    const before = stored("CURA_TOKEN");
    const mine = asPerson(new Hono(), "u-sec-a").route("/api", secretsRoutes());
    const put = (app: typeof mine, name: string, value: unknown) => app.request(`/api/secrets/${name}`, { method: "PUT", body: JSON.stringify({ value }) });

    const changed = await put(mine, "CURA_TOKEN", "new-token-654321");
    expect(changed.status).toBe(200);
    expect(await changed.text()).not.toContain("token");
    expect(readSecret("u-sec-a", "CURA_TOKEN")).toBe("new-token-654321");
    expect(stored("CURA_TOKEN")).not.toBe(before);
    expect(stored("CURA_TOKEN")).not.toContain("new-token");

    expect((await put(mine, "UBER_EATS_PASSWORD", "new-password-2")).status).toBe(200);
    expect(readLogin("u-sec-a", "UBER_EATS_PASSWORD")).toBe("new-password-2");
    expect(listSecrets("u-sec-a").find((s) => s.name === "UBER_EATS_PASSWORD")).toMatchObject({ site: "Uber Eats", requestedBy: bot.id });
    expect(heldLogin(bot.threadId, "UBER_EATS_PASSWORD")).toBeNull();

    expect((await put(mine, "NEVER_SAVED", "x")).status).toBe(404);
    expect((await put(mine, "CURA_TOKEN", "")).status).toBe(400);
    const theirs = asPerson(new Hono(), "u-sec-b").route("/api", secretsRoutes());
    expect((await put(theirs, "CURA_TOKEN", "hijack")).status).toBe(404);
    expect(readSecret("u-sec-a", "CURA_TOKEN")).toBe("new-token-654321");
    expect(JSON.stringify(await (await mine.request("/api/secrets")).json())).not.toContain("new-token");
  });
});

describe("bot templates", () => {
  test("a bot goes out as a .bot file or a link with its job, look, routines and their skills, and comes back no more trusting than Auto", async () => {
    await seedUsers(["u-tpl-a", "user"], ["u-tpl-b", "user"]);
    const { Hono } = await import("hono");
    const { createBot, listBots, setBotAvatar, getBotAvatar } = await import("../src/data/bots.ts");
    const { createSkill, listSkills } = await import("../src/data/skills.ts");
    const { createRoutine, listRoutines } = await import("../src/data/routines.ts");
    const { botsRoutes } = await import("../src/routes/bots.ts");
    const { unpackBot } = await import("../src/bot-bundle.ts");
    const { botInputSchema } = await import("@gond/shared");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const patch = createBot(botInputSchema.parse({ name: "Patch", title: "Servers", description: "Keeps the Proxmox cluster healthy.", color: "#11998A", approval: "full" }), "u-tpl-a");
    setBotAvatar(patch.id, png);
    const skill = createSkill("u-tpl-a", { name: "Proxmox health", description: "Checks every node", instructions: "Run pvesh get /nodes and read it." });
    createRoutine(patch.id, { name: "Nightly backup check", cron: "0 2 * * *", timezone: "UTC", prompt: "Check last night's backups.", enabled: true, watch: false, skillId: skill.id });
    const mine = asPerson(new Hono(), "u-tpl-a").route("/api", botsRoutes());
    const theirs = asPerson(new Hono(), "u-tpl-b").route("/api", botsRoutes());

    const file = await mine.request(`/api/bots/${patch.id}/template`);
    expect(file.headers.get("content-disposition")).toContain('filename="patch.bot"');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const bundle = unpackBot(bytes);
    if ("error" in bundle) throw new Error(bundle.error);
    expect(bundle.bot).toMatchObject({ name: "Patch", title: "Servers", approval: "full", routines: [{ name: "Nightly backup check", skill: skill.slug }] });
    expect([...bundle.skills.keys()]).toEqual([skill.slug]);
    expect(JSON.stringify(bundle.bot)).not.toContain(patch.id);
    expect((await theirs.request(`/api/bots/${patch.id}/template`)).status).toBe(404);

    const form = new FormData();
    form.append("file", new File([bytes], "patch.bot"));
    const added = await theirs.request("/api/bots/import", { method: "POST", body: form });
    expect(added.status).toBe(201);
    const copy = ((await added.json()) as { bot: { id: string; name: string; approval: string; userId: string } }).bot;
    expect(copy).toMatchObject({ name: "Patch", approval: "auto", userId: "u-tpl-b" });
    expect(getBotAvatar(copy.id)?.mediaType).toBe("image/png");
    const imported = listSkills("u-tpl-b").find((s) => s.slug === skill.slug)!;
    expect(imported.instructions).toBe("Run pvesh get /nodes and read it.");
    expect(listRoutines(copy.id)).toMatchObject([{ name: "Nightly backup check", enabled: false, skillId: imported.id }]);

    const link = ((await (await mine.request(`/api/bots/${patch.id}/share`, { method: "POST" })).json()) as { url: string }).url;
    const token = new URL(link).searchParams.get("template")!;
    expect(((await (await mine.request(`/api/bots/${patch.id}/share`, { method: "POST" })).json()) as { url: string }).url).toBe(link);
    expect(((await (await theirs.request(`/api/templates/${token}`)).json()) as { template: unknown }).template).toEqual({ name: "Patch", title: "Servers", description: "Keeps the Proxmox cluster healthy.", color: "#11998A", expression: "happy", shape: "cog", picture: true, skills: [skill.slug], routines: ["Nightly backup check"] });
    const again = await theirs.request(`/api/templates/${token}`, { method: "POST" });
    expect(((await again.json()) as { bot: { name: string } }).bot.name).toBe("Patch 2");
    expect(listSkills("u-tpl-b").filter((s) => s.slug.startsWith(skill.slug))).toHaveLength(1);
    expect((await theirs.request("/api/templates/not-a-real-token", { method: "POST" })).status).toBe(404);

    const junk = new FormData();
    junk.append("file", new File([new Uint8Array([1, 2, 3])], "x.bot"));
    expect((await theirs.request("/api/bots/import", { method: "POST", body: junk })).status).toBe(400);
    expect(listBots({ userId: "u-tpl-b" }).filter((b) => b.name.startsWith("Patch"))).toHaveLength(2);
  });
});

describe("updating Gond", () => {
  test("a recreated container takes its new image's settings, and the API is replaced by a helper", async () => {
    const { recreateContainer, replaceSelf } = await import("../src/docker.ts");
    const { releaseNotes } = await import("../src/release.ts");
    const socket = `${process.env.GOND_DATA_DIR}/docker.sock`;
    const seen: { method: string; path: string; body: unknown }[] = [];
    const server = Bun.serve({
      unix: socket,
      async fetch(request: Request) {
        const url = new URL(request.url);
        const text = await request.text();
        seen.push({ method: request.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : null });
        if (url.pathname === "/images/sha256%3Aold/json") return Response.json({ Config: { Env: ["PATH=/usr/bin", "GOND_VERSION=0.2.45"], Cmd: ["bun", "run", "src/index.ts"], WorkingDir: "/app/apps/api", Labels: { "org.opencontainers.image.version": "0.2.45" } } });
        if (url.pathname.startsWith("/images/")) return Response.json({ Id: "sha256:new" });
        if (url.pathname.startsWith("/containers/create")) return Response.json({ Id: "c-new" });
        return new Response(null, { status: 204 });
      },
    });
    const before = process.env.GOND_DOCKER_SOCK;
    process.env.GOND_DOCKER_SOCK = socket;
    try {
      const info = {
        Id: "c-old",
        Name: "/gond-api-1",
        Image: "sha256:old",
        Config: { Image: "ghcr.io/dawsja/gond-api:latest", Env: ["PATH=/usr/bin", "GOND_VERSION=0.2.45", "APP_URL=https://gond.home.lan"], Cmd: ["bun", "run", "src/index.ts"], WorkingDir: "/app/apps/api", Labels: { "org.opencontainers.image.version": "0.2.45", "com.docker.compose.service": "api" } },
        HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
        NetworkSettings: { Networks: {} },
        State: { Running: true, Status: "running" },
        Mounts: [{ Source: "/var/run/docker.sock", Destination: socket }],
      };
      await recreateContainer(info, info.Config.Image, () => undefined);
      const created = seen.find((r) => r.path.startsWith("/containers/create"))!.body as Record<string, unknown>;
      expect(created.Env).toEqual(["APP_URL=https://gond.home.lan"]);
      expect(created).not.toHaveProperty("Cmd");
      expect(created).not.toHaveProperty("WorkingDir");
      expect(created.Labels).toEqual({ "com.docker.compose.service": "api" });

      seen.length = 0;
      await replaceSelf(info);
      const helper = seen.find((r) => r.path.startsWith("/containers/create"))!;
      expect(helper.path).toContain("name=gond-api-1-updater");
      expect(helper.body).toMatchObject({ Image: "ghcr.io/dawsja/gond-api:latest", Cmd: ["bun", "run", "src/self-update.ts", "c-old"], HostConfig: { AutoRemove: true, Binds: [`/var/run/docker.sock:${socket}`] } });
      expect(seen.at(-1)!.path).toBe("/containers/c-new/start");
    } finally {
      server.stop(true);
      if (before === undefined) delete process.env.GOND_DOCKER_SOCK;
      else process.env.GOND_DOCKER_SOCK = before;
    }
    expect(releaseNotes(["Show a room as its bots\n\nlong body", "Merge branch 'x'", "Reply to a message by quoting it"])).toEqual(["Reply to a message by quoting it", "Show a room as its bots"]);
  });
});

describe("rooms and a bot's files", () => {
  test("a room is renamed, its bots changed and pinned, and says what changed", async () => {
    await seedUsers(["u-room", "user"], ["u-room-other", "user"]);
    const { Hono } = await import("hono");
    const { createBot } = await import("../src/data/bots.ts");
    const { createRoom, getThread, listMessages } = await import("../src/data/threads.ts");
    const { threadsRoutes, roomChange } = await import("../src/routes/threads.ts");
    const { botInputSchema } = await import("@gond/shared");
    const ada = createBot(botInputSchema.parse({ name: "Ada" }), "u-room");
    const bo = createBot(botInputSchema.parse({ name: "Bo" }), "u-room");
    const cy = createBot(botInputSchema.parse({ name: "Cy" }), "u-room");
    const stranger = createBot(botInputSchema.parse({ name: "Stranger" }), "u-room-other");
    const room = createRoom("Launch", [ada.id, bo.id], "u-room");
    const mine = asPerson(new Hono(), "u-room").route("/api", threadsRoutes());
    const theirs = asPerson(new Hono(), "u-room-other").route("/api", threadsRoutes());
    const json = { "Content-Type": "application/json" };
    const change = (app: typeof mine, body: unknown) => app.request(`/api/rooms/${room.id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });

    expect((await change(theirs, { name: "Mine" })).status).toBe(404);
    // A room left without a name is named after its bots, the one that answers first in front.
    expect((await change(mine, { name: "  " })).status).toBe(200);
    expect(getThread(room.id)!.name).toBe("Ada and Bo");
    const unnamed = await mine.request("/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "", members: [bo.id, cy.id, ada.id] }) });
    expect(unnamed.status).toBe(201);
    expect(((await unnamed.json()) as { thread: { name: string } }).thread.name).toBe("Ada, Bo and Cy");
    expect((await change(mine, { members: [stranger.id] })).status).toBe(400);
    expect((await change(mine, { pinned: "yes" })).status).toBe(400);

    const res = await change(mine, { name: "Launch week", members: [ada.id, cy.id, stranger.id], pinned: true });
    expect(res.status).toBe(200);
    const thread = getThread(room.id)!;
    expect(thread).toMatchObject({ name: "Launch week", pinned: true });
    expect(thread.members.sort()).toEqual([ada.id, cy.id].sort());
    expect(listMessages(room.id).at(-1)!.body).toBe("Renamed to Launch week. Cy joined. Bo left.");
    expect(getThread(ada.threadId)!.pinned).toBe(false);

    await change(mine, { pinned: false });
    expect(getThread(room.id)!.pinned).toBe(false);
    expect(listMessages(room.id).at(-1)!.body).toBe("Renamed to Launch week. Cy joined. Bo left.");
    expect(roomChange({ name: "A", members: [] }, { name: "A", members: ["1", "2", "3"] }, (id) => `Bot ${id}`)).toBe("Bot 1, Bot 2 and Bot 3 joined.");
    expect(roomChange({ name: "A", members: ["1", "2"] }, { name: "A", members: ["2", "3"] }, (id) => `Bot ${id}`, ["Bot 1", "Bot 2"])).toBe("Bot 3 joined. Bot 1 left. Bot 2 answers now when nobody's named.");

    const { answererOf } = await import("../src/routes/threads.ts");
    const it = createRoom("IT", [bo.id, cy.id], "u-room");
    expect(answererOf(it.members, [ada, bo, cy])).toBe("Bo");
  });

  test("a bot's files are listed and downloaded, never with a stored secret in them", async () => {
    await seedUsers(["u-files", "user"]);
    const { Hono } = await import("hono");
    const { createBot } = await import("../src/data/bots.ts");
    const { setSecret } = await import("../src/data/secrets.ts");
    const { boxRoutes } = await import("../src/routes/box.ts");
    const { botInputSchema } = await import("@gond/shared");
    const files: Record<string, string> = { "notes.md": "Plan: ship on Friday", "keys.txt": "token=files-secret-value-1", "dot.png": "\x89PNG\r\n\x1a\n" };
    const fake = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const url = new URL(request.url);
        const name = (url.searchParams.get("path") ?? "").split("/").pop()!;
        if (url.pathname === "/files" && name === ".") return Response.json({ directory: ["notes.md"], entries: [{ name: "notes.md", dir: false, size: 20, modified: "2026-10-21T10:00:00.000Z" }] });
        if (url.pathname === "/files") return Response.json({ content: files[name], size: files[name]!.length });
        if (url.pathname === "/files/raw") return new Response(name === "dot.png" ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) : files[name], { headers: { "Content-Type": "application/octet-stream" } });
        return new Response("", { status: 404 });
      },
    });
    const boxUrl = process.env.GOND_BOX_URL;
    const boxToken = process.env.GOND_BOX_TOKEN;
    process.env.GOND_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.GOND_BOX_TOKEN = "box-token";
    try {
      setSecret("u-files", "FILES_TOKEN", "files-secret-value-1");
      const bot = createBot(botInputSchema.parse({ name: "Filer" }), "u-files");
      const app = asPerson(new Hono(), "u-files").route("/api", boxRoutes());
      const other = asPerson(new Hono(), "u-files-other").route("/api", boxRoutes());

      const listing = (await (await app.request(`/api/bots/${bot.id}/files?path=.`)).json()) as { file: { entries: unknown[] } };
      expect(listing.file.entries).toEqual([{ name: "notes.md", dir: false, size: 20, modified: "2026-10-21T10:00:00.000Z" }]);
      const shown = (await (await app.request(`/api/bots/${bot.id}/files?path=keys.txt`)).json()) as { file: { content: string } };
      expect(shown.file.content).not.toContain("files-secret-value-1");

      const download = await app.request(`/api/bots/${bot.id}/files/raw?path=notes.md`);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("Plan: ship on Friday");
      expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.md");
      expect(download.headers.get("content-security-policy")).toBe("sandbox");
      expect((await app.request(`/api/bots/${bot.id}/files/raw?path=notes.md&view=1`)).headers.get("content-type")).toBe("application/octet-stream");
      const picture = await app.request(`/api/bots/${bot.id}/files/raw?path=dot.png&view=1`);
      expect(picture.headers.get("content-type")).toBe("image/png");
      expect(picture.headers.get("content-disposition")).toStartWith("inline;");
      expect((await app.request(`/api/bots/${bot.id}/files/raw?path=keys.txt`)).status).toBe(403);
      expect((await app.request(`/api/bots/${bot.id}/files/raw?path=../../etc/passwd`)).status).toBe(400);
      expect((await other.request(`/api/bots/${bot.id}/files/raw?path=notes.md`)).status).toBe(404);
    } finally {
      fake.stop(true);
      if (boxUrl === undefined) delete process.env.GOND_BOX_URL;
      else process.env.GOND_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.GOND_BOX_TOKEN;
      else process.env.GOND_BOX_TOKEN = boxToken;
    }
  });

  test("a page of messages carries the same reactions and quotes as each message read alone", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { getMessage, listMessages, postMessage, recentMessages, setReaction } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Pager" }), "u-admin");
    const asked = postMessage({ threadId: bot.threadId, author: "you", body: "What's the plan?" });
    const answer = postMessage({ threadId: bot.threadId, author: bot.id, body: "Ship on Friday." });
    const reply = postMessage({ threadId: bot.threadId, author: "you", body: "Good.", replyTo: answer.id });
    setReaction(getMessage(answer.id)!, "you", "👍");
    const alone = [asked, answer, reply].map((m) => getMessage(m.id)!);
    const page = listMessages(bot.threadId, { includeSent: true }).filter((m) => alone.some((a) => a.id === m.id));
    expect(page).toEqual(alone);
    expect(page[1]!.reactions.map((r) => r.emoji)).toEqual(["👍"]);
    expect(page[2]!.replyTo?.author).toBe(bot.id);
    expect(recentMessages(bot.threadId, 10).filter((m) => alone.some((a) => a.id === m.id))).toEqual(alone);
  });

  test("a person's conversation ids come without building each conversation", async () => {
    const { listThreads, threadRefs } = await import("../src/data/threads.ts");
    const refs = threadRefs("u-admin");
    expect(refs.map((r) => r.id).sort()).toEqual(listThreads({ userId: "u-admin" }).map((t) => t.id).sort());
    expect(threadRefs("u-nobody")).toEqual([]);
  });

  test("a conversation's change tells only its owner to reload the list", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { subscribe, threadChanged } = await import("../src/events.ts");
    const { botInputSchema } = await import("@gond/shared");
    const bot = createBot(botInputSchema.parse({ name: "Owned" }), "u-admin");
    const heard: unknown[] = [];
    const stop = subscribe((event) => heard.push(event));
    try {
      threadChanged(bot.threadId);
    } finally {
      stop();
    }
    expect(heard).toEqual([{ topic: "thread", threadId: bot.threadId }, { topic: "bots", userId: "u-admin" }]);
  });

  test("bots answering the same line in a room know of each other and don't wake each other again", async () => {
    await seedUsers(["u-infra", "user"]);
    const { createBot } = await import("../src/data/bots.ts");
    const { createRoom, getThread, postMessage } = await import("../src/data/threads.ts");
    const { ensureDatabase } = await import("../src/db/init.ts");
    const { deliverReply, promptFor } = await import("../src/responder.ts");
    const { botInputSchema } = await import("@gond/shared");
    const net = createBot(botInputSchema.parse({ name: "Net", title: "Network" }), "u-infra");
    const patch = createBot(botInputSchema.parse({ name: "Patch", title: "Servers" }), "u-infra");
    const sage = createBot(botInputSchema.parse({ name: "Sage", title: "Research" }), "u-infra");
    const room = createRoom("Infra", [net.id, patch.id, sage.id], "u-infra");
    const thread = getThread(room.id)!;
    const bots = [net, patch, sage];
    const waits = (id: string) => (ensureDatabase().query("SELECT answered_at FROM gond_messages WHERE id = ?").get(id) as { answered_at: string | null }).answered_at === null;

    const both = postMessage({ threadId: room.id, author: "you", body: "@net @patch how's the infra looking?" });
    expect(promptFor(net, thread, both, bots)).toContain("Patch is answering this same message at the same time");
    expect(promptFor(patch, thread, both, bots)).toContain("Net is answering this same message at the same time");

    deliverReply(net, thread, both, "UniFi is healthy. @patch please report on the Proxmox nodes.");
    const netLine = ensureDatabase().query("SELECT id FROM gond_messages WHERE thread_id = ? AND author = ? ORDER BY created_at DESC LIMIT 1").get(room.id, net.id) as { id: string };
    expect(waits(netLine.id)).toBe(false);

    deliverReply(patch, thread, both, "Proxmox is healthy. @sage can you look into backups?");
    const patchLine = ensureDatabase().query("SELECT id FROM gond_messages WHERE thread_id = ? AND author = ? ORDER BY created_at DESC LIMIT 1").get(room.id, patch.id) as { id: string };
    expect(waits(patchLine.id)).toBe(true);

    // A line naming a co-answerer and someone else wakes only the someone else.
    const { answeringOf, getMessage } = await import("../src/data/threads.ts");
    const { activeTurns, wokenBy } = await import("../src/responder.ts");
    const patchMessage = getMessage(patchLine.id)!;
    expect(answeringOf(patchLine.id)?.id).toBe(both.id);
    deliverReply(net, thread, both, "@patch thanks, and @sage can you check the backups?");
    const mixed = getMessage((ensureDatabase().query("SELECT id FROM gond_messages WHERE thread_id = ? AND author = ? ORDER BY created_at DESC LIMIT 1").get(room.id, net.id) as { id: string }).id)!;
    expect(wokenBy(mixed, thread, answeringOf(mixed.id), bots).map((b) => b.name)).toEqual(["Sage"]);
    expect(wokenBy(patchMessage, thread, answeringOf(patchMessage.id), bots).map((b) => b.name)).toEqual(["Sage"]);

    // A bot still answering the same message hears the other's line arrive.
    const heard: string[] = [];
    activeTurns().set("patch-turn", { botId: patch.id, threadId: room.id, userId: "u-infra", messageId: both.id, route: "person", controller: new AbortController(), startedAt: Date.now(), steer: async (text) => (heard.push(text), true) });
    try {
      deliverReply(net, thread, both, "WiFi has 15 clients and the gateway is at 79 °C.");
    } finally {
      activeTurns().delete("patch-turn");
    }
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain("Net just said in the room, answering the same message as you");
    expect(heard[0]).toContain("gateway is at 79 °C");

    const one = postMessage({ threadId: room.id, author: "you", body: "@net is the WiFi ok?" });
    expect(promptFor(net, thread, one, bots)).not.toContain("answering this same message");

    // A line sent while Patch and Sage are still answering reaches them mid-answer, and only Net, idle, needs a turn for it.
    const { postFromPerson } = await import("../src/responder.ts");
    const asked = postMessage({ threadId: room.id, author: "you", body: "Everyone, anything before the weekend?" });
    postMessage({ threadId: room.id, author: net.id, body: "Nothing from the network.", answered: true });
    const got: Record<string, string[]> = { patch: [], sage: [] };
    const fake = (botId: string, key: "patch" | "sage") => ({ botId, threadId: room.id, userId: "u-infra", messageId: asked.id, route: "person" as const, controller: new AbortController(), startedAt: Date.now(), steer: async (text: string) => (got[key]!.push(text), true) });
    activeTurns().set("patch-busy", fake(patch.id, "patch"));
    activeTurns().set("sage-busy", fake(sage.id, "sage"));
    try {
      const followUp = await postFromPerson(thread, { body: "and are the backups ok?" });
      expect(got.patch).toHaveLength(1);
      expect(got.sage).toHaveLength(1);
      expect(followUp.steered).toBe(false);
      expect(waits(followUp.id)).toBe(true);
      const onlyBusy = await postFromPerson(thread, { body: "@patch @sage skip the old snapshots" });
      expect(onlyBusy.steered).toBe(true);
      expect(waits(onlyBusy.id)).toBe(false);
    } finally {
      activeTurns().delete("patch-busy");
      activeTurns().delete("sage-busy");
    }
  });
});
