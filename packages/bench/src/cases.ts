import { handleOf, type Bot, type Message } from "@gond/shared";
import type { startFixtures } from "./fixtures.ts";
import { codeFor } from "./fixtures.ts";
import type { Exchange, Gond } from "./gond.ts";

export type Suite = "chat" | "rooms" | "browser" | "desktop";
export const SUITES: Suite[] = ["chat", "rooms", "browser", "desktop"];

export type Engine = "api" | "claude";

export type Team = { ledger: Bot; atlas: Bot; basil: Bot };

export type Context = {
  gond: Gond;
  fixtures: ReturnType<typeof startFixtures>;
  engine: Engine;
  /** Unique per case run: what fixtures record and what codes are made from. */
  run: string;
  team: () => Promise<Team>;
  operator: () => Promise<Bot>;
};

/** What a case run found: its checks, what the judge should grade, and every line it said. */
export type Outcome = {
  checks: Record<string, boolean>;
  judged?: { conversation: string; rubric: string; answer: string };
  exchanges: Exchange[];
  /** The exchange whose speed the case is about; the last when unset. */
  measured?: number;
  /** For routing: how long until the router's pick, and whether it matched. */
  routeMs?: number | null;
};

export type Case = { suite: Suite; name: string; repeat?: number; run: (ctx: Context) => Promise<Outcome> };

const text = (replies: Message[]) => replies.map((m) => m.body).join("\n\n");
const has = (body: string, pattern: RegExp) => pattern.test(body);
const transcript = (lines: [string, string][]) => lines.map(([who, said]) => `${who}: ${said}`).join("\n\n");

/** A bot made for one case run, greeted and settled first, removed after. */
async function withBot<T>(ctx: Context, input: { title: string; description: string }, work: (bot: Bot) => Promise<T>): Promise<T> {
  const bot = await ctx.gond.createBot({ name: `B${ctx.run.slice(-5)}`, ...input });
  try {
    await ctx.gond.settleGreeting(bot);
    return await work(bot);
  } finally {
    await ctx.gond.deleteBot(bot.id);
  }
}

const ASSISTANT = { title: "Assistant", description: "A general personal assistant: questions, planning, writing and errands." };

async function oneShot(ctx: Context, ask: string, check: (reply: string) => Record<string, boolean>, rubric?: string): Promise<Outcome> {
  return withBot(ctx, ASSISTANT, async (bot) => {
    const exchange = await ctx.gond.say(bot.threadId, ask);
    const reply = text(exchange.replies);
    return { checks: { answered: reply.length > 0, ...check(reply) }, exchanges: [exchange], ...(rubric ? { judged: { conversation: transcript([["Person", ask]]), rubric, answer: reply } } : {}) };
  });
}

