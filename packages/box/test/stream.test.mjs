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

test("a CLI that refuses an optional flag ends the turn so the route can launch it again without them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-flags-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, "#!/bin/sh\necho \"error: unknown option '--include-partial-messages'\" >&2\nexit 1\n", { mode: 0o755 });
  const session = new AgentSession({ id: "flags-test", cwd: dir, env: {}, socketDir: dir, mcpScript: "/dev/null", bin });
  const launch = await session.spawn(["-p", "--include-partial-messages"], { resume: false });
  assert.equal(launch.failed, false);
  const done = await session.turnWith({ prompt: "hi", timeoutMs: 10_000, onEvent: () => undefined, systemPrompt: "" }).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { flagRejected: session.flagRejected };
  });
  if (!done.flagRejected) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(done.flagRejected || session.flagRejected, true);
  assert.equal(session.withoutOptional, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on an API key, a refused key ends the turn at once with words instead of minutes of retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-refused-"));
  const bin = path.join(dir, "claude");
  const retry = JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 401, error: "authentication_failed" });
  fs.writeFileSync(bin, `#!/bin/sh\nread line\necho '${retry}'\nsleep 30\n`, { mode: 0o755 });
  const session = new AgentSession({ id: "refused-test", cwd: dir, env: {}, socketDir: dir, mcpScript: "/dev/null", bin });
  session.access = { kind: "api", baseUrl: "http://api:8790/api/llm/anthropic", token: "tok_abcdefghijklmnop" };
  await session.spawn(["-p"], { resume: false });
  const started = Date.now();
  const done = await session.turnWith({ prompt: "hi", timeoutMs: 20_000, onEvent: () => undefined, systemPrompt: "" });
  assert.equal(done.ok, false);
  assert.equal(done.stopReason, "refused");
  assert.match(done.error, /turned down your API key/);
  assert.ok(Date.now() - started < 10_000);
  fs.rmSync(dir, { recursive: true, force: true });
});
