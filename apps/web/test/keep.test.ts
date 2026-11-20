import { describe, expect, test } from "bun:test";
import { keep } from "../lib/keep";

const bots = () => [
  { id: "a", name: "Ada", tools: ["web"], look: { color: "#f00" } },
  { id: "b", name: "Bo", tools: [], look: { color: "#0f0" } },
];

describe("keep", () => {
  test("a reload that changed nothing hands back the same list", () => {
    const shown = bots();
    expect(keep(shown, bots())).toBe(shown);
  });

  test("only the row that changed is new, and its unchanged parts stay", () => {
    const shown = bots();
    const next = bots();
    next[1]!.name = "Bob";
    const kept = keep(shown, next);
    expect(kept).not.toBe(shown);
    expect(kept[0]).toBe(shown[0]!);
    expect(kept[1]).not.toBe(shown[1]!);
    expect(kept[1]!.name).toBe("Bob");
    expect(kept[1]!.look).toBe(shown[1]!.look);
  });

  test("a row that moved up the list is still the same row", () => {
    const shown = bots();
    const kept = keep(shown, bots().reverse());
    expect(kept.map((b) => b.id)).toEqual(["b", "a"]);
    expect(kept[0]).toBe(shown[1]!);
    expect(kept[1]).toBe(shown[0]!);
  });

  test("a field that went away, or one that came, makes the row new", () => {
    const shown: Record<string, unknown>[] = [{ id: "a", busy: true }];
    expect(keep(shown, [{ id: "a" }])[0]).not.toBe(shown[0]!);
    expect(keep(shown, [{ id: "a", busy: true, extra: undefined }])[0]).not.toBe(shown[0]!);
  });

  test("nothing before means the new value as it came", () => {
    const next = { thread: { id: "t" }, bot: null };
    expect(keep(null, next)).toBe(next);
  });
});
