import type { AiSettings, Bot } from "@gond/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CASES, SUITES, type Case, type Context, type Engine, type Outcome, type Suite, type Team } from "./cases.ts";
import { startFixtures } from "./fixtures.ts";
import { Gond } from "./gond.ts";
import { createJudge } from "./judge.ts";
import { groups, summarize, type CaseRun, type RunFile } from "./stats.ts";

/*
 * bun run bench -- --label baseline [--engines api,claude] [--suites chat,rooms,browser,desktop] [--repeat 5] [--only "short fact"]
 *
 * Drives a running Gond (GOND_TURN_TIMING=1 on its API) as its admin, with real AI, and writes one
 * results file under packages/bench/results. See packages/bench/README.md for the environment.
 */

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    engines: { type: "string", default: "api,claude" },
    suites: { type: "string", default: SUITES.join(",") },
    repeat: { type: "string", default: "5" },
    only: { type: "string" },
  },
});

const env = (name: string, fallback?: string) => {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined) throw new Error(`Set ${name} (see packages/bench/README.md)`);
  return value;
};

const engines = values.engines!.split(",").map((e) => e.trim()) as Engine[];
const suites = values.suites!.split(",").map((s) => s.trim()) as Suite[];
const repeat = Math.max(1, Number(values.repeat) || 5);
for (const engine of engines) if (engine !== "api" && engine !== "claude") throw new Error(`Engines are api and claude, not ${engine}`);
for (const suite of suites) if (!SUITES.includes(suite)) throw new Error(`Suites are ${SUITES.join(", ")}, not ${suite}`);

const models = {
  api: env("BENCH_API_MODEL", "claude-opus-5-5"),
  claude: env("BENCH_CLAUDE_MODEL", "opus"),
  judge: env("BENCH_JUDGE_MODEL", "claude-opus-5-5"),
};
const gond = new Gond(env("GOND_URL", "http://localhost:3000").replace(/\/$/, ""));
const fixtures = startFixtures(Number(env("BENCH_FIXTURE_PORT", "4790")), env("BENCH_FIXTURE_HOST", "host.docker.internal"));
const judge = createJudge({ apiKey: process.env.BENCH_JUDGE_KEY, model: models.judge, openAiUrl: process.env.BENCH_JUDGE_URL?.trim() || undefined });

await gond.signIn(env("BENCH_USER", "bench"), env("BENCH_PASSWORD"), process.env.GOND_SETUP_TOKEN);
await gond.turnsSince(new Date().toISOString()).catch(() => {
  throw new Error("The API isn't timing turns: start it with GOND_TURN_TIMING=1");
});

const before = (await gond.call<{ ai: AiSettings }>("GET", "/api/ai")).ai;

// The `api` engine's key: Anthropic's by default, or any OpenAI-compatible endpoint (BENCH_API_PROVIDER=openai).
const apiProvider = env("BENCH_API_PROVIDER", "anthropic");
if (apiProvider !== "anthropic" && apiProvider !== "openai") throw new Error("BENCH_API_PROVIDER is anthropic or openai");
// Claude Code on the computer's plan sign-in, or on a key (BENCH_CLAUDE_ACCESS=api).
const claudeAccess = env("BENCH_CLAUDE_ACCESS", "plan");
if (claudeAccess !== "plan" && claudeAccess !== "api") throw new Error("BENCH_CLAUDE_ACCESS is plan or api");

