import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSession, sessionArgs, streamText } from "../agents.mjs";

test("a reply's words come through as the model writes them, and a tool call ends the text before it", () => {
  assert.deepEqual(streamText({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }), { type: "text_delta", text: "Hel" });
  assert.deepEqual(streamText({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Bash" } }), { type: "text_end" });
  assert.deepEqual(streamText({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "t", name: "web_search" } }), { type: "text_end" });
  // A handoff keeps the words on screen and starts a new paragraph.
  assert.deepEqual(streamText({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "mcp__gond__delegate_bot" } }), { type: "text_delta", text: "\n\n" });
  assert.equal(streamText({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }), null);
  assert.equal(streamText({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } }), null);
  assert.equal(streamText({ type: "message_stop" }), null);
});

test("the CLI is asked for partial messages, and only the top level's words reach the turn", async () => {
  const args = sessionArgs({ model: "opus", systemPromptFile: "/tmp/p", mcpConfigFile: "/tmp/m", sessionId: "s", resume: false, allowed: new Set(["--include-partial-messages"]) });
  assert.ok(args.includes("--include-partial-messages"));

  const session = new AgentSession({ id: "stream-test", cwd: "/tmp", env: {}, socketDir: "/tmp", mcpScript: "/dev/null" });
  session.child = { exitCode: null, killed: false, stdin: { writable: true, destroyed: false, write: (_line, done) => (done?.(), true) } };
  const events = [];
  const turn = session.turnWith({ prompt: "hi", timeoutMs: 60_000, onEvent: (event) => events.push(event), systemPrompt: "" });
  const emit = (event) => session.onLine(JSON.stringify(event));
  emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } } });
  emit({ type: "stream_event", parent_tool_use_id: "sub", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "subagent" } } });
  emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } } });
  emit({ type: "result", result: "Hi there" });
  const done = await turn;
  assert.equal(done.text, "Hi there");
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["Hi ", "there"]);
  assert.ok(!events.some((event) => event.type === "line" && event.line.includes("stream_event")));
});

// A test that starts a CLI stops it however the test ends, or a leftover child keeps the runner from exiting.
function cleanUp(t, session, dir) {
  t.after(async () => {
    await session.close({ keepSession: false }).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** Waits for a fake CLI to have written what it was launched with. */
async function launches(file, count) {
  for (let i = 0; i < 100; i += 1) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the CLI wasn't launched ${count} time(s)`);
}

test("a CLI that refuses an optional flag ends the turn so the route can launch it again without them", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-flags-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, "#!/bin/sh\necho \"error: unknown option '--include-partial-messages'\" >&2\nexit 1\n", { mode: 0o755 });
  const session = new AgentSession({ id: "flags-test", cwd: dir, env: {}, socketDir: dir, mcpScript: "/dev/null", bin });
  cleanUp(t, session, dir);
  const launch = await session.spawn(["-p", "--include-partial-messages"], { resume: false });
  assert.equal(launch.failed, false);
  const done = await session.turnWith({ prompt: "hi", timeoutMs: 10_000, onEvent: () => undefined, systemPrompt: "" }).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { flagRejected: session.flagRejected };
  });
  if (!done.flagRejected) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(done.flagRejected || session.flagRejected, true);
  assert.equal(session.withoutOptional, true);
});

test("on an API key, a refused key ends the turn at once with words instead of minutes of retries", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-refused-"));
  const bin = path.join(dir, "claude");
  const retry = JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 401, error: "authentication_failed" });
  fs.writeFileSync(bin, `#!/bin/sh\nread line\necho '${retry}'\nsleep 30\n`, { mode: 0o755 });
  const session = new AgentSession({ id: "refused-test", cwd: dir, env: {}, socketDir: dir, mcpScript: "/dev/null", bin });
  cleanUp(t, session, dir);
  session.access = { kind: "api", baseUrl: "http://api:8790/api/llm/anthropic", token: "tok_abcdefghijklmnop" };
  await session.spawn(["-p"], { resume: false });
  const started = Date.now();
  const done = await session.turnWith({ prompt: "hi", timeoutMs: 20_000, onEvent: () => undefined, systemPrompt: "" });
  assert.equal(done.ok, false);
  assert.equal(done.stopReason, "refused");
  assert.match(done.error, /turned down your API key/);
  assert.ok(Date.now() - started < 10_000);
});

test("moving between the plan and a key starts a fresh session instead of resuming one the new model can't hold", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-backend-"));
  const bin = path.join(dir, "claude");
  const calls = path.join(dir, "calls.txt");
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.309 (Claude Code)"; exit 0; fi\necho "$*" >> ${calls}\nsleep 30\n`, { mode: 0o755 });
  const session = new AgentSession({ id: "backend-test", cwd: dir, env: {}, socketDir: dir, mcpScript: "/dev/null", bin });
  cleanUp(t, session, dir);
  session.sessionId = "s-from-the-plan";
  session.backend = "plan";
  const settings = { model: "k3.1-pro", systemPrompt: "", tools: [] };
  const onPlan = await session.ensure({ ...settings, model: "opus" });
  assert.equal(onPlan.resumed, true);
  // The plan's CLI has written how it was launched before the switch stops it; on a slow machine it hadn't yet.
  const [first] = await launches(calls, 1);
  assert.match(first, /--resume s-from-the-plan/);
  const onKey = await session.ensure({ ...settings, access: { kind: "api", baseUrl: "http://api:8790/api/llm/anthropic", token: "tok_abcdefghijklmnop", smallModel: "k3.1-pro" } });
  assert.equal(onKey.resumed, false);
  assert.notEqual(session.sessionId, "s-from-the-plan");
  assert.match(session.backend, /^api:/);
  const [, second] = await launches(calls, 2);
  assert.match(second, /--session-id /);
  assert.doesNotMatch(second, /s-from-the-plan/);
});
