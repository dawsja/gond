import { describe, expect, test } from "bun:test";
import type { Approval, Message } from "@gond/shared";
import { approvalBatches, hasEarlier, markGone, mergeMessages, newestOf, putApprovals } from "../lib/history";

const at = (second: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, second)).toISOString();
const line = (id: string, second: number, extra: Partial<Message> = {}) => ({ id, createdAt: at(second), kind: "message", author: "you", body: id, ...extra }) as Message;
const ids = (messages: Message[]) => messages.map((m) => m.id);

describe("mergeMessages", () => {
  test("an earlier page goes on top and a catch-up below, each line once", () => {
    const shown = [line("c", 3), line("d", 4)];
    const withEarlier = mergeMessages(shown, [line("a", 1), line("b", 2), line("c", 3)]);
    expect(ids(withEarlier)).toEqual(["a", "b", "c", "d"]);
    expect(ids(mergeMessages(withEarlier, [line("d", 4), line("e", 5)]))).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a bot's line written just before the person's send lands above it", () => {
    const sent = mergeMessages([line("a", 1)], [line("mine", 3)]);
    expect(ids(mergeMessages(sent, [line("reply", 2), line("mine", 3)]))).toEqual(["a", "reply", "mine"]);
  });

  test("a line already shown keeps the copy shown, and nothing new keeps the list", () => {
    const shown = [line("a", 1, { body: "as shown" })];
    expect(mergeMessages(shown, [line("a", 1, { body: "again" })])).toBe(shown);
    expect(mergeMessages(shown, [])).toBe(shown);
  });
});

describe("cursors", () => {
  test("the catch-up's place only moves forward", () => {
    expect(newestOf(null, [])).toBeNull();
    expect(newestOf(null, [line("a", 1), line("b", 2)])).toBe(at(2));
    expect(newestOf(at(5), [line("a", 1)])).toBe(at(5));
    expect(newestOf(at(5), [])).toBe(at(5));
  });

  test("a short page is the start of the conversation", () => {
    expect(hasEarlier([line("a", 1), line("b", 2)], 2)).toBe(true);
    expect(hasEarlier([line("a", 1)], 2)).toBe(false);
  });
});

describe("approvals", () => {
  const card = (id: string, approvalId: string | null) => line(id, 1, { kind: "approval", author: "bot", approvalId } as Partial<Message>);

  test("each page asks once for the approvals it shows, a hundred at a time", () => {
    const page = [card("m1", "a1"), card("m2", "a1"), card("m3", null), line("m4", 2), ...Array.from({ length: 150 }, (_, i) => card(`n${i}`, `b${i}`))];
    const batches = approvalBatches(page, new Set(["b0"]));
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(batches[0]![0]).toBe("a1");
    expect(batches.flat()).not.toContain("b0");
    expect(approvalBatches(page, new Set(batches.flat().concat("b0")))).toEqual([]);
  });

  test("an approval read again unchanged keeps the map and the object", () => {
    const pending = { id: "a1", status: "pending", input: { command: "ls" } } as unknown as Approval;
    const known = putApprovals(new Map(), [pending]);
    expect(putApprovals(known, [{ ...pending, input: { command: "ls" } }])).toBe(known);
    const answered = putApprovals(known, [{ ...pending, status: "allowed" }]);
    expect(answered).not.toBe(known);
    expect(answered.get("a1")?.status).toBe("allowed");
    expect(answered.get("a1")?.input).toBe(pending.input);
  });

  test("a card the server answered without reads as gone, never over one it knows", () => {
    const pending = { id: "a1", status: "pending" } as unknown as Approval;
    const known = putApprovals(new Map(), [pending]);
    const marked = markGone(known, ["a1", "a2"]);
    expect(marked.get("a1")).toBe(pending);
    expect(marked.get("a2")).toBeNull();
    expect(markGone(marked, ["a1", "a2"])).toBe(marked);
  });
});
