import { AI_SETUP_CARD, type Message } from "@gond/shared";
import { expect, test } from "bun:test";
import { helloOutcome } from "../lib/hello";

function line(over: Partial<Message>): Message {
  return { id: "m", threadId: "t", author: "you", kind: "message", body: "", attachments: [], depth: 0, approvalId: null, fromThreadId: null, steered: false, spoken: false, note: null, sentTo: null, reactions: [], replyTo: null, createdAt: "2026-10-26T12:00:00.000Z", ...over };
}

const sent = line({ id: "hi", body: "Hi! What can you do?" });

test("nothing yet while the bot works", () => {
  expect(helloOutcome([sent], sent, "b")).toEqual({ replies: [], failure: null });
});

test("the bot's answer after the hello is the reply", () => {
  const reply = line({ id: "r", author: "b", body: "Hello" });
  const earlier = line({ id: "e", author: "b", body: "Before", createdAt: "2026-10-26T11:00:00.000Z" });
  expect(helloOutcome([earlier, sent, reply], sent, "b").replies.map((m) => m.id)).toEqual(["r"]);
});

test("the setup card or a failure line answering the hello means it couldn't", () => {
  const card = line({ id: "c", author: "b", kind: "signin", approvalId: AI_SETUP_CARD, body: "No AI yet" });
  expect(helloOutcome([sent, card], sent, "b").failure?.id).toBe("c");
  const event = line({ id: "x", author: "system", kind: "event", answering: "hi", body: "Couldn't answer" });
  expect(helloOutcome([sent, event], sent, "b").failure?.id).toBe("x");
  const other = line({ id: "o", author: "system", kind: "event", body: "Room created" });
  expect(helloOutcome([sent, other], sent, "b").failure).toBeNull();
});

test("a reply wins over a failure from before a retry", () => {
  const event = line({ id: "x", author: "system", kind: "event", answering: "hi" });
  const reply = line({ id: "r", author: "b" });
  expect(helloOutcome([sent, event, reply], sent, "b")).toMatchObject({ failure: null });
});

test("a hello the page hasn't loaded yet is placed by its time", () => {
  const reply = line({ id: "r", author: "b", createdAt: "2026-10-26T12:00:05.000Z" });
  expect(helloOutcome([reply], sent, "b").replies.map((m) => m.id)).toEqual(["r"]);
});