const chat: Case[] = [
  {
    suite: "chat",
    name: "short fact",
    run: (ctx) => oneShot(ctx, "What's the capital of Australia? Answer in one word.", (r) => ({ canberra: has(r, /canberra/i), short: r.trim().split(/\s+/).length <= 6 })),
  },
  {
    suite: "chat",
    name: "arithmetic of a day",
    run: (ctx) => oneShot(ctx, "I have a meeting at 9:15 that runs 75 minutes, then a 20 minute walk. What time do I arrive? Just the time.", (r) => ({ time: has(r, /10[:.]50/) })),
  },
  {
    suite: "chat",
    name: "earlier lines",
    run: (ctx) =>
      withBot(ctx, ASSISTANT, async (bot) => {
        const said: [string, string][] = [];
        const exchanges: Exchange[] = [];
        for (const line of ["My sister Maya lands on Thursday at 6:40 pm. Just say OK.", "Also, I'm allergic to peanuts. Just say OK."]) {
          const exchange = await ctx.gond.say(bot.threadId, line);
          exchanges.push(exchange);
          said.push(["Person", line], ["Assistant", text(exchange.replies)]);
        }
        const ask = "Plan dinner for when Maya arrives: a time and one kind of restaurant, keeping in mind everything I told you. Two sentences.";
        const last = await ctx.gond.say(bot.threadId, ask);
        exchanges.push(last);
        said.push(["Person", ask]);
        const reply = text(last.replies);
        return {
          checks: { thursday: has(reply, /thursday/i), peanuts: has(reply, /peanut|nut-free|nut free|allerg/i) },
          exchanges,
          judged: { conversation: transcript(said), rubric: "Dinner is on Thursday after 6:40 pm with time to get from the airport, the restaurant suits a peanut allergy and says so, and it is two sentences.", answer: reply },
        };
      }),
  },
  {
    suite: "chat",
    name: "fact from memory",
    run: (ctx) =>
      withBot(ctx, ASSISTANT, async (bot) => {
        const locker = codeFor(ctx.run, "locker");
        await ctx.gond.call("PUT", `/api/bots/${bot.id}/files`, { path: "MEMORY.md", content: `# Memory\n\n- The person's gym locker code is ${locker}.\n- They prefer metric units.\n` });
        const exchange = await ctx.gond.say(bot.threadId, "What's my gym locker code?");
        return { checks: { code: text(exchange.replies).includes(locker) }, exchanges: [exchange] };
      }),
  },
  {
    suite: "chat",
    name: "right after a memory update",
    run: (ctx) =>
      withBot(ctx, ASSISTANT, async (bot) => {
        const first = await ctx.gond.say(bot.threadId, "Please remember for good: my dentist is Dr. Okafor on Elm Street.");
        const second = await ctx.gond.say(bot.threadId, "Who's my dentist, and where?");
        const reply = text(second.replies);
        const memory = await ctx.gond.call<{ file: { content?: string } }>("GET", `/api/bots/${bot.id}/files?path=MEMORY.md`).catch(() => ({ file: {} as { content?: string } }));
        return { checks: { remembered: has(memory.file.content ?? "", /okafor/i), okafor: has(reply, /okafor/i), elm: has(reply, /elm/i) }, exchanges: [first, second] };
      }),
  },
  {
    suite: "chat",
    name: "line from far back",
    repeat: 2,
    run: (ctx) =>
      withBot(ctx, ASSISTANT, async (bot) => {
        const password = `pinecone-${codeFor(ctx.run, "wifi").slice(3).toLowerCase()}`;
        const exchanges: Exchange[] = [await ctx.gond.say(bot.threadId, `Note for later: the cabin's wifi password is ${password}. Reply with just OK.`)];
        for (let n = 1; n <= 16; n++) exchanges.push(await ctx.gond.say(bot.threadId, `Filler ${n}: ${["the kettle is blue", "the train leaves at noon", "my cat is called Miso", "the plant needs water", "we're out of oat milk", "the meeting moved to Monday", "the car is due a service", "the library book is overdue"][n % 8]}. Reply with just OK.`));
        const last = await ctx.gond.say(bot.threadId, "What's the cabin's wifi password?");
        exchanges.push(last);
        return { checks: { password: text(last.replies).includes(password) }, exchanges };
      }),
  },
  {
    suite: "chat",
    name: "reply style",
    run: async (ctx) => {
      await ctx.gond.call("PUT", "/api/me/talk", { style: "efficient" });
      try {
        return await oneShot(ctx, "What's a VPN and do I need one at home?", (r) => ({ brief: r.split(/\s+/).length <= 120 }), "The person picked the Efficient style: concise and plain. The answer explains what a VPN is and whether a home user needs one, correctly, briefly, without filler or a long list.");
      } finally {
        await ctx.gond.call("PUT", "/api/me/talk", { style: "default" });
      }
    },
  },
  {
    suite: "chat",
    name: "a pick between options",
    run: (ctx) => oneShot(ctx, "I can't decide between a long weekend in Lisbon or Kyoto in late March. Tell me which you'd pick and why, briefly, and let me choose.", (r) => ({ choices: has(r, /::choices\[/) }), "A short recommendation with a real reason tied to late March, and it lets the person choose, ideally with tap-able choices (::choices[Lisbon | Kyoto])."),
  },
  {
    suite: "chat",
    name: "an apology to write",
    run: (ctx) => oneShot(ctx, "Write a two-sentence apology to a customer whose package arrived damaged. We're sending a replacement today.", () => ({}), "Exactly two sentences, a sincere apology for the damaged package, says the replacement ships today, warm and professional, no placeholders."),
  },
  {
    suite: "chat",
    name: "a file in its folder",
    run: (ctx) =>
      withBot(ctx, ASSISTANT, async (bot) => {
        const word = codeFor(ctx.run, "ready");
        const exchange = await ctx.gond.say(bot.threadId, `Create a file named notes.txt in your own folder containing exactly the text ${word}, then tell me it's done.`);
        const file = await ctx.gond.call<{ file: { content?: string } }>("GET", `/api/bots/${bot.id}/files?path=notes.txt`).catch(() => ({ file: {} as { content?: string } }));
        return { checks: { file: (file.file.content ?? "").trim() === word }, exchanges: [exchange] };
      }),
  },
  {
    suite: "chat",
    name: "an app's tool",
    run: async (ctx) => {
      const server = (await ctx.gond.call<{ server: { id: string } }>("POST", "/api/mcp-servers", { name: `orders${ctx.run.slice(-5)}`, transport: "http", url: ctx.fixtures.ordersMcp(ctx.run) })).server;
      try {
        return await withBot(ctx, ASSISTANT, async (bot) => {
          const exchange = await ctx.gond.say(bot.threadId, "Where's my order 5521? Check it with the orders tool.");
          return { checks: { tracking: text(exchange.replies).includes(codeFor(ctx.run, "tracking")), called: ctx.fixtures.mcpCalls(ctx.run).length > 0 }, exchanges: [exchange] };
        });
      } finally {
        await ctx.gond.call("DELETE", `/api/mcp-servers/${server.id}`).catch(() => undefined);
      }
    },
  },
  {
    suite: "chat",
    name: "with a dead app server",
    run: async (ctx) => {
      const server = (await ctx.gond.call<{ server: { id: string } }>("POST", "/api/mcp-servers", { name: `dead${ctx.run.slice(-5)}`, transport: "http", url: ctx.fixtures.deadMcp() })).server;
      try {
        return await oneShot(ctx, "What's 17 times 23? Just the number.", (r) => ({ product: has(r, /391/) }));
      } finally {
        await ctx.gond.call("DELETE", `/api/mcp-servers/${server.id}`).catch(() => undefined);
      }
    },
  },
];

/** Room lines that name nobody, with whom they are for. */
const ROUTES: { line: string; for: (keyof Team)[]; toRoom?: boolean }[] = [
  { line: "Can you find me a flight to Lisbon next Friday?", for: ["atlas"] },
  { line: "How much did we spend on software subscriptions last quarter?", for: ["ledger"] },
  { line: "What can I cook tonight with leftover rice and two eggs?", for: ["basil"] },
  { line: "Draft an invoice for 10 hours of consulting at $120 an hour.", for: ["ledger"] },
  { line: "I need a hotel near the Louvre for two nights in May.", for: ["atlas"] },
  { line: "Give me a vegetarian lasagna recipe.", for: ["basil"] },
  { line: "Make me a grocery list for a week of simple dinners.", for: ["basil"] },
  { line: "Is it worth getting travel insurance for a week in Japan?", for: ["atlas"] },
  { line: "Can you reconcile my credit card statement against the receipts folder?", for: ["ledger"] },
  { line: "howdy everyone, how's it going today?", for: ["ledger", "atlas", "basil"], toRoom: true },
];

async function routeOne(ctx: Context, line: string, expected: (keyof Team)[], toRoom = false): Promise<Outcome> {
  const team = await ctx.team();
  const room = await ctx.gond.room(`Route ${ctx.run.slice(-5)}`, [team.ledger.id, team.atlas.id, team.basil.id]);
  await ctx.gond.listen();
  const woken = new Set<string>();
  let firstWake: number | null = null;
  const off = ctx.gond.on((event, at) => {
    if (event.topic === "activity" && event.threadId === room.id && event.line) {
      woken.add(event.botId);
      firstWake ??= at;
    }
  });
  try {
    const started = performance.now();
    const sent = (await ctx.gond.call<{ message: Message }>("POST", `/api/threads/${room.id}/messages`, { body: line })).message;
    let picked: string[] | null = null;
    let pickedAt: number | null = null;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const now = (await ctx.gond.messages(room.id)).find((m) => m.id === sent.id);
      if (now?.sentTo?.length) {
        picked = now.sentTo;
        pickedAt = performance.now();
        break;
      }
      if (firstWake !== null && performance.now() - firstWake > 2000) break;
      await Bun.sleep(100);
    }
    await Bun.sleep(1500);
    const chosen = picked ?? [...woken];
    const want = expected.map((key) => team[key].id).sort();
    const got = [...new Set(chosen)].sort();
    await ctx.gond.call("POST", `/api/threads/${room.id}/interrupt`).catch(() => undefined);
    const routeMs = pickedAt !== null ? pickedAt - started : firstWake !== null ? firstWake - started : null;
    // A line to the whole room names everyone, so by design it skips the router.
    return { checks: { ...(toRoom ? {} : { routed: picked !== null }), right: JSON.stringify(want) === JSON.stringify(got) }, exchanges: [], routeMs };
  } finally {
    off();
    await Bun.sleep(1000);
    await ctx.gond.call("DELETE", `/api/rooms/${room.id}`).catch(() => undefined);
  }
}

