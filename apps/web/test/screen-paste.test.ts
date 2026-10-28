import { describe, expect, test } from "bun:test";
import { isPasteChord } from "../components/hq/clipboard";
import { appleKeyboard, chordKeys, clipboardReadWay, isPasteCode, pasteChordAction, pasteText } from "../components/hq/screen-paste";

const keys = (...held: string[]) => new Set(held);
const names = (list: { code: string; down: boolean }[]) => list.map((key) => `${key.code}${key.down ? "+" : "-"}`);
const chord = (code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>>) => ({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

describe("isPasteChord", () => {
  test("is Ctrl+V, Command+V and Shift+Insert, never with Alt", () => {
    expect(isPasteChord(chord("KeyV", { ctrlKey: true }))).toBe(true);
    expect(isPasteChord(chord("KeyV", { metaKey: true }))).toBe(true);
    expect(isPasteChord(chord("KeyV", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPasteChord(chord("Insert", { shiftKey: true }))).toBe(true);
    expect(isPasteChord(chord("KeyV", {}))).toBe(false);
    expect(isPasteChord(chord("KeyV", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPasteChord(chord("Insert", { shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  test("only V and Insert are paste keys", () => {
    expect(isPasteCode("KeyV")).toBe(true);
    expect(isPasteCode("Insert")).toBe(true);
    expect(isPasteCode("KeyC")).toBe(false);
  });
});

describe("pasteChordAction", () => {
  test("pastes when the person may type", () => {
    expect(pasteChordAction({ connected: true, viewOnly: false, canTakeControl: true })).toBe("paste");
  });

  test("says a bot holds the screen instead of dropping the paste", () => {
    expect(pasteChordAction({ connected: true, viewOnly: true, canTakeControl: true })).toBe("held");
  });

  test("stays quiet where control can't be taken, or before the screen connects", () => {
    expect(pasteChordAction({ connected: true, viewOnly: true, canTakeControl: false })).toBe("ignore");
    expect(pasteChordAction({ connected: false, viewOnly: false, canTakeControl: true })).toBe("ignore");
  });
});

describe("clipboardReadWay", () => {
  test("reads the clipboard in the desktop app, which allows it for its server", () => {
    expect(clipboardReadWay({ readText: true, permission: null, desktopApp: true })).toBe("read");
  });

  test("reads it in a browser only once it is granted", () => {
    expect(clipboardReadWay({ readText: true, permission: "granted", desktopApp: false })).toBe("read");
    expect(clipboardReadWay({ readText: true, permission: "prompt", desktopApp: false })).toBe("event");
    expect(clipboardReadWay({ readText: true, permission: "denied", desktopApp: false })).toBe("event");
    expect(clipboardReadWay({ readText: true, permission: null, desktopApp: false })).toBe("event");
  });

  test("uses the paste event where there is no readText", () => {
    expect(clipboardReadWay({ readText: false, permission: "granted", desktopApp: true })).toBe("event");
  });
});

describe("pasteText", () => {
  test("prefers what was read, then the paste event's text", () => {
    expect(pasteText("read", "event")).toBe("read");
    expect(pasteText(null, "event")).toBe("event");
    expect(pasteText("", "event")).toBe("event");
  });

  test("leaves the screen's own clipboard when there is nothing", () => {
    expect(pasteText(null, null)).toBeNull();
    expect(pasteText(undefined, "")).toBeNull();
  });
});

describe("chordKeys", () => {
  test("Ctrl held: only V goes", () => {
    expect(names(chordKeys("KeyV", keys("ControlLeft"), false))).toEqual(["KeyV+", "KeyV-"]);
  });

  test("Ctrl let go while the clipboard was read: Ctrl is pressed around V", () => {
    expect(names(chordKeys("KeyV", keys(), false))).toEqual(["ControlLeft+", "KeyV+", "KeyV-", "ControlLeft-"]);
  });

  test("Command+V pastes with Ctrl, Command let go for it and held again after", () => {
    const sent = chordKeys("KeyV", keys("MetaLeft"), true);
    expect(names(sent)).toEqual(["MetaLeft-", "ControlLeft+", "KeyV+", "KeyV-", "ControlLeft-", "MetaLeft+"]);
    // noVNC sent the left Command key down as Alt on a Mac.
    expect(sent[0].keysym).toBe(0xffe9);
    expect(sent.at(-1)?.keysym).toBe(0xffe9);
    expect(chordKeys("KeyV", keys("MetaLeft"), false)[0].keysym).toBe(0xffeb);
  });

  test("Shift+Insert presses Shift again only when it was let go", () => {
    expect(names(chordKeys("Insert", keys("ShiftRight"), false))).toEqual(["Insert+", "Insert-"]);
    expect(names(chordKeys("Insert", keys(), false))).toEqual(["ShiftLeft+", "Insert+", "Insert-", "ShiftLeft-"]);
  });

  test("V is sent as the lower-case keysym", () => {
    expect(chordKeys("KeyV", keys("ControlRight"), false).map((key) => key.keysym)).toEqual([0x76, 0x76]);
  });
});

describe("appleKeyboard", () => {
  test("matches noVNC's test", () => {
    expect(appleKeyboard("MacIntel")).toBe(true);
    expect(appleKeyboard("iPad")).toBe(true);
    expect(appleKeyboard("Linux x86_64")).toBe(false);
    expect(appleKeyboard("Win32")).toBe(false);
  });
});
