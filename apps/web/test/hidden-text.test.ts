import { describe, expect, test } from "bun:test";
import { codePoint, hiddenParts } from "../lib/hidden-text";

describe("hidden characters on a card", () => {
  test("a reordering or invisible character is its own part, named by its code; lines and tabs stay", () => {
    const command = "rm -rf ./build\u202e\u2066 /home\u200b\n\tls";
    const parts = hiddenParts(command);
    expect(parts.filter((part) => part.hidden).map((part) => codePoint(part.text))).toEqual(["U+202E", "U+2066", "U+200B"]);
    expect(parts.map((part) => part.text).join("")).toBe(command);
    expect(hiddenParts("echo hi\n\tthere")).toEqual([{ text: "echo hi\n\tthere", hidden: false }]);
  });
});
