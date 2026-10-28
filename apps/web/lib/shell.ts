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
  /** What else this iPhone app draws, which an older one doesn't: "call" for a call's bar. */
  features?(): string[];
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

/** The desktop app's word that a download finished (`gond:download`); null when it can't tell. */
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
  }
}

type NativeShell = "desktop" | "android" | "ios";

export function mobileShell(): GondMobile | null {
  return typeof window === "undefined" ? null : (window.gondMobile ?? null);
}

export function pushBridge(): GondPush | null {
  const mobile = mobileShell() as (GondMobile & Partial<GondPush>) | null;
  return mobile && typeof mobile.pushState === "function" && typeof mobile.setPushDevice === "function" ? (mobile as GondMobile & GondPush) : null;
}

export function desktopShell(): GondDesktop | null {
  if (typeof window === "undefined") return null;
  const bridge = window.gondDesktop ?? null;
  return typeof bridge?.changeServer === "function" ? bridge : null;
}

export function shellBridge(): GondMobile | GondDesktop | null {
  return mobileShell() ?? desktopShell();
}

export function nativeShell(): NativeShell | null {
  const mobile = mobileShell();
  if (mobile) return mobile.platform() === "ios" ? "ios" : "android";
  if (desktopShell()) return "desktop";
  return null;
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
  const mobile = mobileShell();
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
  const mobile = mobileShell();
  if (mobile) mobile.changeServer();
  else void desktopShell()?.changeServer();
}
