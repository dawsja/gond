import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAccessEnv, keyRefusal, parseAccess, retryLine } from "../agents.mjs";
import { permissionDecision } from "../bridge.mjs";
import { insideHome, HttpError } from "../server.mjs";

const API = { kind: "api", baseUrl: "http://api:8790/api/llm/openai", token: "tok_abcdefghijklmnop" };

test("parseAccess takes the proxy only when it's well formed", () => {
  assert.deepEqual(parseAccess(undefined), { kind: "plan" });
  assert.deepEqual(parseAccess({ kind: "api", baseUrl: "file:///etc", token: "tok_abcdefghijklmnop" }), { kind: "plan" });
  assert.deepEqual(parseAccess({ kind: "api", baseUrl: API.baseUrl, token: "short" }), { kind: "plan" });
  assert.deepEqual(parseAccess(API), { ...API, smallModel: null });
  assert.equal(parseAccess({ ...API, smallModel: "k3.1-pro[1m]" }).smallModel, "k3.1-pro[1m]");
  assert.equal(parseAccess({ ...API, smallModel: "k3.1-pro[2m]" }).smallModel, null);
});

test("Claude Code on an API reaches the proxy with the token as a bearer", () => {
  assert.deepEqual(claudeAccessEnv({ kind: "plan" }), {});
  const env = claudeAccessEnv({ kind: "api", baseUrl: "http://api:8790/api/llm/anthropic", token: "t", smallModel: "glm-5" });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://api:8790/api/llm/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "t");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "glm-5");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("a key the provider turns down ends the turn instead of ten silent retries", () => {
  const retry = (status) => ({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, error_status: status, error: "authentication_failed" });
  assert.match(keyRefusal(retry(401)), /turned down your API key/);
  assert.match(keyRefusal(retry(403)), /turned down your API key/);
  assert.match(keyRefusal(retry(404)), /doesn't know that model/);
  assert.equal(keyRefusal(retry(429)), null);
  assert.equal(keyRefusal(retry(529)), null);
  assert.equal(keyRefusal({ type: "system", subtype: "init" }), null);
});

test("a retry the CLI keeps to itself shows as the turn's activity", () => {
  assert.equal(retryLine({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, error_status: 529 }), "The model's API didn't answer, trying again (2 of 10)");
  assert.equal(retryLine({ type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, error_status: 429 }), "The model's API is busy or the plan's limit is reached, trying again (3 of 10)");
  assert.equal(retryLine({ type: "system", subtype: "api_retry" }), "The model's API didn't answer, trying again");
  assert.equal(retryLine({ type: "system", subtype: "init" }), null);
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

