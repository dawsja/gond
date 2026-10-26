import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boxCwd, capOutput, inside, insideHome, openInsideHome, realInsideHome, skillPath, writableInsideHome, HttpError } from "../server.mjs";
import { runFileJob } from "../file-job.mjs";
import { GUEST_FLOOR, PERMISSION_MODES, SCREEN_SCRIPTING_DENIED, argsKeyFor, guestReady, guestRefusal, parseVersion, readReply, sessionArgs, settle, userMessage } from "../agents.mjs";
import { ReplyText } from "../bridge.mjs";

const HOME = "/home/agent";
const CLAUDE = "/home/agent/.claude";

test("inside refuses paths that climb out or touch .git", () => {
  assert.equal(inside(HOME, ".bots/x/MEMORY.md"), `${HOME}/.bots/x/MEMORY.md`);
  assert.throws(() => inside(HOME, "../etc/passwd"), HttpError);
  assert.throws(() => inside(HOME, ".bots/.git/config"), HttpError);
  assert.throws(() => inside(HOME, ""), HttpError);
});

test("insideHome keeps the Claude login private", () => {
  assert.throws(() => insideHome(".claude/credentials.json", HOME, CLAUDE), HttpError);
  assert.equal(insideHome(".bots/a/SOUL.md", HOME, CLAUDE), `${HOME}/.bots/a/SOUL.md`);
});

test("boxCwd resolves inside the home only", () => {
  assert.equal(boxCwd(undefined, HOME, CLAUDE), HOME);
  assert.equal(boxCwd(".bots/a", HOME, CLAUDE), `${HOME}/.bots/a`);
  assert.equal(boxCwd("/home/agent/.bots/a", HOME, CLAUDE), `${HOME}/.bots/a`);
  assert.throws(() => boxCwd("/etc", HOME, CLAUDE), HttpError);
});

test("capOutput keeps the head and the tail", () => {
  const { text, truncated } = capOutput("a".repeat(100) + "b".repeat(100), 40);
  assert.equal(truncated, true);
  assert.ok(text.startsWith("aaaaaaaaaa"));
  assert.ok(text.endsWith("b".repeat(30)));
});

test("sessionArgs routes permission prompts to the gond bridge unless full", () => {
  const base = { model: "claude-sonnet-5", systemPromptFile: "/tmp/p.md", mcpConfigFile: "/tmp/m.json", sessionId: "s", resume: false, allowed: new Set(["--strict-mcp-config"]) };
  const ask = sessionArgs({ ...base, permission: "ask" });
  assert.ok(ask.includes("--permission-prompt-tool"));
  assert.equal(ask[ask.indexOf("--permission-mode") + 1], "default");
  assert.ok(!ask.includes("--dangerously-skip-permissions"));
  const full = sessionArgs({ ...base, permission: "full" });
  assert.ok(full.includes("--dangerously-skip-permissions"));
  assert.ok(!full.includes("--permission-prompt-tool"));
  assert.deepEqual(PERMISSION_MODES, ["ask", "full"]);
});

test("scripting the screen is denied at every permission level", () => {
  const base = { model: "m", systemPromptFile: "/tmp/p.md", mcpConfigFile: "/tmp/m.json", sessionId: "s", resume: false, allowed: new Set() };
  for (const permission of PERMISSION_MODES) {
    const args = sessionArgs({ ...base, permission });
    const at = args.indexOf("--disallowedTools");
    assert.ok(at > 0);
    assert.deepEqual(args.slice(at + 1, at + 1 + SCREEN_SCRIPTING_DENIED.length), SCREEN_SCRIPTING_DENIED);
  }
  assert.ok(SCREEN_SCRIPTING_DENIED.includes("Bash(xdotool:*)"));
});

test("argsKey changes with the permission mode", () => {
  const a = argsKeyFor({ model: "m", toolNames: ["x"], permission: "ask" });
  const b = argsKeyFor({ model: "m", toolNames: ["x"], permission: "full" });
  assert.notEqual(a, b);
});

test("argsKey changes when a server is refreshed, and stays put for servers never refreshed", () => {
  const plain = argsKeyFor({ model: "m", toolNames: ["x"], permission: "ask" });
  assert.equal(argsKeyFor({ model: "m", toolNames: ["x"], permission: "ask", mcpRevs: [null] }), plain);
  const once = argsKeyFor({ model: "m", toolNames: ["x"], permission: "ask", mcpRevs: ["2026-10-22T10:00:00Z"] });
  assert.notEqual(once, plain);
  assert.notEqual(argsKeyFor({ model: "m", toolNames: ["x"], permission: "ask", mcpRevs: ["2026-10-22T11:00:00Z"] }), once);
});

test("settle reads a result line and ignores task notifications", () => {
  assert.equal(settle({ type: "assistant" }), null);
  assert.equal(settle({ type: "result", origin: { kind: "task-notification" } }), null);
  const done = settle({ type: "result", result: "hi" });
  assert.equal(done.ok, true);
  assert.equal(done.text, "hi");
  assert.equal(done.error, undefined);
});

