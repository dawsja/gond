import assert from "node:assert/strict";
import test from "node:test";
import { loggable } from "../agents.mjs";
import { toolResultContent } from "../bridge.mjs";
import { handleRpc, mcpContent } from "../gond-mcp.mjs";

const PNG = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");

function stubBridge(answer) {
  const calls = [];
  const bridge = async (method, params) => {
    calls.push({ method, params });
    return typeof answer === "function" ? answer(method, params) : answer;
  };
  return { bridge, calls };
}

test("a text answer is one text part, as always", async () => {
  const { bridge, calls } = stubBridge({ content: "done" });
  const reply = await handleRpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "send_message", arguments: { text: "hi" } } }, bridge);
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "done" }], isError: false } });
  assert.deepEqual(calls, [{ method: "tools/call", params: { name: "send_message", arguments: { text: "hi" } } }]);
});

test("an answer with parts keeps its text and its image", async () => {
  const { bridge } = stubBridge({ content: [{ type: "text", text: "The screen after the click." }, { type: "image", data: PNG, mimeType: "image/png" }], isError: false });
  const reply = await handleRpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "computer", arguments: { actions: [{ type: "click", x: 1, y: 2 }] } } }, bridge);
  assert.deepEqual(reply.result, {
    content: [
      { type: "text", text: "The screen after the click." },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
    isError: false,
  });
});

test("an error answer is still marked, and an odd answer is text", async () => {
  const { bridge } = stubBridge({ content: "No such bot", isError: true });
  const reply = await handleRpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ask_bot", arguments: {} } }, bridge);
  assert.deepEqual(reply.result, { content: [{ type: "text", text: "No such bot" }], isError: true });
  assert.deepEqual(mcpContent({ ok: true }), [{ type: "text", text: '{"ok":true}' }]);
  assert.deepEqual(mcpContent(undefined), [{ type: "text", text: '""' }]);
  assert.deepEqual(mcpContent([{ type: "video", data: "x" }]), [{ type: "text", text: '[{"type":"video","data":"x"}]' }]);
  assert.deepEqual(mcpContent([{ type: "text", text: "a" }, { type: "video" }]), [{ type: "text", text: "a" }]);
});

test("a tool call without a name, and a bridge that fails, are JSON-RPC errors", async () => {
  const { bridge } = stubBridge(() => {
    throw new Error("The box went away");
  });
  assert.equal((await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, bridge)).error.code, -32602);
  assert.equal((await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } }, bridge)).error.message, "The box went away");
  assert.equal(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, bridge), null);
});

test("the box takes a string or checked parts as a tool result", () => {
  assert.equal(toolResultContent("plain"), "plain");
  assert.equal(toolResultContent({ a: 1 }), '{"a":1}');
  assert.equal(toolResultContent(undefined), '""');
  assert.deepEqual(toolResultContent([{ type: "text", text: "t", extra: 1 }]), [{ type: "text", text: "t" }]);
  assert.deepEqual(toolResultContent([{ type: "image", data: PNG, mimeType: "image/jpeg" }]), [{ type: "image", data: PNG, mimeType: "image/jpeg" }]);
  const bad = (value, pattern) => assert.throws(() => toolResultContent(value), (error) => error.status === 400 && pattern.test(error.message));
  bad([], /at least one part/);
  bad([null], /must be an object/);
  bad([{ type: "text" }], /needs text/);
  bad([{ type: "image", mimeType: "image/png" }], /base64/);
  bad([{ type: "image", data: "not base64!", mimeType: "image/png" }], /base64/);
  bad([{ type: "image", data: PNG, mimeType: "image/gif" }], /image\/png or image\/jpeg/);
  bad([{ type: "image", data: "A".repeat(4 * 1024 * 1024 + 4), mimeType: "image/png" }], /larger than 3 MB/);
  bad([{ type: "audio", data: PNG }], /Unknown part type/);
});

test("the protocol log keeps no image bytes, in a prompt or in an echoed tool result", () => {
  const prompt = { type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "look" }] } };
  assert.deepEqual(loggable(prompt).message.content[0].source.data, "[4 base64 characters]");
  const echoed = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "after" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBBBBBB" } }] }],
    },
  };
  const logged = loggable(echoed);
  assert.deepEqual(logged.message.content[0].content, [{ type: "text", text: "after" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "[8 base64 characters]" } }]);
  assert.equal(echoed.message.content[0].content[1].source.data, "BBBBBBBB");
  const plain = { type: "user", message: { role: "user", content: "hello" } };
  assert.equal(loggable(plain), plain);
  const noMessage = { type: "system", subtype: "init" };
  assert.equal(loggable(noMessage), noMessage);
});
