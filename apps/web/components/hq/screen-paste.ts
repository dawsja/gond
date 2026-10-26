/** What pasting onto a bot's screen does; pure, so the choices are tested. */

export type PasteCode = "KeyV" | "Insert";

export function isPasteCode(code: string): code is PasteCode {
  return code === "KeyV" || code === "Insert";
}

/** What a paste chord on the screen does: nothing, a word that a bot holds it, or a paste. */
export function pasteChordAction({ connected, viewOnly, canTakeControl }: { connected: boolean; viewOnly: boolean; canTakeControl: boolean }): "ignore" | "held" | "paste" {
  if (!connected) return "ignore";
  if (viewOnly) return canTakeControl ? "held" : "ignore";
  return "paste";
}

/**
 * Where the person's text comes from. `readText` only where it answers without
 * asking (the desktop app allows it for its server, or the browser already
 * granted it); otherwise the browser's own paste event, which needs nothing.
 */
export function clipboardReadWay({ readText, permission, desktopApp }: { readText: boolean; permission: PermissionState | null; desktopApp: boolean }): "read" | "event" {
  if (!readText) return "event";
  return desktopApp || permission === "granted" ? "read" : "event";
}

/** The text to put on the screen's clipboard first; null leaves the screen's own clipboard to paste. */
export function pasteText(read: string | null | undefined, fromEvent: string | null | undefined): string | null {
  if (read) return read;
  return fromEvent ? fromEvent : null;
}

export type ScreenKey = { keysym: number; code: string; down: boolean };

const XK = { v: 0x76, insert: 0xff63, shiftL: 0xffe1, controlL: 0xffe3, altL: 0xffe9, superL: 0xffeb, superR: 0xffec } as const;

// The keysym noVNC sent when this Meta key went down: on a Mac or an iPad it
// passes Command as Alt, as TigerVNC's own viewer does.
function metaKeysym(code: "MetaLeft" | "MetaRight", apple: boolean) {
  if (apple) return code === "MetaLeft" ? XK.altL : XK.superL;
  return code === "MetaLeft" ? XK.superL : XK.superR;
}

/**
 * The keys that make the screen paste, given what the person still holds
 * (noVNC already sent those down). Linux pastes on Ctrl+V and Shift+Insert, so
 * Command (which reaches the screen as Alt or Super) is let go for the chord
 * and pressed again after, leaving the screen as noVNC thinks it is, and a
 * modifier let go while the clipboard was read is pressed around the key.
 */
export function chordKeys(code: PasteCode, held: ReadonlySet<string>, apple: boolean): ScreenKey[] {
  const keys: ScreenKey[] = [];
  if (code === "Insert") {
    const shift = held.has("ShiftLeft") || held.has("ShiftRight");
    if (!shift) keys.push({ keysym: XK.shiftL, code: "ShiftLeft", down: true });
    keys.push({ keysym: XK.insert, code: "Insert", down: true }, { keysym: XK.insert, code: "Insert", down: false });
    if (!shift) keys.push({ keysym: XK.shiftL, code: "ShiftLeft", down: false });
    return keys;
  }
  const metas = (["MetaLeft", "MetaRight"] as const).filter((meta) => held.has(meta));
  for (const meta of metas) keys.push({ keysym: metaKeysym(meta, apple), code: meta, down: false });
  const ctrl = held.has("ControlLeft") || held.has("ControlRight");
  if (!ctrl) keys.push({ keysym: XK.controlL, code: "ControlLeft", down: true });
  keys.push({ keysym: XK.v, code: "KeyV", down: true }, { keysym: XK.v, code: "KeyV", down: false });
  if (!ctrl) keys.push({ keysym: XK.controlL, code: "ControlLeft", down: false });
  for (const meta of metas) keys.push({ keysym: metaKeysym(meta, apple), code: meta, down: true });
  return keys;
}

/** The same test noVNC makes for its Command-as-Alt swap. */
export function appleKeyboard(platform: string) {
  return /mac|ipad|iphone|ipod/i.test(platform);
}