test("settle keeps a failed result's text as the error and flags a signed-out CLI", () => {
  const out = settle({ type: "result", is_error: true, result: "Not logged in · Please run /login" });
  assert.equal(out.ok, false);
  assert.equal(out.error, "Not logged in · Please run /login");
  assert.equal(out.signedOut, true);
  const broke = settle({ type: "result", is_error: true, result: "Something else went wrong" });
  assert.equal(broke.signedOut, false);
  assert.equal(broke.error, "Something else went wrong");
  assert.equal(settle({ type: "result", is_error: true }).error, undefined);
});

const say = (...content) => ({ type: "assistant", message: { content } });
const text = (t) => ({ type: "text", text: t });
const call = { type: "tool_use", name: "mcp__gond__delegate_bot", input: {} };

test("the reply is what comes after the last tool call", () => {
  const reply = new ReplyText();
  readReply(reply, say(text("Let me look at the file.")));
  readReply(reply, say(call));
  readReply(reply, say(text("It says hello.")));
  assert.equal(reply.text(), "It says hello.");
});

test("a turn that ends on tool calls keeps every word it wrote", () => {
  const reply = new ReplyText();
  readReply(reply, say(text("Wave two, in order: user dir, then the cursor. Relaying that…"), call));
  readReply(reply, say(call));
  readReply(reply, say(text("…and Socket gets the export filter."), call));
  assert.equal(reply.text(), "Wave two, in order: user dir, then the cursor. Relaying that…\n\n…and Socket gets the export filter.");
});

test("streamed text joins as it came", () => {
  const reply = new ReplyText();
  reply.chunk("Hel");
  reply.chunk("lo");
  assert.equal(reply.text(), "Hello");
  reply.tool();
  assert.equal(reply.current(), "");
  assert.equal(reply.text(), "Hello");
});

test("userMessage attaches images and PDFs as content blocks", () => {
  const plain = userMessage("hello", []);
  assert.equal(plain.message.content, "hello");
  const rich = userMessage("look", [{ name: "a.png", mediaType: "image/png", data: "AAAA" }, { name: "d.pdf", mediaType: "application/pdf", data: "BBBB" }, { name: "x.bin", mediaType: "application/octet-stream", data: "CC" }]);
  assert.equal(rich.message.content.length, 3);
  assert.equal(rich.message.content[0].type, "image");
  assert.equal(rich.message.content[1].type, "document");
});

test("realInsideHome follows links and refuses ones that leave the home or reach a sign-in", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gond-home-"));
  const login = path.join(home, ".claude");
  fs.mkdirSync(login);
  fs.writeFileSync(path.join(login, "credentials.json"), "{}");
  fs.writeFileSync(path.join(home, "hello.html"), "<p>hi</p>");
  fs.symlinkSync(path.join(login, "credentials.json"), path.join(home, "creds"));
  fs.symlinkSync("/etc/hostname", path.join(home, "host"));
  fs.symlinkSync(path.join(home, "hello.html"), path.join(home, "hi"));
  try {
    assert.equal(realInsideHome("hi", home, login), fs.realpathSync(path.join(home, "hello.html")));
    assert.throws(() => realInsideHome("creds", home, login), HttpError);
    assert.throws(() => realInsideHome("host", home, login), HttpError);
    assert.throws(() => realInsideHome("missing", home, login), HttpError);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the image carries every module the box imports", () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const copied = fs
    .readFileSync(path.join(dir, "Dockerfile"), "utf8")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("COPY "))
    .join(" ");
  const modules = fs.readdirSync(dir).filter((name) => name.endsWith(".mjs"));
  assert.ok(modules.includes("sign-in.mjs"));
  for (const name of modules) {
    assert.ok(copied.includes("*.mjs") || copied.includes(` ${name} `), `${name} never reaches the image: add it to the Dockerfile's COPY`);
  }
});

