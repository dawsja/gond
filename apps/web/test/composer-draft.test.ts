import { describe, expect, test } from "bun:test";
import { changeDraft, EMPTY_DRAFT, unsentBack, type Draft, type DraftChange } from "../lib/composer-draft";

const typed = (text: string): DraftChange => ({ by: "app", text });
const page = (text: string | ((text: string) => string)): DraftChange => ({ by: "page", text });
const run = (changes: DraftChange[], from: Draft = EMPTY_DRAFT) => changes.reduce(changeDraft, from);

// The iPhone app's field takes the page's text only when `rev` goes up.
describe("changeDraft", () => {
  test("a clear after a send reaches the app after a stale empty echo (typed, deleted, typed again)", () => {
    const before = run(["x", "", "x"].map(typed));
    const cleared = changeDraft(before, page(""));
    expect(cleared).toEqual({ text: "", rev: before.rev + 1 });
  });

  test("a page change equal to text the app sent still reaches the app", () => {
    const before = run([typed("hi @sam "), typed("hi")]);
    expect(changeDraft(before, page("hi @sam ")).rev).toBe(before.rev + 1);
  });

  test("the app's own typing never makes the app take the page's text", () => {
    const after = run(["h", "he", "hel", "", "hel", "hello"].map(typed));
    expect(after).toEqual({ text: "hello", rev: 0 });
  });

  test("every page change raises the count, the same text again too", () => {
    const after = run([typed("a"), page("a"), page("a"), page((d) => `${d} @sam `)]);
    expect(after).toEqual({ text: "a @sam ", rev: 3 });
  });

  test("a page change made after a long run of typing still reaches the app", () => {
    const keystrokes = Array.from({ length: 120 }, (_, n) => typed(n % 7 === 0 ? "" : "x".repeat(n)));
    const typedOut = run(keystrokes);
    expect(typedOut.rev).toBe(0);
    expect(changeDraft(typedOut, page("")).rev).toBe(1);
  });

  test("a page update reads the newest text, typing included", () => {
    expect(run([typed("hello"), page((d) => `${d} there`)]).text).toBe("hello there");
  });
});

describe("unsentBack", () => {
  test("a failed send puts its text back in an empty field", () => {
    expect(unsentBack("", "see you at 5")).toBe("see you at 5");
  });

  test("and keeps what was typed while it was on its way", () => {
    expect(unsentBack("and bring snacks", "see you at 5")).toBe("see you at 5\nand bring snacks");
  });
});
