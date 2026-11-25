"use client";

import { useEffect, useSyncExternalStore } from "react";
import { macShell, mobileShell } from "@/lib/shell";

/*
 * The iPhone and Mac apps draw a few things themselves, in Liquid Glass: a destructive confirm, a
 * message's menu, the picture viewer, and a conversation's header and composer; the Mac app the
 * sidebar too. The page asks with `present` and hears the answer as a `gond:native` event; the
 * conversation hands its chrome over with `chrome` and hears what the person did there as
 * `gond:native-chrome`; the Mac's sidebar is drawn from `sidebar` and answers as `gond:native-sidebar`.
 * Anywhere else (a browser, Android, the desktop, an older iPhone app) the page draws everything as
 * before.
 */

type Native = { present(kind: string, request: string): void; chrome(state: string): void; features?(): string[] };

function bridge(): Native | null {
  const app = mobileShell() ?? macShell();
  return app && typeof app.present === "function" && typeof app.chrome === "function" ? (app as Native) : null;
}

function features(): string[] {
  const native = bridge();
  return typeof native?.features === "function" ? native.features() : [];
}

const never = () => () => {};

export function useNativeUi(): boolean {
  return useSyncExternalStore(never, () => bridge() !== null, () => false);
}

/**
 * Which app draws them: the iPhone's opens a message's menu on a long press and draws the Chats
 * screen's header and Settings' back button; the Mac's opens the menu on a right-click and has a
 * sidebar instead.
 */
export function useNativeApp(): "iphone" | "mac" | null {
  return useSyncExternalStore(never, () => (bridge() === null ? null : mobileShell() ? "iphone" : "mac"), () => null);
}

function sidebarBridge(): { sidebar(state: string): void } | null {
  const mac = macShell();
  return mac && typeof mac.sidebar === "function" && features().includes("sidebar") ? mac : null;
}

export function useNativeSidebar(): boolean {
  return useSyncExternalStore(never, () => sidebarBridge() !== null, () => false);
}

export type NativeMenuItem = { id: string; label: string; symbol: string; destructive?: boolean };

type NativeRequest =
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

type NativeAnswer = { confirm: boolean; message: { action?: string; react?: string }; pictures: null; toast: null };

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

export function tellNative(request: Extract<NativeRequest, { kind: "toast" }>) {
  const native = bridge();
  if (!native) return;
  const { kind, ...rest } = request;
  native.present(kind, JSON.stringify({ id: `native-${++next}`, ...rest }));
}

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
  tint: string;
  menu: NativeMenuItem[][];
  /** Something of the page's is open over the conversation (a sheet, a dialog, a menu), so the chrome steps aside. */
  covered: boolean;
  mentions: { id: string; handle: string; face: string | null }[];
  files: { name: string; size: string }[];
  replying: { name: string; color: string; text: string } | null;
  /** The conversation can scroll on to its newest message, so the app shows its jump arrow. */
  jump: boolean;
  screens: { id: string; label: string }[];
  /** Where the conversation sits across the web view, in CSS pixels: the Mac app centres its composer in it, clear of the details beside it. */
  column: { x: number; width: number };
  composer: {
    text: string;
    textRev: number;
    focusRev: number;
    placeholder: string;
    canSend: boolean;
    sending: boolean;
    later: boolean;
  };
};