const rooms: Case[] = [
  ...ROUTES.map((route, n): Case => ({ suite: "rooms", name: `route ${n + 1}`, run: (ctx) => routeOne(ctx, route.line, route.for, route.toRoom) })),
  {
    suite: "rooms",
    name: "two bots split a task",
    run: async (ctx) => {
      const team = await ctx.team();
      const room = await ctx.gond.room(`Naples ${ctx.run.slice(-5)}`, [team.atlas.id, team.basil.id]);
      try {
        const ask = `@${handleOf(team.atlas.name)} and @${handleOf(team.basil.name)}: plan a food-focused day in Naples. ${team.atlas.name}, give the route through the day; ${team.basil.name}, the three dishes to try and where. Keep each part short.`;
        const exchange = await ctx.gond.say(room.id, ask, { expectTurns: 2 });
        const authors = new Set(exchange.replies.map((m) => m.author));
        return {
          checks: { both: authors.has(team.atlas.id) && authors.has(team.basil.id) },
          exchanges: [exchange],
          judged: { conversation: transcript([["Person", ask]]), rubric: "Atlas gives a sensible route through a day in Naples and Basil names three real Neapolitan dishes with where to try them; each covers only its own part, short, and nothing contradicts the other.", answer: exchange.replies.map((m) => `${m.author === team.atlas.id ? team.atlas.name : team.basil.name}: ${m.body}`).join("\n\n") },
        };
      } finally {
        await ctx.gond.call("DELETE", `/api/rooms/${room.id}`).catch(() => undefined);
      }
    },
  },
];

