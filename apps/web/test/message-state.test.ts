import { describe, expect, test } from "bun:test";
import { botsWaitingOnYou, notReadYet } from "../lib/message-state";

describe("notReadYet", () => {
  test("says when a working bot gets it, only in its own chat", () => {
    expect(notReadYet({ isRoom: false, botName: "Patch", working: true })).toBe("Not read yet · Patch gets it after this job");
    expect(notReadYet({ isRoom: false, botName: "Patch", working: false })).toBe("Not read yet");
    expect(notReadYet({ isRoom: true, botName: null, working: true })).toBe("Not read yet");
  });
});

describe("botsWaitingOnYou", () => {
  test("keeps the bots with a pending card in this conversation", () => {
    const approvals = [
      { botId: "a", threadId: "t1", status: "pending" as const },
      { botId: "b", threadId: "t1", status: "allowed" as const },
      { botId: "c", threadId: "t2", status: "pending" as const },
    ];
    expect([...botsWaitingOnYou(approvals, "t1")]).toEqual(["a"]);
  });
});
