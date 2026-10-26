"use client";

import { useEffect, useSyncExternalStore } from "react";
import { mobileShell, type GondMobile } from "@/lib/shell";

/*
 * The iPhone app draws a few things itself, in Liquid Glass: a destructive confirm, a message's
 * long-press menu, the picture viewer, and a conversation's header and composer. The page asks with
 * `present` and hears the answer as a `gond:native` event; the conversation hands its chrome over
 * with `chrome` and hears what the person did there as `gond:native-chrome`. Anywhere else (a
 * browser, Android, the desktop, an older iPhone app) the page draws everything as before.
 */

type Native = GondMobile & Required<Pick<GondMobile, "present" | "chrome">>;

function bridge(): Native | null {
  const mobile = mobileShell();
  return mobile && typeof mobile.present === "function" && typeof mobile.chrome === "function" ? (mobile as Native) : null;
}

const never = () => () => {};

/** Whether the app around this page draws the native pieces; false on the server's render, so it hydrates as sent. */
export function useNativeUi(): boolean {
  return useSyncExternalStore(never, () => bridge() !== null, () => false);
}

/** Whether the app draws a call's bar in the composer's place; an older one doesn't, and the page keeps the chrome for a call. */
export function useNativeCallBar(): boolean {
  return useSyncExternalStore(
    never,
    () => {
      const native = bridge();
      return typeof native?.features === "function" && native.features().includes("call");
    },
    () => false,
  );
}

export type NativeMenuItem = { id: string; label: string; symbol: string; destructive?: boolean };

export type NativeRequest =
  | { kind: "confirm"; title: string; message: string; action: string; destructive: boolean }
  | {
      kind: "message";
      rect: { x: number; y: number; width: number; height: number };
      mine: boolean;
      reactions: { options: readonly string[]; mine: string | null } | null;
      items: NativeMenuItem[];
      /** How the lifted copy is cut: a bubble's corners (the default), a row's, or a face's circle. */
      shape?: "bubble" | "row" | "circle";
    }
  | { kind: "pictures"; items: { url: string; name: string }[]; index: number }
  | { kind: "toast"; title: string; description: string; tone: "error" | "success" | "info" };

export type NativeAnswer = { confirm: boolean; message: { action?: string; react?: string }; pictures: null; toast: null };

let next = 0;
const waiting = new Map<string, (value: unknown) => void>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("gond:native", (event) => {
    const detail = (event as CustomEvent<{ id?: string; value?: unknown }>).detail;
    const done = detail?.id ? waiting.get(detail.id) : undefined;
    if (!done) return;
    waiting.delete(detail!.id!);
    done(detail!.value ?? null);
  });
}

/** Shows a native piece that answers nothing, like a toast. */
export function tellNative(request: Extract<NativeRequest, { kind: "toast" }>) {
  const native = bridge();
  if (!native) return;
  const { kind, ...rest } = request;
  native.present(kind, JSON.stringify({ id: `native-${++next}`, ...rest }));
}

/** Shows a native piece and waits for what the person picked there; null when they closed it, or when there is no app to ask. */
export function askNative<K extends NativeRequest["kind"]>(request: Extract<NativeRequest, { kind: K }>): Promise<NativeAnswer[K] | null> {
  const native = bridge();
  if (!native) return Promise.resolve(null);
  listen();
  const id = `native-${++next}`;
  const { kind, ...rest } = request;
  return new Promise((resolve) => {
    waiting.set(id, (value) => resolve(value as NativeAnswer[K] | null));
    native.present(kind, JSON.stringify({ id, ...rest }));
  });
}

