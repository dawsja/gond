import { expect, test } from "bun:test";
import { isHandoff } from "../src/native.ts";

// The box is plain JavaScript with no types for the API to read.
const BOX_AGENTS = "../../../packages/box/agents.mjs";
const { isHandoff: boxIsHandoff } = (await import(BOX_AGENTS)) as { isHandoff: (name: unknown) => boolean };

const NAMES = ["message_bot", "delegate_bot", "ask_bot", "create_bot", "update_bot", "post_message", "Bash", "", "message_bots", "xmessage_bot", "message_bot ", "MESSAGE_BOT", "delegate", "message"];

test("the box and the API's own engines agree on which tools hand work to a teammate", () => {
  expect(isHandoff("message_bot") && isHandoff("delegate_bot")).toBe(true);
  for (const name of NAMES) {
    expect(boxIsHandoff(name)).toBe(isHandoff(name));
    // Claude Code calls Gond's tools through the gond MCP bridge; the API's engines call them by name.
    expect(boxIsHandoff(`mcp__gond__${name}`)).toBe(isHandoff(name));
    expect(boxIsHandoff(`mcp__other__${name}`)).toBe(false);
  }
  for (const value of [undefined, null, 42, {}, ["message_bot"]]) {
    expect(boxIsHandoff(value)).toBe(false);
    expect(isHandoff(value)).toBe(false);
  }
});
