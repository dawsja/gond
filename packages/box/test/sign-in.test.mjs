import assert from "node:assert/strict";
import test from "node:test";
import { SignInJob, lastLine, needsCode, parseSignIn, signInArgv, signInReady, stripAnsi } from "../sign-in.mjs";

const BINS = { claude: "claude" };

const CLAUDE_OUT =
  "\x1b[2mOpening browser to sign in…\x1b[0m\r\n" +
  "If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&code_challenge=9a25aUc&state=CLd5Br\x07" +
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&code_challenge=9a25aUc&state=CLd5Br\x1b]8;;\x07\r\n" +
  "Paste code here if prompted > ";
const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&code_challenge=9a25aUc&state=CLd5Br";

test("the escapes a terminal acts on are taken out, hyperlinks and all", () => {
  assert.equal(stripAnsi("\x1b[94mhi\x1b[0m\r\n"), "hi\n");
  assert.equal(stripAnsi("\x1b]8;;https://x.test\x07shown\x1b]8;;\x1b\\"), "shown");
});

test("Claude Code's login gives its link and asks for a code", () => {
  const parsed = parseSignIn("claude", CLAUDE_OUT);
  assert.equal(parsed.url, CLAUDE_URL);
  assert.equal(parsed.code, null);
  assert.ok(signInReady("claude", parsed));
  assert.ok(needsCode("claude"));
});

test("half a line isn't a sign-in yet", () => {
  assert.equal(signInReady("claude", parseSignIn("claude", "Opening browser to sign in…\r\n")), false);
});

test("each CLI's own login command, with the binaries the box runs", () => {
  assert.deepEqual(signInArgv("claude", BINS), ["claude", "auth", "login", "--claudeai"]);
  assert.throws(() => signInArgv("nothing", BINS));
});

function fakePty() {
  const pty = { written: [], killed: false };
  pty.onData = (fn) => (pty.data = fn);
  pty.onExit = (fn) => (pty.exit = fn);
  pty.write = (text) => pty.written.push(text);
  pty.kill = () => (pty.killed = true);
  return pty;
}

function job(engine, out, { confirm = async () => true, timeoutMs = 60_000 } = {}) {
  const pty = fakePty();
  const running = new SignInJob({ engine, spawn: () => pty, confirm, timeoutMs }).start();
  if (out) pty.data(out);
  return { running, pty };
}

test("a sign-in waits with its link, takes the code and ends signed in", async () => {
  const { running, pty } = job("claude", CLAUDE_OUT);
  assert.equal(running.view().state, "waiting");
  assert.equal(running.view().url, CLAUDE_URL);
  assert.ok(running.write("code#state"));
  assert.deepEqual(pty.written, ["code#state\r"]);
  assert.equal(running.view().state, "finishing");
  await running.finish(0);
  assert.equal(running.view().state, "done");
  assert.equal(running.view().error, null);
});

test("a refused code fails with what the CLI said, never with the code itself", async () => {
  const { running } = job("claude", CLAUDE_OUT);
  running.write("wrongcode#state");
  running.read("wrongcode#state\r\nLogin failed: Request failed with status code 400\r\n");
  await running.finish(1);
  const view = running.view();
  assert.equal(view.state, "failed");
  assert.equal(view.error, "Login failed: Request failed with status code 400");
  assert.ok(!JSON.stringify(view).includes("wrongcode"));
});

test("a CLI that ends happily without being signed in is still a failure", async () => {
  const { running } = job("claude", CLAUDE_OUT, { confirm: async () => false });
  await running.finish(0);
  assert.equal(running.view().state, "failed");
  assert.match(running.view().error, /still isn't signed in/);
});

test("a sign-in nobody finishes is killed and says so", async () => {
  const { running, pty } = job("claude", CLAUDE_OUT, { timeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(running.view().state, "failed");
  assert.match(running.view().error, /took too long/);
  assert.ok(pty.killed);
});

test("what a sign-in tells the app is the link, the code and nothing else", () => {
  const { running } = job("claude", CLAUDE_OUT);
  assert.deepEqual(Object.keys(running.view()).sort(), ["code", "engine", "error", "needsCode", "startedAt", "state", "url"]);
});

test("the last line is what the CLI said, warnings aside", () => {
  assert.equal(lastLine("WARNING: something\nLogin failed: nope\n"), "Login failed: nope");
});
