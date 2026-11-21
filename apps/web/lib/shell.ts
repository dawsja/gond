"use client";

import { useSyncExternalStore } from "react";

export type GondMobile = {
  platform(): string;
  version(): string;

  changeServer(): void;

  notify(title: string, body: string, url: string, tag: string): void;

  notificationsState(): "granted" | "denied" | "prompt";

  requestNotifications(): void;
  openExternal(url: string): void;

  signIn?(next: string): void;

  /** `system` only on the iPhone, whose app would otherwise pin the page's scheme. */
  setTheme(background: string, dark: boolean, system?: boolean): void;

  /** The iPhone app's own pieces in Liquid Glass (`lib/native-ui.ts`): a confirm, a message's menu, the pictures. */
  present?(kind: string, request: string): void;
  /** A conversation's header and composer, drawn by the iPhone app from this state; null takes them away. */
  chrome?(state: string): void;
  /** What else this iPhone app draws, which an older one doesn't: "call" for a call's bar, "scale" for its chrome at the page's size. */
  features?(): string[];

  /** How much bigger the page's design is drawn on this phone (`SIZE_SCRIPT`), so the iPhone app draws its chrome to match. */
  setScale?(scale: number): void;
};

/**
 * A phone app's push (`Push.kt`, `Push.swift`): its Firebase token and the device id this Gond gave
 * it. Kept off GondMobile, which every app must offer whole; an older app without it shows notices
 * only while it runs.
 */
export type GondPush = {
  /** `{ token, device }` as JSON, each null until there is one. */
  pushState(): string;
  /** The server's answer to signing up (`{ id, seal, answer }`), or null to sign the phone out. */
  setPushDevice(json: string | null): void;
};

/**
 * The Android app's word that a call is on (`CallService.kt`), so it keeps going with the app in the
 * background and shows a notice saying so. Kept off GondMobile: the iPhone keeps a call through its
 * audio background mode and needs nothing.
 */
export type GondCall = {
  /** The bot's name and when the call started; an empty name ends it. */
  setCall(bot: string, startedAt: string): void;
};

export type GondDesktop = {
  platform?: () => Promise<string>;
  version?: () => Promise<string>;
  changeServer: () => Promise<void>;

  signIn?: (next: string) => Promise<void>;

  notify?: (title: string, body: string, url: string, tag: string) => Promise<void>;

  notificationsState?: () => Promise<"granted" | "denied" | "prompt">;

  requestNotifications?: () => Promise<"granted" | "denied" | "prompt">;
  openExternal?: (url: string) => Promise<void>;

  setTheme?: (background: string, dark: boolean, system?: boolean) => Promise<void>;

  updateState?: () => Promise<DesktopUpdate>;
  checkForUpdates?: () => Promise<DesktopUpdate>;
  installUpdate?: () => Promise<void>;
  /** Shows a finished download in its folder, by the id its `gond:download` event carried. */
  showDownload?: (id: number) => Promise<void>;
};

/**
 * The Mac app (`apps/mac`): one way and synchronous like the iPhone's bridge, what the page reads back
 * written into the script and kept current with events. It is a computer, never a phone: no push
 * through the relay, and its sidebar, toolbar and composer are its own (`lib/native-ui.ts`).
 */
export type GondMac = {
  platform(): "macos";
  version(): string;
  /** "call" (the composer draws a call), "scale" (chrome at the page's size), "sidebar" (draws the sidebar). */
  features(): string[];
  changeServer(): void;
  signIn(next: string): void;
  notify(title: string, body: string, url: string, tag: string): void;
  notificationsState(): "granted" | "denied" | "prompt";
  requestNotifications(): void;
  openExternal(url: string): void;
  setTheme(background: string, dark: boolean, system: boolean): void;
  setScale(scale: number): void;
  present(kind: string, request: string): void;
  chrome(state: string): void;
  sidebar(state: string): void;
  showDownload(id: number): void;
};

/** The desktop and Mac apps' word that a download finished (`gond:download`); null when it can't tell. */
export type DesktopDownload = { ok: boolean; id: number | null; name: string | null; folder: string | null };

export type DesktopUpdate = {
  current: string;
  available: string | null;
  ready: boolean;
  checking: boolean;
  error: string | null;
};

declare global {
  interface Window {
    gondDesktop?: GondDesktop;

    gondMobile?: GondMobile;

    gondMac?: GondMac;
  }
}

type NativeShell = "desktop" | "android" | "ios" | "mac";

export function mobileShell(): GondMobile | null {
  return typeof window === "undefined" ? null : (window.gondMobile ?? null);
}

export function pushBridge(): GondPush | null {
  const mobile = mobileShell() as (GondMobile & Partial<GondPush>) | null;
  return mobile && typeof mobile.pushState === "function" && typeof mobile.setPushDevice === "function" ? (mobile as GondMobile & GondPush) : null;
}

export function callBridge(): GondCall | null {
  const mobile = mobileShell() as (GondMobile & Partial<GondCall>) | null;
  return mobile && typeof mobile.setCall === "function" ? (mobile as GondMobile & GondCall) : null;
}

export function desktopShell(): GondDesktop | null {
  if (typeof window === "undefined") return null;
  const bridge = window.gondDesktop ?? null;
  return typeof bridge?.changeServer === "function" ? bridge : null;
}

export function macShell(): GondMac | null {
  if (typeof window === "undefined") return null;
  const bridge = window.gondMac ?? null;
  return typeof bridge?.changeServer === "function" ? bridge : null;
}

export function shellBridge(): GondMobile | GondMac | GondDesktop | null {
  return mobileShell() ?? macShell() ?? desktopShell();
}

export function nativeShell(): NativeShell | null {
  const mobile = mobileShell();
  if (mobile) return mobile.platform() === "ios" ? "ios" : "android";
  if (macShell()) return "mac";
  if (desktopShell()) return "desktop";
  return null;
}

/**
 * The phone and Mac apps: a web view that loads a sign-in the page starts itself and catches every
 * window the page opens, so the page never opens a blank tab first to get past a pop-up blocker.
 */
export function isWebViewShell(): boolean {
  return mobileShell() !== null || macShell() !== null;
}

/** Shows a finished download in its folder, by the id its `gond:download` event carried; null when the app can't. */
export function downloadRevealer(): ((id: number) => Promise<void>) | null {
  const mac = macShell();
  if (typeof mac?.showDownload === "function") return async (id) => mac.showDownload(id);
  const show = desktopShell()?.showDownload;
  return typeof show === "function" ? show : null;
}

/** The Android and iPhone apps: a phone, whatever the window's width. */
export function isPhoneShell(shell: NativeShell | null): shell is "android" | "ios" {
  return shell === "android" || shell === "ios";
}

const never = () => () => {};

export function useNativeShell(): NativeShell | null {
  return useSyncExternalStore(never, nativeShell, () => null);
}

export function shellSignIn(next: string): boolean {
  const mobile = mobileShell() ?? macShell();
  if (mobile?.signIn) {
    mobile.signIn(next);
    return true;
  }
  const desktop = desktopShell();
  if (desktop?.signIn) {
    void desktop.signIn(next);
    return true;
  }
  return false;
}

export function changeServer() {
  const app = mobileShell() ?? macShell();
  if (app) app.changeServer();
  else void desktopShell()?.changeServer();
}
