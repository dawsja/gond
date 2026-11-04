import { describe, expect, test } from "bun:test";
import { composerLayout } from "../lib/composer-layout";

describe("composerLayout", () => {
  test("empty is unstacked regardless of measurement or previous layout", () => {
    for (const needsRows of [false, true]) {
      for (const previous of [false, true]) {
        expect(composerLayout("", needsRows, previous)).toBe(false);
      }
    }
  });

  test("short text starts inline and wrapped text stacks", () => {
    expect(composerLayout("Hi", false, false)).toBe(false);
    expect(composerLayout("A message that wraps", true, false)).toBe(true);
  });

  test("the wider field cannot undo stacking while non-empty, even when shortened", () => {
    const wrapped = composerLayout("A message that wraps", true, false);
    const wider = composerLayout("A message that wraps", false, wrapped);
    expect(wider).toBe(true);
    expect(composerLayout("Hi", false, wider)).toBe(true);
  });

  test("draft changes alone clear stacking without another resize notification", () => {
    let stacked = composerLayout("A message that wraps", true, false);
    // The only measurement after wrapping is the shortened field's one-line height.
    stacked = composerLayout("Hi", false, stacked);
    expect(stacked).toBe(true);
    stacked = composerLayout("", false, stacked);
    expect(stacked).toBe(false);
    expect(composerLayout("New draft", false, stacked)).toBe(false);
  });
});