export type ChromeState = {
  /** The conversation, so the app starts its composer afresh for another one. */
  thread: string;
  title: string;
  subtitle: string;
  working: boolean;
  /** The bot's face, or a room's two in front, as PNG data URLs. */
  faces: string[];
  more: number;
  primary: boolean;
  /** The conversation is a space, so the faces wear its globe. */
  space: boolean;
  tint: string;
  menu: NativeMenuItem[][];
  /** Something of the page's is open over the conversation (a sheet, a dialog, a menu), so the chrome steps aside. */
  covered: boolean;
  /** Above the composer: the room's bots to @mention (with their faces), the files to send, the quote being answered. */
  mentions: { id: string; handle: string; face: string | null }[];
  files: { name: string; size: string }[];
  replying: { name: string; color: string; text: string } | null;
  /** The conversation can scroll on to its newest message, so the app shows its jump arrow. */
  jump: boolean;
  /** The bots' screens in use, each a pill under the header that opens it. */
  screens: { id: string; label: string }[];
  /** On a call with the bot, which takes the composer's place; `since` is when it was picked up, in milliseconds. */
  call: { label: string; since: number; connecting: boolean; muted: boolean; speaking: boolean; color: string } | null;
  composer: {
    text: string;
    /** Goes up when the page changed the text itself (sent, a mention, a dictation), so the app takes it. */
    textRev: number;
    focusRev: number;
    placeholder: string;
    canSend: boolean;
    sending: boolean;
    later: boolean;
    voice: "off" | "idle" | "recording" | "working";
    seconds: number;
  };
};

/** The Chats screen's header in the iPhone app: your picture, Search and New. */
export type ChatsChromeState = {
  screen: "chats";
  /** Search is open: the app draws the field, and the page shows what it finds. */
  searching: boolean;
  /** Your picture as a PNG, or null for your initial on a plain circle. */
  face: string | null;
  initial: string;
  canNewRoom: boolean;
  covered: boolean;
};

export type ChromeEvent =
  | { type: "back" }
  | { type: "details" }
  | { type: "menu"; id: string }
  | { type: "text"; value: string }
  | { type: "send"; later?: boolean }
  | { type: "voice" }
  | { type: "attach"; files: { name: string; type: string; data: string }[] }
  | { type: "notice"; text: string }
  | { type: "settings" }
  | { type: "search" }
  | { type: "new"; kind: "new-bot" | "new-room" }
  | { type: "query"; value: string }
  | { type: "cancel-search" }
  | { type: "mention"; id: string }
  | { type: "remove-file"; index: number }
  | { type: "cancel-reply" }
  | { type: "jump" }
  | { type: "screen"; id: string }
  | { type: "call-mute" }
  | { type: "call-end" };

/** A Settings page's back button in the iPhone app. */
export type SettingsChromeState = { screen: "settings"; label: string; covered: boolean };

export type AnyChrome = ChromeState | ChatsChromeState | SettingsChromeState;

/** Hands the conversation's header and composer to the app while `state` is set, and takes them back when it isn't. */
export function useNativeChrome(state: AnyChrome | null, onEvent: (event: ChromeEvent) => void) {
  const json = state ? JSON.stringify(state) : null;
  useEffect(() => {
    bridge()?.chrome(json ?? "null");
  }, [json]);
  useEffect(() => () => bridge()?.chrome("null"), []);
  useEffect(() => {
    if (!bridge()) return;
    const onChrome = (event: Event) => {
      const detail = (event as CustomEvent<ChromeEvent>).detail;
      if (detail && typeof detail.type === "string") onEvent(detail);
    };
    window.addEventListener("gond:native-chrome", onChrome);
    return () => window.removeEventListener("gond:native-chrome", onChrome);
  }, [onEvent]);
}

/** Files the app picked, as the page's own File objects. */
export async function filesFrom(picked: { name: string; type: string; data: string }[]): Promise<File[]> {
  return Promise.all(
    picked.map(async (file) => {
      const blob = await (await fetch(`data:${file.type || "application/octet-stream"};base64,${file.data}`)).blob();
      return new File([blob], file.name, { type: file.type || blob.type });
    }),
  );
}

/** A CSS colour as #rrggbb, whatever the page wrote it in (oklch, color-mix), for the app to paint with. */
export function hexOf(css: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context || !css) return "";
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/** An avatar on the page (its svg or picture) drawn into a square PNG, for the app's header. */
export async function avatarPng(avatar: Element, size = 96): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const picture = avatar.querySelector("img");
  if (picture && !picture.complete) await picture.decode().catch(() => undefined);
  const svg = avatar.querySelector("svg");
  let source: HTMLImageElement;
  if (picture && picture.complete && picture.naturalWidth) {
    source = picture;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    context.clip();
  } else if (svg) {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(size));
    copy.setAttribute("height", String(size));
    source = new Image();
    source.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
    await source.decode().catch(() => undefined);
    if (!source.naturalWidth) return null;
  } else {
    return null;
  }
  context.drawImage(source, 0, 0, size, size);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
