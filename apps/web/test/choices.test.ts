import { describe, expect, test } from "bun:test";
import type { Message } from "@gond/shared";
import { choiceAnswers, joinPicks, splitPicks } from "../lib/choices";

type Line = Pick<Message, "id" | "author" | "kind" | "body" | "replyTo">;
const bot = (id: string, body: string): Line => ({ id, author: "b1", kind: "message", body, replyTo: null });
const you = (id: string, body: string, replyTo?: string): Line => ({ id, author: "you", kind: "message", body, replyTo: replyTo ? { id: replyTo, author: "b1", text: "" } : null });

describe("choiceAnswers", () => {
  test("a pick answers only the question it replies to, so two open at once stay apart", () => {
    const answers = choiceAnswers([bot("q1", "Delete the old ones? ::choices[Yes | No]"), bot("q2", "Restart tonight? ::choices[Yes | No]"), you("p1", "Yes", "q2")]);
    expect(answers.get("q2")).toEqual({ picks: ["Yes"], closedBy: null });
    expect(answers.get("q1")).toEqual({ picks: [], closedBy: null });
  });

  test("a line of their own closes every question above it, and a reply that's no option closes the one it quotes", () => {
    const answers = choiceAnswers([bot("q1", "A? ::choices[Yes | No]"), bot("q2", "B? ::choices[Red | Blue]"), you("r1", "Neither, ask me later", "q2"), you("l1", "yes"), bot("q3", "C? ::choices[Yes | No]")]);
    expect(answers.get("q2")!.closedBy).toBe("Neither, ask me later");
    expect(answers.get("q1")!.closedBy).toBe("yes");
    expect(answers.get("q3")).toEqual({ picks: [], closedBy: null });
  });

  test("in a room the @handle in front of a pick is left out, and two rows of one message are answered one by one", () => {
    const answers = choiceAnswers([bot("q1", "Size? ::choices[Small | Large]\n\nColor? ::choices[Red | Blue]"), you("p1", "@patch Large", "q1")]);
    expect(answers.get("q1")).toEqual({ picks: ["Large"], closedBy: null });
  });

  test("picks cross to a line as one string and come back the same", () => {
    const answer = { picks: ["Large", "Red"], closedBy: null };
    expect(splitPicks(joinPicks(answer))).toEqual(["Large", "Red"]);
    expect(splitPicks(joinPicks(undefined))).toEqual([]);
  });
});