type ChatsChromeState = {
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
  | { type: "screen"; id: string };

type SettingsChromeState = { screen: "settings"; label: string; covered: boolean };

type AnyChrome = ChromeState | ChatsChromeState | SettingsChromeState;

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

export type SidebarRow = {
  id: string;
  path: string;
  title: string;
  /** The bot's title, "" for a room. */
  job: string;
  pinned: boolean;
  /** Already worded by the page (`shortTime`), "" when nothing was said yet. */
  time: string;
  preview: string;
  previewKind: "text" | "working" | "draft";
  unread: "you" | "team" | null;
  /** #rrggbb: the bot's colour for the unread dot, the page's text colour for a room's. */
  color: string;
  /** A key into the faces the app was sent. */
  face: string;
  active: boolean;
  working: boolean;
  menu: NativeMenuItem[][];
};

export type SidebarTile = Pick<SidebarRow, "id" | "path" | "title" | "face" | "active" | "working" | "unread" | "color" | "menu">;

export type SidebarHit = { id: string; path: string; title: string; time: string; snippet: string };

export type SidebarSection = { id: string; label: string; symbol: string; path: string; active: boolean };

/** The Mac app's sidebar, drawn from what the page's own sidebar shows; sent whole on every change. */
export type SidebarState = {
  mode: "chats" | "settings";
  /** The detail's title when no conversation hands over chrome (Settings' section, or "Gond"). */
  title: string;
  covered: boolean;
  /** PNGs by face key, only those not sent before in this page's life: the app keeps them until the page reloads. */
  faces: Record<string, string>;

  query: string;
  loaded: boolean;
  /** No bots at all: "No bots yet" and "Create your first bot" (`new` with new-bot). */
  empty: boolean;
  pinned: SidebarTile[];
  rows: SidebarRow[];
  hits: SidebarHit[];
  look: { label: string; count: number } | null;
  newItems: NativeMenuItem[];
  /** `face` is a key into the faces too, null for your initial on a plain circle; `profile` is the open profile's name when there are several. */
  me: { name: string; face: string | null; initial: string; profile: string | null; active: boolean };
  profileMenu: NativeMenuItem[][];

  sections: { label: string; items: SidebarSection[] }[];
};

export type SidebarEvent =
  | { type: "open"; path: string }
  | { type: "search"; value: string }
  | { type: "row-menu"; thread: string; id: string }
  | { type: "new"; id: string }
  | { type: "profile"; id: string }
  | { type: "look" }
  | { type: "dismiss" };

// At most one send a frame: the state as it is then, with the faces drawn since the last one.
let sidebarBody: string | null = null;
let sidebarSent: string | null = null;
let sidebarFrame = 0;
let facesWaiting: Record<string, string> = {};
const facesSent = new Set<string>();

function flushSidebar() {
  sidebarFrame = 0;
  const native = sidebarBridge();
  if (!native) return;
  if (sidebarBody === null) {
    if (sidebarSent !== null) native.sidebar("null");
    sidebarSent = null;
    return;
  }
  const faces = facesWaiting;
  const fresh = Object.keys(faces);
  if (sidebarBody === sidebarSent && fresh.length === 0) return;
  facesWaiting = {};
  for (const key of fresh) facesSent.add(key);
  native.sidebar(`{"faces":${JSON.stringify(faces)},${sidebarBody.slice(1)}`);
  sidebarSent = sidebarBody;
}

function sendSidebarSoon() {
  if (!sidebarFrame && typeof window !== "undefined") sidebarFrame = window.requestAnimationFrame(flushSidebar);
}

export function faceSent(key: string): boolean {
  return facesSent.has(key) || key in facesWaiting;
}

export function sendFaces(faces: Record<string, string>) {
  Object.assign(facesWaiting, faces);
  sendSidebarSoon();
}

export function useNativeSidebarState(state: Omit<SidebarState, "faces">, onEvent: (event: SidebarEvent) => void) {
  const json = JSON.stringify(state);
  useEffect(() => {
    sidebarBody = json;
    sendSidebarSoon();
  }, [json]);
  useEffect(
    () => () => {
      sidebarBody = null;
      sendSidebarSoon();
    },
    [],
  );
  useEffect(() => {
    if (!sidebarBridge()) return;
    const onSidebar = (event: Event) => {
      const detail = (event as CustomEvent<SidebarEvent>).detail;
      if (detail && typeof detail.type === "string") onEvent(detail);
    };
    window.addEventListener("gond:native-sidebar", onSidebar);
    return () => window.removeEventListener("gond:native-sidebar", onSidebar);
  }, [onEvent]);
}

export async function filesFrom(picked: { name: string; type: string; data: string }[]): Promise<File[]> {
  return picked.map((file) => {
    const raw = atob(file.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new File([bytes], file.name, { type: file.type || "application/octet-stream" });
  });
}

/** A CSS colour as #rrggbb, whatever the page wrote it in (oklch, color-mix), for the app to paint with; "" when it can't be read. */
export function hexOf(css: string): string {
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !css) return "";
  context.fillStyle = css;
  const parsed = String(context.fillStyle);
  if (/^#[0-9a-f]{6}$/i.test(parsed)) return parsed.toLowerCase();
  context.fillRect(0, 0, 1, 1);
  try {
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    // WebKit refuses to read a canvas back when its graphics are unavailable.
    return "";
  }
}

/** A canvas as a PNG data URL, or null when the browser can't read it back (WebKit then gives "data:,"). */
function pngOf(canvas: HTMLCanvasElement): string | null {
  try {
    const url = canvas.toDataURL("image/png");
    return url.startsWith("data:image/png") ? url : null;
  } catch {
    return null;
  }
}

/** Whether every picture in a face has loaded: until one has, its avatar shows the fallback and holds no img. */
export function picturesLoaded(face: Element): boolean {
  return [...face.querySelectorAll("[data-slot=avatar]")].every((avatar) => avatar.querySelector("img"));
}

export async function avatarPng(avatar: Element, size = 96): Promise<string | null> {
  try {
    return await drawAvatar(avatar, size);
  } catch {
    return null;
  }
}

async function drawAvatar(avatar: Element, size: number): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  // In memory rather than on the GPU, so WebKit reads it back even on a Mac without a real GPU (a VM).
  const context = canvas.getContext("2d", { willReadFrequently: true });
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
  return pngOf(canvas);
}

export async function facePng(face: Element, size = 128): Promise<string | null> {
  try {
    return await drawFace(face, size);
  } catch {
    return null;
  }
}

async function drawFace(face: Element, size: number): Promise<string | null> {
  const box = face.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  // In memory rather than on the GPU, so WebKit reads it back even on a Mac without a real GPU (a VM).
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const scale = size / Math.max(box.width, box.height);
  context.scale(scale, scale);
  context.translate(-box.left, -box.top);
  for (const part of [face, ...face.querySelectorAll("*")]) {
    if (part.parentElement?.closest("svg")) continue;
    const rect = part.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const style = getComputedStyle(part);
    const radius = Math.min(rect.width / 2, rect.height / 2, parseFloat(style.borderTopLeftRadius) || 0);
    const ring = ringOf(style.boxShadow);
    if (ring) clear(context, rect, radius, ring);
    if (part.hasAttribute("data-cut")) {
      clear(context, rect, radius, 0);
      continue;
    }
    const gradient = gradientOf(context, style.backgroundImage, rect);
    if (gradient || alphaOf(style.backgroundColor) > 0) {
      context.fillStyle = gradient ?? style.backgroundColor;
      shape(context, rect, radius, 0);
      context.fill();
    }
    const border = parseFloat(style.borderTopWidth) || 0;
    if (border > 0 && alphaOf(style.borderTopColor) > 0) {
      context.strokeStyle = style.borderTopColor;
      context.lineWidth = border;
      shape(context, rect, Math.max(0, radius - border / 2), -border / 2);
      context.stroke();
    }
    if (part instanceof SVGSVGElement) await drawSvg(context, part, rect, style.color, scale);
    else if (part instanceof HTMLImageElement) await drawPicture(context, part, rect, Math.max(radius, part.parentElement ? parseFloat(getComputedStyle(part.parentElement).borderTopLeftRadius) || 0 : 0));
    else {
      const text = [...part.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").trim();
      if (text) {
        context.fillStyle = style.color;
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(text, rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    }
  }
  return pngOf(canvas);
}

function shape(context: CanvasRenderingContext2D, rect: DOMRect, radius: number, inset: number) {
  context.beginPath();
  context.roundRect(rect.left - inset, rect.top - inset, rect.width + inset * 2, rect.height + inset * 2, radius);
}

function clear(context: CanvasRenderingContext2D, rect: DOMRect, radius: number, spread: number) {
  context.save();
  context.globalCompositeOperation = "destination-out";
  shape(context, rect, radius + spread, spread);
  context.fill();
  context.restore();
}

function alphaOf(color: string): number {
  if (!color || color === "transparent" || color === "none") return 0;
  const inner = /\(([^)]*)\)/.exec(color)?.[1];
  if (!inner) return 1;
  const [, alpha] = inner.split("/");
  if (alpha !== undefined) return parseFloat(alpha) * (alpha.includes("%") ? 0.01 : 1);
  const commas = inner.split(",");
  return commas.length > 3 ? parseFloat(commas[3]!) : 1;
}

/** Commas that separate a list, not those inside a colour's brackets. */
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "(") depth += 1;
    else if (list[i] === ")") depth -= 1;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** A ring drawn as a box shadow with only a spread, as Tailwind's ring utilities draw one; 0 for none. */
function ringOf(shadow: string): number {
  if (!shadow || shadow === "none") return 0;
  let widest = 0;
  for (const one of splitTop(shadow)) {
    if (one.includes("inset")) continue;
    const color = /(rgba?|oklch|oklab|color|lab|lch|hsla?)\([^)]*\)|#[0-9a-f]+/i.exec(one)?.[0] ?? "";
    const lengths = one.replace(color, "").trim().split(/\s+/).map(parseFloat);
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    if (x === 0 && y === 0 && blur === 0 && spread > 0 && alphaOf(color) > 0) widest = Math.max(widest, spread);
  }
  return widest;
}

/** A computed `linear-gradient(…)` as the canvas's own, for the primary bot's gold coin. */
function gradientOf(context: CanvasRenderingContext2D, image: string, rect: DOMRect): CanvasGradient | null {
  const inner = /^linear-gradient\((.*)\)$/.exec(image.trim())?.[1];
  if (!inner) return null;
  const parts = splitTop(inner);
  let angle = 180;
  if (/deg$/.test(parts[0] ?? "")) angle = parseFloat(parts.shift()!);
  const turn = (angle * Math.PI) / 180;
  const dx = Math.sin(turn);
  const dy = -Math.cos(turn);
  const half = (Math.abs(rect.width * dx) + Math.abs(rect.height * dy)) / 2;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const gradient = context.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  parts.forEach((part, i) => {
    const stop = /^(.*\S)\s+(-?[\d.]+)%$/.exec(part);
    const at = stop ? parseFloat(stop[2]!) / 100 : i / Math.max(1, parts.length - 1);
    try {
      gradient.addColorStop(Math.min(1, Math.max(0, at)), stop ? stop[1]! : part);
    } catch {
      /* a stop the canvas can't read: the rest still paint */
    }
  });
  return gradient;
}

async function drawSvg(context: CanvasRenderingContext2D, svg: SVGSVGElement, rect: DOMRect, color: string, scale: number) {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(Math.ceil(rect.width * scale)));
  copy.setAttribute("height", String(Math.ceil(rect.height * scale)));
  // Sized by its attributes alone, and currentColor as the page resolved it.
  copy.setAttribute("style", `color:${color}`);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  await image.decode().catch(() => undefined);
  if (image.naturalWidth) context.drawImage(image, rect.left, rect.top, rect.width, rect.height);
}

async function drawPicture(context: CanvasRenderingContext2D, picture: HTMLImageElement, rect: DOMRect, radius: number) {
  if (!picture.complete) await picture.decode().catch(() => undefined);
  if (!picture.naturalWidth) return;
  context.save();
  shape(context, rect, radius, 0);
  context.clip();
  context.drawImage(picture, rect.left, rect.top, rect.width, rect.height);
  context.restore();
}
