import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AgentSession, STEER_FOLLOW_MS, isReplay, sessionArgs } from "../agents.mjs";

function fakeSession({ replays = true } = {}) {
  const session = new AgentSession({ id: "steer-test", cwd: "/tmp", env: {}, socketDir: "/tmp", mcpScript: "/dev/null" });
  const written = [];
  session.child = {
    exitCode: null,
    killed: false,
    stdin: {
      writable: true,
      destroyed: false,
      write(line, done) {
        written.push(JSON.parse(line));
        done?.();
        return true;
      },
    },
  };
  session.replays = replays;
  const emit = (event) => session.onLine(JSON.stringify(event));
  const say = (text) => emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const echo = (text) => emit({ type: "user", isReplay: true, message: { role: "user", content: text } });
  const result = (text) => emit({ type: "result", result: text });
  const start = () => session.turnWith({ prompt: "tidy the folder", timeoutMs: 60_000, onEvent: () => undefined, systemPrompt: "" });
  return { session, written, emit, say, echo, result, start };
}

async function settled(promise) {
  let done = false;
  promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

test("the CLI is asked to echo what it reads, and only its echoes of our messages count", () => {
  const args = sessionArgs({ model: "opus", systemPromptFile: "/tmp/p", mcpConfigFile: "/tmp/m", sessionId: "s", resume: false, allowed: new Set(["--replay-user-messages"]) });
  assert.ok(args.includes("--replay-user-messages"));
  assert.equal(isReplay({ type: "user", isReplay: true, message: { content: "btw" } }), true);
  assert.equal(isReplay({ type: "user", isReplay: true, message: { content: [{ type: "tool_result", content: "ok" }] } }), false);
  assert.equal(isReplay({ type: "user", message: { content: "btw" } }), false);
});

test("a steer read at a tool boundary is part of the same turn", async () => {
  const { session, written, emit, say, echo, result, start } = fakeSession();
  const turn = start();
  emit({ type: "system", subtype: "init", session_id: "s" });
  echo("tidy the folder");
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
  assert.equal(await session.steer("btw: skip the logs"), true);
  assert.equal(written.at(-1).message.content, "btw: skip the logs");
  emit({ type: "user", message: { content: [{ type: "tool_result", content: "a b" }] } });
  echo("btw: skip the logs");
  say("Tidied, and left the logs.");
  result("Tidied, and left the logs.");
  const done = await turn;
  assert.equal(done.ok, true);
  assert.equal(done.text, "Tidied, and left the logs.");
  assert.equal(session.turn, null);
});

test("a steer that lands as the answer ends keeps the turn open for the answer to it", async () => {
  const { session, emit, say, echo, result, start } = fakeSession();
  const turn = start();
  echo("tidy the folder");
  assert.equal(await session.steer("btw: say BANANA at the end"), true);
  say("Tidied.");
  result("Tidied.");

  assert.equal(await settled(turn), false);
  emit({ type: "system", subtype: "init", session_id: "s" });
  echo("btw: say BANANA at the end");
  say("BANANA");
  result("BANANA");
  const done = await turn;
  assert.equal(done.text, "Tidied.\n\nBANANA");

  assert.equal(await session.steer("too late"), false);
});

test("a held answer is let go when no turn follows it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { session, echo, say, result, start } = fakeSession();
    const turn = start();
    echo("tidy the folder");
    await session.steer("btw");
    say("Tidied.");
    result("Tidied.");
    assert.equal(await settled(turn), false);
    mock.timers.tick(STEER_FOLLOW_MS);
    assert.equal((await turn).text, "Tidied.");
  } finally {
    mock.timers.reset();
  }
});

test("without echoes there's no telling where a steer went, so it's refused", async () => {
  const { session, echo, result, start } = fakeSession({ replays: false });
  assert.equal(await session.steer("no turn yet"), false);
  const turn = start();
  echo("tidy the folder");
  assert.equal(await session.steer("btw"), false);
  result("Tidied.");
  assert.equal((await turn).text, "Tidied.");
});