async function useEngine(engine: Engine) {
  if (engine === "api") {
    const baseUrl = env("BENCH_API_BASE_URL", apiProvider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
    await gond.call("PUT", `/api/providers/${apiProvider}`, { baseUrl, apiKey: process.env.BENCH_API_KEY?.trim() || env("BENCH_ANTHROPIC_KEY") });
    await gond.call("PATCH", "/api/ai", { enabled: ["api"], engine: "api", engines: { api: { access: "api", model: models.api, provider: apiProvider } } });
  } else if (claudeAccess === "api") {
    // Claude Code on an Anthropic-compatible key (DeepSeek's /anthropic, Kimi, a proxy), through Gond's LLM proxy.
    await gond.call("PUT", "/api/providers/anthropic", { baseUrl: env("BENCH_CLAUDE_BASE_URL", "https://api.anthropic.com"), apiKey: process.env.BENCH_CLAUDE_KEY?.trim() || env("BENCH_ANTHROPIC_KEY") });
    await gond.call("PATCH", "/api/ai", { enabled: ["claude"], engine: "claude", engines: { claude: { access: "api", model: models.claude } } });
  } else {
    await gond.call("PATCH", "/api/ai", { enabled: ["claude"], engine: "claude", engines: { claude: { access: "plan", model: models.claude } } });
  }
}

// One primary bot of the bench's own, so check-in offers and unnamed-room fallbacks never land on a case's bot.
const existing = (await gond.call<{ bots: Bot[] }>("GET", "/api/bots")).bots;
if (!existing.length) await gond.createBot({ name: "Anchor", title: "Assistant", description: "The bench's primary bot. It isn't asked anything." });

const results: CaseRun[] = [];
const commit = (() => {
  const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
  const dirty = Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString().trim();
  return head ? `${head}${dirty ? "+changes" : ""}` : null;
})();

function record(engine: Engine, kase: Case, n: number, run: string, outcome: Outcome | null, error: string | null, score: { score: number | null; reason: string } | null): CaseRun {
  const exchanges = outcome?.exchanges ?? [];
  const measured = exchanges[outcome?.measured ?? exchanges.length - 1];
  const turns = measured?.turns ?? [];
  const all = exchanges.flatMap((e) => e.turns);
  const checks = outcome?.checks ?? {};
  const timedOut = exchanges.some((e) => e.timedOut);
  return {
    suite: kase.suite,
    name: kase.name,
    engine,
    repeat: n,
    run,
    pass: !error && !timedOut && Object.values(checks).every(Boolean) && Object.keys(checks).length > 0,
    checks,
    score: score?.score ?? null,
    judgeReason: score?.reason ?? null,
    firstWordsMs: measured?.firstWordsMs ?? null,
    doneMs: measured?.doneMs ?? null,
    setupMs: turns.length ? Math.max(...turns.map((t) => t.timing.setupMs)) : null,
    queuedMs: turns.length ? Math.max(...turns.map((t) => t.timing.queuedMs)) : null,
    routeMs: outcome?.routeMs ?? turns.find((t) => t.routeMs !== null)?.routeMs ?? null,
    launch: turns[0]?.launch ?? null,
    rounds: turns.reduce((sum, t) => sum + t.timing.rounds, 0),
    screen: all.reduce((sum, t) => sum + t.timing.screen, 0),
    tokens: all.reduce((sum, t) => ({ input: sum.input + t.tokens.input, output: sum.output + t.tokens.output, cacheRead: sum.cacheRead + t.tokens.cacheRead, cacheWrite: sum.cacheWrite + t.tokens.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    timedOut,
    error,
    answer: (outcome?.judged?.answer ?? (measured?.replies ?? []).map((m) => m.body).join("\n\n")).slice(0, 4000),
  };
}

const seconds = (ms: number | null) => (ms === null ? "  -  " : `${(ms / 1000).toFixed(1)}s`);

const startedAt = new Date().toISOString();
const label = values.label!.replace(/[^\w.-]+/g, "-");
const outDir = path.join(import.meta.dir, "..", "results");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${label}-${startedAt.replace(/[:.]/g, "-")}.json`);
const save = () => writeFileSync(outFile, JSON.stringify({ label, startedAt, gondUrl: gond.url, commit, models, runs: results } satisfies RunFile, null, 2));

try {
  for (const engine of engines) {
    await useEngine(engine);
    let team: Team | null = null;
    let operator: Bot | null = null;
    const made: Bot[] = [];
    const make = async (input: { name: string; title: string; description: string }) => {
      const bot = await gond.createBot({ ...input, name: `${input.name} ${engine}` });
      made.push(bot);
      await gond.settleGreeting(bot);
      return bot;
    };
    const ctxFor = (run: string): Context => ({
      gond,
      fixtures,
      engine,
      run,
      team: async () =>
        (team ??= {
          ledger: await make({ name: "Ledger", title: "Accountant", description: "Invoices, budgets, expenses, receipts and anything about money." }),
          atlas: await make({ name: "Atlas", title: "Travel planner", description: "Flights, hotels, itineraries, visas and travel advice." }),
          basil: await make({ name: "Basil", title: "Chef", description: "Recipes, meal plans, cooking help and grocery lists." }),
        }),
      operator: async () => (operator ??= await make({ name: "Operator", title: "Operator", description: "Does things on websites and the computer's desktop for the person." })),
    });
    try {
      const chosen = CASES.filter((c) => suites.includes(c.suite) && (!values.only || c.name === values.only));
      for (let n = 1; n <= repeat; n++) {
        for (const kase of chosen) {
          if (n > (kase.repeat ?? repeat)) continue;
          const run = `${engine}-${n}-${crypto.randomUUID().slice(0, 8)}`;
          let outcome: Outcome | null = null;
          let error: string | null = null;
          try {
            outcome = await kase.run(ctxFor(run));
          } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
          }
          const score = outcome?.judged ? await judge(outcome.judged) : null;
          const row = record(engine, kase, n, run, outcome, error, score);
          results.push(row);
          save();
          const failed = Object.entries(row.checks).filter(([, ok]) => !ok).map(([check]) => check);
          console.log(`${engine} ${n}/${kase.repeat ?? repeat} ${kase.suite}: ${kase.name.padEnd(32)} ${row.pass ? "pass" : "FAIL"} first ${seconds(row.firstWordsMs)} done ${seconds(row.doneMs)}${row.routeMs !== null ? ` routed ${seconds(row.routeMs)}` : ""}${row.score !== null ? ` judge ${row.score}` : ""}${row.launch ? ` (${row.launch})` : ""}${failed.length ? ` missed: ${failed.join(", ")}` : ""}${error ? ` error: ${error}` : ""}`);
        }
      }
    } finally {
      for (const bot of made) await gond.deleteBot(bot.id);
    }
  }
} finally {
  await gond.call("PATCH", "/api/ai", { enabled: before.enabled, engine: before.engine, engines: before.engines }).catch((error: unknown) => console.warn(`Couldn't put the AI settings back: ${error instanceof Error ? error.message : error}`));
  save();
  gond.close();
  fixtures.stop();
}

console.log(`\nResults: ${outFile}\n`);
for (const [group, runs] of groups(results)) {
  const s = summarize(runs);
  console.log(`${group.padEnd(18)} pass ${(s.passRate * 100).toFixed(0).padStart(3)}%  judge ${s.judgeMean === null ? " - " : s.judgeMean.toFixed(2)}  first words ${seconds(s.firstWords.median)} (p90 ${seconds(s.firstWords.p90)})  done ${seconds(s.done.median)} (p90 ${seconds(s.done.p90)})${s.route.median !== null ? `  routed ${seconds(s.route.median)}` : ""}  cached ${s.cacheShare === null ? "-" : `${(s.cacheShare * 100).toFixed(0)}%`}`);
}
process.exit(0);