/** A browser task for the shared operator bot; the page records what it did. */
async function browse(ctx: Context, ask: string, check: (reply: string) => Record<string, boolean>): Promise<Outcome> {
  const bot = await ctx.operator();
  const exchange = await ctx.gond.say(bot.threadId, ask, { timeoutMs: 600_000 });
  const reply = text(exchange.replies);
  return { checks: { used_screen: exchange.turns.some((t) => t.timing.screen > 0), ...check(reply) }, exchanges: [exchange] };
}

const browser: Case[] = [
  {
    suite: "browser",
    name: "cold screen",
    run: (ctx) =>
      withBot(ctx, { title: "Operator", description: "Does things on websites and the computer's desktop for the person." }, async (bot) => {
        const exchange = await ctx.gond.say(bot.threadId, `Open ${ctx.fixtures.url("/shop/p/k4", ctx.run)} in your browser and tell me the product code on it.`, { timeoutMs: 600_000 });
        return { checks: { code: text(exchange.replies).includes(codeFor(ctx.run, "k4")) }, exchanges: [exchange] };
      }),
  },
  {
    suite: "browser",
    name: "search and open",
    run: (ctx) => browse(ctx, `In your browser, go to ${ctx.fixtures.url("/shop", ctx.run)}, search for "blue kettle", open the cheapest one and tell me its product code.`, (r) => ({ code: r.includes(codeFor(ctx.run, "k2")) })),
  },
  {
    suite: "browser",
    name: "fill a form",
    run: async (ctx) => {
      const outcome = await browse(ctx, `In your browser, open ${ctx.fixtures.url("/form", ctx.run)} and sign me up: name Ada Byron, email ada@example.com, country Portugal, monthly, agree to the terms, and submit it.`, () => ({}));
      const sent = ctx.fixtures.submission(ctx.run)?.fields ?? {};
      return { ...outcome, checks: { ...outcome.checks, submitted: Boolean(ctx.fixtures.submission(ctx.run)), name: sent.name === "Ada Byron", email: sent.email === "ada@example.com", country: sent.country === "Portugal", frequency: sent.frequency === "monthly", terms: sent.terms === "yes" } };
    },
  },
  {
    suite: "browser",
    name: "a page that never stops moving",
    run: (ctx) => browse(ctx, `In your browser, open ${ctx.fixtures.url("/carousel", ctx.run)}, press the button that shows my discount code, and tell me the code.`, (r) => ({ code: r.includes(codeFor(ctx.run, "discount")) })),
  },
  {
    suite: "browser",
    name: "a long page",
    run: (ctx) => browse(ctx, `In your browser, open ${ctx.fixtures.url("/long", ctx.run)} and tell me the Quokka's tag.`, (r) => ({ code: r.includes(codeFor(ctx.run, "Quokka")) })),
  },
  ...(["checkbox", "hold", "slider"] as const).map(
    (kind): Case => ({
      suite: "browser",
      name: `challenge: ${kind}`,
      run: async (ctx) => {
        const outcome = await browse(ctx, `In your browser, open ${ctx.fixtures.url(`/challenge?c=${kind}`, ctx.run)} and get past the check on it, then tell me when it says you're verified.`, () => ({}));
        return { ...outcome, checks: { ...outcome.checks, solved: ctx.fixtures.solved(ctx.run) } };
      },
    }),
  ),
];

