import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, addUsage, planLimits, usageSince } from "../agents.mjs";

const entry = (inputTokens, outputTokens, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) => ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD: 0.01, contextWindow: 200000 });

test("a result's own count since the last one is taken as it is", () => {
  const event = { type: "result", modelUsage: { opus: entry(100, 20) }, model_usage_since_last_result: { opus: entry(40, 5, 900, 10) } };
  const { used, counted } = usageSince(event, { opus: { input: 60, output: 15, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(used, { opus: { input: 40, output: 5, cacheRead: 900, cacheWrite: 10 } });
  assert.deepEqual(counted, { opus: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } });
});

test("an older CLI's running totals become the change since the last result", () => {
  const first = usageSince({ modelUsage: { opus: entry(100, 20) } }, null);
  assert.deepEqual(first.used, { opus: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } });
  const second = usageSince({ modelUsage: { opus: entry(150, 30), haiku: entry(5, 1) } }, first.counted);
  assert.deepEqual(second.used, { opus: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 }, haiku: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } });
  // Nothing new is nothing at all, and a total that fell was reset.
  assert.deepEqual(usageSince({ modelUsage: { opus: entry(150, 30), haiku: entry(5, 1) } }, second.counted).used, {});
  assert.deepEqual(usageSince({ modelUsage: { opus: entry(10, 2) } }, second.counted).used, { opus: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } });
});

test("a resumed process's first running total only sets the baseline", () => {
  const { used, counted } = usageSince({ modelUsage: { opus: entry(5000, 800) } }, null, true);
  assert.deepEqual(used, {});
  assert.deepEqual(usageSince({ modelUsage: { opus: entry(5100, 810) } }, counted, true).used, { opus: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
});

test("usage from two results adds up per model", () => {
  const a = { opus: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
  assert.deepEqual(addUsage(a, { opus: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, haiku: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 } }), {
    opus: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
    haiku: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
});

test("a plan's windows are read from its rate limit event", () => {
  // As Claude Code 2.1.310 writes it.
  const event = {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt: 1792952400, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: 1792952400, status: "allowed" }, seven_day: { utilization: 0.47, resetsAt: 1793091600, status: "allowed" } } },
  };
  assert.deepEqual(planLimits(event), {
    session: { used: 0.06, resetsAt: new Date(1792952400 * 1000).toISOString() },
    weekly: { used: 0.47, resetsAt: new Date(1793091600 * 1000).toISOString() },
  });
  // A CLI without the windows says only the one that limits.
  assert.deepEqual(planLimits({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "seven_day", utilization: 0.9, resetsAt: 1793091600 } }), { weekly: { used: 0.9, resetsAt: new Date(1793091600 * 1000).toISOString() } });
  assert.equal(planLimits({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), null);
  assert.equal(planLimits({ type: "result" }), null);
});

test("a turn hears what it used and the plan's limits, and a late result's usage waits for the next turn", async () => {
  const session = new AgentSession({ id: "usage-test", cwd: "/tmp", env: {}, socketDir: "/tmp", mcpScript: "/dev/null" });
  session.child = { exitCode: null, killed: false, stdin: { writable: true, destroyed: false, write: (_line, done) => (done?.(), true) } };
  const emit = (event) => session.onLine(JSON.stringify(event));
  const events = [];
  const turn = session.turnWith({ prompt: "hi", timeoutMs: 60_000, onEvent: (event) => events.push(event), systemPrompt: "" });
  emit({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1792952400 } } } });
  emit({ type: "result", result: "Hi", model_usage_since_last_result: { opus: entry(10, 2) } });
  await turn;
  assert.deepEqual(events.find((event) => event.type === "limits")?.limits.session.used, 0.5);
  assert.deepEqual(events.find((event) => event.type === "usage")?.models, { opus: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } });
  assert.ok(!events.some((event) => event.type === "line" && event.line.includes("rate_limit_event")));

  // A background task's result after the turn ended.
  emit({ type: "result", origin: { kind: "task-notification" }, model_usage_since_last_result: { haiku: entry(3, 1) } });
  const later = [];
  const next = session.turnWith({ prompt: "again", timeoutMs: 60_000, onEvent: (event) => later.push(event), systemPrompt: "" });
  assert.deepEqual(later.find((event) => event.type === "usage")?.models, { haiku: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } });
  emit({ type: "result", result: "Again" });
  await next;
});
