import { describe, expect, test } from "bun:test";
import { inertChoices } from "../lib/spaces";

const line = (id: string, author: string, answering: string | null = null) => ({ id, author, answering });

describe("inertChoices", () => {
  test("a line from another Gond and a bot's answer to one can't be tapped", () => {
    const messages = [line("a", "remote:abcdef012345:sam"), line("b", "patch", "a"), line("c", "you"), line("d", "patch", "c"), line("e", "patch")];
    expect([...inertChoices(messages, true)].sort()).toEqual(["a", "b"]);
  });

  test("an answer to a line that isn't loaded is inert only in a space", () => {
    const messages = [line("b", "patch", "gone")];
    expect(inertChoices(messages, true).has("b")).toBe(true);
    expect(inertChoices(messages, false).has("b")).toBe(false);
  });
});