const DESKTOP_RULE = "Use the computer tool on the desktop for this, not the shell or the browser tool.";

const desktop: Case[] = [
  {
    suite: "desktop",
    name: "folder in the file manager",
    run: async (ctx) => {
      const bot = await ctx.operator();
      const name = `folder-${codeFor(ctx.run, "dir").slice(3).toLowerCase()}`;
      const exchange = await ctx.gond.say(bot.threadId, `${DESKTOP_RULE} Open the Files app, go to your own folder (~/.bots/${bot.id}), make a new folder named ${name} there, and tell me when it's done.`, { timeoutMs: 600_000 });
      const listing = await ctx.gond.call<{ file: { directory?: string[]; entries?: { name: string }[] } }>("GET", `/api/bots/${bot.id}/files?path=.`).catch(() => ({ file: {} as { directory?: string[]; entries?: { name: string }[] } }));
      const names = [...(listing.file.directory ?? []), ...(listing.file.entries ?? []).map((e) => e.name)].map((n) => n.replace(/\/$/, ""));
      return { checks: { used_screen: exchange.turns.some((t) => t.timing.screen > 0), folder: names.includes(name) }, exchanges: [exchange] };
    },
  },
  {
    suite: "desktop",
    name: "save a file in the editor",
    run: async (ctx) => {
      const bot = await ctx.operator();
      const words = `remember ${codeFor(ctx.run, "editor")}`;
      const file = `desk-${ctx.run.slice(-5)}.txt`;
      const exchange = await ctx.gond.say(bot.threadId, `${DESKTOP_RULE} Open the Mousepad text editor, type exactly "${words}", save it as ${file} in your own folder (~/.bots/${bot.id}), and tell me when it's saved.`, { timeoutMs: 600_000 });
      const saved = await ctx.gond.call<{ file: { content?: string } }>("GET", `/api/bots/${bot.id}/files?path=${encodeURIComponent(file)}`).catch(() => ({ file: {} as { content?: string } }));
      return { checks: { used_screen: exchange.turns.some((t) => t.timing.screen > 0), saved: (saved.file.content ?? "").trim() === words }, exchanges: [exchange] };
    },
  },
  {
    suite: "desktop",
    name: "read off a window",
    run: async (ctx) => {
      const bot = await ctx.operator();
      const file = `code-${ctx.run.slice(-5)}.txt`;
      const secret = codeFor(ctx.run, "window");
      await ctx.gond.call("PUT", `/api/bots/${bot.id}/files`, { path: file, content: `The code is ${secret}\n` });
      const exchange = await ctx.gond.say(bot.threadId, `${DESKTOP_RULE} Open ~/.bots/${bot.id}/${file} in the Mousepad text editor and read me the code shown in its window.`, { timeoutMs: 600_000 });
      return { checks: { used_screen: exchange.turns.some((t) => t.timing.screen > 0), code: text(exchange.replies).includes(secret) }, exchanges: [exchange] };
    },
  },
];

export const CASES: Case[] = [...chat, ...rooms, ...browser, ...desktop];
