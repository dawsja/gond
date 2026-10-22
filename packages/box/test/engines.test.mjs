import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAccessEnv, parseAccess } from "../agents.mjs";
import { permissionDecision } from "../bridge.mjs";
import { insideHome, HttpError } from "../server.mjs";

const API = { kind: "api", baseUrl: "http://api:8790/api/llm/openai", token: "tok_abcdefghijklmnop" };

test("parseAccess takes the proxy only when it's well formed", () => {
  assert.deepEqual(parseAccess(undefined), { kind: "plan" });
  assert.deepEqual(parseAccess({ kind: "api", baseUrl: "file:///etc", token: "tok_abcdefghijklmnop" }), { kind: "plan" });
  assert.deepEqual(parseAccess({ kind: "api", baseUrl: API.baseUrl, token: "short" }), { kind: "plan" });
  assert.deepEqual(parseAccess(API), { ...API, smallModel: null });
});

test("Claude Code on an API reaches the proxy with the token as a bearer", () => {
  assert.deepEqual(claudeAccessEnv({ kind: "plan" }), {});
  const env = claudeAccessEnv({ kind: "api", baseUrl: "http://api:8790/api/llm/anthropic", token: "t", smallModel: "glm-5" });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://api:8790/api/llm/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "t");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("permission answers read as allow or deny", () => {
  assert.deepEqual(permissionDecision({ content: JSON.stringify({ behavior: "allow", updatedInput: {} }) }), { allow: true, message: "" });
  assert.deepEqual(permissionDecision({ content: JSON.stringify({ behavior: "deny", message: "no" }) }), { allow: false, message: "no" });
  assert.equal(permissionDecision({ content: "garbage" }).allow, false);
  assert.equal(permissionDecision(null).allow, false);
});

test("insideHome keeps every CLI's sign-in private", () => {
  for (const dir of [".claude/x", ".claude/.credentials.json"]) assert.throws(() => insideHome(dir), HttpError);
  assert.ok(insideHome(".bots/a/notes.md").endsWith("/.bots/a/notes.md"));
});