test("writableInsideHome refuses a write or delete through a link that leaves the home or reaches a sign-in", async () => {
  const os = await import("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gond-home-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gond-outside-"));
  const login = path.join(home, ".claude");
  fs.mkdirSync(login);
  fs.mkdirSync(path.join(home, ".bots", "b1"), { recursive: true });
  fs.symlinkSync("/", path.join(home, ".bots", "b1", "r"));
  fs.symlinkSync(outside, path.join(home, "out"));
  fs.symlinkSync(login, path.join(home, "creds"));
  fs.symlinkSync(path.join(home, ".bots"), path.join(home, "desk"));
  try {
    assert.equal(writableInsideHome(".bots/b1/new/deep/file.md", home, login), path.join(home, ".bots/b1/new/deep/file.md"));
    assert.equal(writableInsideHome("desk/b1/SOUL.md", home, login), path.join(home, "desk/b1/SOUL.md"));
    assert.throws(() => writableInsideHome(".bots/b1/r/etc/passwd", home, login), HttpError);
    assert.throws(() => writableInsideHome("out/x.txt", home, login), HttpError);
    assert.throws(() => writableInsideHome("out/new/x.txt", home, login), HttpError);
    assert.throws(() => writableInsideHome("creds/credentials.json", home, login), HttpError);

    assert.equal(writableInsideHome("out", home, login), path.join(home, "out"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("openInsideHome answers the file it opened and refuses one outside", async () => {
  const os = await import("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gond-home-"));
  fs.writeFileSync(path.join(home, "a.txt"), "hi");
  fs.symlinkSync("/etc/hostname", path.join(home, "host"));
  try {
    const { fd, real } = openInsideHome("a.txt", home, path.join(home, ".claude"));
    assert.equal(fs.readFileSync(fd, "utf8"), "hi");
    assert.equal(real, fs.realpathSync(path.join(home, "a.txt")));
    fs.closeSync(fd);
    assert.throws(() => openInsideHome("host", home, path.join(home, ".claude")), HttpError);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a file job writes atomically, making folders, and deletes a link without touching its target", async () => {
  const os = await import("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gond-home-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gond-outside-"));
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, path.join(home, "out"));
  try {
    runFileJob({ op: "write", path: path.join(home, "a/b/c.md"), content: "one" });
    runFileJob({ op: "write", path: path.join(home, "a/b/c.md"), content: "two" });
    assert.equal(fs.readFileSync(path.join(home, "a/b/c.md"), "utf8"), "two");
    assert.deepEqual(fs.readdirSync(path.join(home, "a/b")), ["c.md"]);
    runFileJob({ op: "delete", path: path.join(home, "out") });
    assert.equal(fs.existsSync(path.join(home, "out")), false);
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a skill's files stay inside its folder: no .., nothing hidden, no absolute paths", () => {
  assert.equal(skillPath("SKILL.md"), "SKILL.md");
  assert.equal(skillPath("scripts/./fill.py"), "scripts/fill.py");
  assert.equal(skillPath("/etc/passwd"), "etc/passwd");
  assert.equal(skillPath("../escape.sh"), null);
  assert.equal(skillPath("scripts/../../x"), null);
  assert.equal(skillPath(".env"), null);
  assert.equal(skillPath("a/.git/config"), null);
  assert.equal(skillPath("a\\b"), null);
  assert.equal(skillPath(""), null);
  assert.equal(skillPath(42), null);
});

test("a guest session has no tools, or only web search, whatever permission it asks for", () => {
  const base = { model: "m", systemPromptFile: "/tmp/p.md", mcpConfigFile: "/tmp/m.json", sessionId: "s", resume: false, allowed: new Set(["--strict-mcp-config", "--setting-sources"]), optional: false };
  const talk = sessionArgs({ ...base, permission: "full", guest: "talk" });
  assert.equal(talk[talk.indexOf("--tools") + 1], "");
  assert.ok(!talk.includes("--dangerously-skip-permissions"));
  assert.ok(talk.includes("--permission-prompt-tool"));
  const denied = talk.slice(talk.indexOf("--disallowedTools") + 1);
  for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "WebFetch", "WebSearch"]) assert.ok(denied.includes(tool), tool);
  // Even with optional flags off, a guest never loads the person's settings and only the gond bridge.
  assert.equal(talk[talk.indexOf("--setting-sources") + 1], "project");
  assert.ok(talk.includes("--strict-mcp-config"));

  const look = sessionArgs({ ...base, guest: "look" });
  assert.equal(look[look.indexOf("--tools") + 1], "WebSearch");
  const allowed = look.slice(look.indexOf("--allowedTools") + 1, look.indexOf("--strict-mcp-config"));
  assert.deepEqual(allowed, ["mcp__gond", "WebSearch"]);
  // WebFetch reaches any address the box can, so a guest never has it.
  const lookDenied = look.slice(look.indexOf("--disallowedTools") + 1, look.indexOf("--append-system-prompt-file"));
  assert.ok(lookDenied.includes("WebFetch"));
  assert.ok(!lookDenied.includes("WebSearch"));

  const plain = sessionArgs({ ...base, permission: "ask" });
  assert.ok(!plain.includes("--tools"));
});

test("a guest session is its own, and needs a Claude Code that can drop its tools", () => {
  const key = argsKeyFor({ model: "m", toolNames: [], permission: "ask" });
  assert.notEqual(argsKeyFor({ model: "m", toolNames: [], permission: "ask", guest: "talk" }), key);
  assert.equal(argsKeyFor({ model: "m", toolNames: [], permission: "ask", guest: null }), key);
  assert.ok(guestReady(parseVersion(GUEST_FLOOR)));
  assert.ok(guestReady(parseVersion("2.1.310")));
  assert.ok(!guestReady(parseVersion("1.0.120")));
  // `--tools` is the fence, so a version that can't be read is refused too.
  assert.ok(!guestReady(null));
  assert.ok(!guestReady(parseVersion("not a version")));
  assert.match(guestRefusal(null), /Couldn't tell which Claude Code/);
  assert.match(guestRefusal(parseVersion("1.0.120")), /^Claude Code 1\.0\.120 on the computer is too old/);
});
