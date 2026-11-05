import { expect, test } from "bun:test";
import { agentToolsFor } from "../src/driver.ts";
import { ALWAYS_LOAD_TOOLS } from "../src/coordination.ts";

const tool = { description: "test", inputSchema: { type: "object", properties: {} }, execute: async () => "" };

test("only coordination tools are always loaded in non-guest Claude sessions", () => {
  const expected = ["message_bot", "ask_bot", "delegate_bot", "list_bots", "post_message", "amend_handoff", "cancel_handoff", "list_handoffs", "hand_over"];
  expect([...ALWAYS_LOAD_TOOLS].sort()).toEqual(expected.sort());
  const tools = Object.fromEntries([...expected, "other"].map((name) => [name, tool]));
  const listed = agentToolsFor(tools, "claude");
  for (const entry of listed) {
    expect(entry._meta).toEqual(ALWAYS_LOAD_TOOLS.has(entry.name) ? { "anthropic/alwaysLoad": true } : undefined);
  }
  for (const mode of [["claude", "talk"], ["claude", "look"], ["api", undefined]] as const) {
    expect(agentToolsFor(tools, mode[0], mode[1]).every((entry) => entry._meta === undefined)).toBe(true);
  }
});
