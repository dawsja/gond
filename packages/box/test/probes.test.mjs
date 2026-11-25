import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authStatus, claudeVersion, forgetClaudeVersion } from "../agents.mjs";

function fakeClaude(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "claude");
  const runs = path.join(dir, "runs.txt");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${runs}"\n${body}\n`, { mode: 0o755 });
  const count = () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").length : 0);
  return { dir, bin, count, env: { PATH: process.env.PATH } };
}

test("the CLI's version is asked once while it runs, without holding up the box, and again after an update", async (t) => {
  forgetClaudeVersion();
  t.after(forgetClaudeVersion);
  const cli = fakeClaude(t, 'sleep 0.3\necho "2.1.309 (Claude Code)"');
  let ticked = false;
  setTimeout(() => (ticked = true), 20);
  const [first, second] = await Promise.all([claudeVersion({ bin: cli.bin, env: cli.env }), claudeVersion({ bin: cli.bin, env: cli.env })]);
  assert.equal(ticked, true);
  assert.deepEqual(first, [2, 1, 309]);
  assert.deepEqual(second, [2, 1, 309]);
  assert.deepEqual(await claudeVersion({ bin: cli.bin, env: cli.env }), [2, 1, 309]);
  assert.equal(cli.count(), 1);
  forgetClaudeVersion();
  assert.deepEqual(await claudeVersion({ bin: cli.bin, env: cli.env }), [2, 1, 309]);
  assert.equal(cli.count(), 2);
});

test("a CLI that never answers gives no version by its deadline", async (t) => {
  forgetClaudeVersion();
  t.after(forgetClaudeVersion);
  const cli = fakeClaude(t, "exec sleep 30");
  const started = Date.now();
  assert.equal(await claudeVersion({ bin: cli.bin, env: cli.env, timeoutMs: 200 }), null);
  assert.ok(Date.now() - started < 5_000);
});

test("a person's sign-in is read once while a look runs, but a finished sign-in looks again", async (t) => {
  const cli = fakeClaude(t, `sleep 0.3\necho 'Checking...'\necho '{"loggedIn": true, "email": "ada@example.com", "authMethod": "claude.ai"}'`);
  const ask = (key, fresh = false) => authStatus({ bin: cli.bin, env: cli.env, key, fresh });
  const [one, two] = await Promise.all([ask("ada"), ask("ada")]);
  assert.deepEqual(one, { known: true, loggedIn: true, email: "ada@example.com", org: null, method: "claude.ai" });
  assert.equal(one, two);
  assert.equal(cli.count(), 1);

  const sharing = ask("ada");
  const fresh = ask("ada", true);
  const other = ask("bob");
  await Promise.all([sharing, fresh, other]);
  assert.notEqual(await sharing, await fresh);
  assert.equal(cli.count(), 4);
});

test("a sign-in look that never answers reads as unknown by its deadline", async (t) => {
  const cli = fakeClaude(t, "exec sleep 30");
  const started = Date.now();
  assert.deepEqual(await authStatus({ bin: cli.bin, env: cli.env, key: "ada", timeoutMs: 200 }), { known: false, loggedIn: null });
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(await authStatus({ bin: path.join(cli.dir, "missing"), env: cli.env }), { known: false, loggedIn: null });
});
