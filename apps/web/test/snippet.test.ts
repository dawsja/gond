import { expect, test } from "bun:test";
import { matchSnippet, messageSnippet } from "../lib/snippet";

const LONG = "The nightly backups ran on time again. All three finished by 2:14 AM. The photo library took longest, and the documents were quick as always.";

test("a short message shows whole, its match set apart", () => {
  expect(matchSnippet("Clean the photo folder", "photo")).toEqual({ before: "Clean the ", match: "photo", after: " folder" });
});

test("the match keeps how the message wrote it", () => {
  expect(matchSnippet("Photos are done", "photo").match).toBe("Photo");
});

test("a long message is cut on word boundaries about forty characters either side", () => {
  const snippet = matchSnippet(LONG, "photo");
  expect(snippet.match).toBe("photo");
  expect(snippet.before).toBe("…All three finished by 2:14 AM. The ");
  expect(snippet.after).toBe(" library took longest, and the documents…");
  expect(snippet.before.length).toBeLessThanOrEqual(42);
  expect(snippet.after.length).toBeLessThanOrEqual(42);
});

test("the whole query is found first, else its first word", () => {
  expect(matchSnippet(LONG, "photo library").match).toBe("photo library");
  expect(matchSnippet(LONG, "photo albums").match).toBe("photo");
});

test("no match shows the start of the message", () => {
  const snippet = matchSnippet(LONG, "zebra");
  expect(snippet.before).toBe("");
  expect(snippet.match).toBe("");
  expect(snippet.after.endsWith("…")).toBe(true);
  expect(LONG.startsWith(snippet.after.slice(0, -1))).toBe(true);
});

test("characters that mean something to a pattern are found as written", () => {
  expect(matchSnippet("It costs $5 (or so)", "(or").match).toBe("(or");
});

test("markdown is read as plain words, and a message of files shows its first file's name", () => {
  expect(messageSnippet({ body: "## Done\nThe **photo** run", attachments: [] }, "photo")).toEqual({ before: "Done The ", match: "photo", after: " run" });
  expect(messageSnippet({ body: "", attachments: [{ id: "a", name: "photo-1.png", mediaType: "image/png", size: 1 }] }, "photo")).toEqual({ before: "", match: "photo", after: "-1.png" });
});
