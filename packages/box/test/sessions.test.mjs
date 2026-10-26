import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionStore, turnPrompt } from "../sessions.mjs";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gond-sessions-")), "sessions.json");

test("a saved session comes back after a restart, only for its person and engine", () => {
  const file = tempFile();
  const first = createSessionStore(file);
  first.remember("b-1--t-1", { user: "u-1", engine: "claude", sessionId: "s-abc" });
  first.remember("b-2--t-2", { user: "u-2", engine: "other", sessionId: "s-def" });

  const again = createSessionStore(file);
  assert.equal(again.get("b-1--t-1", "u-1", "claude"), "s-abc");
  assert.equal(again.get("b-1--t-1", "u-2", "claude"), null);
  assert.equal(again.get("b-1--t-1", "u-1", "other"), null);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("a session remembers the model service it was made on, and one from before was the plan's", () => {
  const file = tempFile();
  const store = createSessionStore(file);
  store.remember("old", { user: "u-1", engine: "claude", sessionId: "s-old" });
  store.remember("keyed", { user: "u-1", engine: "claude", sessionId: "s-key", backend: "api:0123456789abcdef" });
  const again = createSessionStore(file);
  assert.equal(again.backendOf("old"), "plan");
  assert.equal(again.backendOf("keyed"), "api:0123456789abcdef");
  assert.equal(again.backendOf("missing"), "plan");
});

test("sessions are forgotten with the agent, the person, or a reset", () => {
  const file = tempFile();
  const store = createSessionStore(file);
  store.remember("a", { user: "u-1", engine: "claude", sessionId: "s-a" });
  store.remember("b", { user: "u-1", engine: "claude", sessionId: "s-b" });
  store.remember("c", { user: "u-2", engine: "other", sessionId: "s-c" });

  store.forget("c", "u-1");
  assert.equal(store.get("c", "u-2", "other"), "s-c");
  store.forget("c", "u-2");
  assert.equal(store.get("c", "u-2", "other"), null);

  store.remember("a", null);
  assert.equal(store.get("a", "u-1", "claude"), null);
  store.forgetUser("u-1");
  assert.equal(store.size(), 0);

  store.remember("d", { user: "u-3", engine: "other", sessionId: "s-d" });
  store.clear();
  assert.equal(createSessionStore(file).size(), 0);
});

test("a broken file starts empty instead of failing", () => {
  const file = tempFile();
  fs.writeFileSync(file, "{not json");
  assert.equal(createSessionStore(file).size(), 0);
});

test("only a session that carries the conversation gets the short follow-up", () => {
  const body = { prompt: "FULL", followUp: "NEW" };
  assert.equal(turnPrompt(body, { launched: false }), "NEW");
  assert.equal(turnPrompt(body, { launched: true, resumed: true }), "NEW");
  assert.equal(turnPrompt(body, { launched: true, resumed: false }), "FULL");
  assert.equal(turnPrompt(body, { launched: true, resumed: true, recovered: true }), "FULL");
  assert.equal(turnPrompt({ prompt: "FULL" }, { launched: false }), "FULL");
  assert.equal(turnPrompt({ prompt: "FULL", followUp: "  " }, { launched: false }), "FULL");
});
