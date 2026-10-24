import { describe, expect, test } from "bun:test";
import { historyStep, sentHistory } from "../lib/sent-history";

const line = (author: string, body: string, kind = "message") => ({ author, kind, body });

describe("sentHistory", () => {
  test("keeps the person's own lines, newest first, without bots, prompts, empty ones or a repeat in a row", () => {
    const messages = [
      line("you", "first"),
      line("bot-1", "a reply"),
      line("you", "  second  "),
      line("you", "second"),
      line("system", "hidden", "prompt"),
      line("you", ""),
      line("you", "third"),
    ];
    expect(sentHistory(messages)).toEqual(["third", "second", "first"]);
  });
});

describe("historyStep", () => {
  const base = { key: "ArrowUp", text: "", start: 0, end: 0, at: null, count: 3 };

  test("Up from an empty field goes to the newest, then older, and stops at the oldest", () => {
    expect(historyStep(base)).toBe(0);
    expect(historyStep({ ...base, text: "third", at: 0 })).toBe(1);
    expect(historyStep({ ...base, text: "first", at: 2 })).toBeNull();
  });

  test("Down goes back toward the newest and then to the empty field", () => {
    const down = { ...base, key: "ArrowDown", text: "second", start: 6, end: 6 };
    expect(historyStep({ ...down, at: 1 })).toBe(0);
    expect(historyStep({ ...down, at: 0 })).toBe(-1);
  });

  test("leaves the keys alone while the person is typing, selecting or moving between lines", () => {
    expect(historyStep({ ...base, text: "half a thought", start: 4, end: 4 })).toBeNull();
    expect(historyStep({ ...base, key: "ArrowDown" })).toBeNull();
    expect(historyStep({ ...base, text: "one\ntwo", start: 0, end: 3, at: 0 })).toBeNull();
    expect(historyStep({ ...base, text: "one\ntwo", start: 5, end: 5, at: 0 })).toBeNull();
    expect(historyStep({ ...base, key: "ArrowDown", text: "one\ntwo", start: 1, end: 1, at: 0 })).toBeNull();
    expect(historyStep({ ...base, key: "ArrowLeft" })).toBeNull();
  });

  test("with nothing sent there is nowhere to go", () => {
    expect(historyStep({ ...base, count: 0 })).toBeNull();
  });
});
