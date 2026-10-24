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

  setTheme(background: string, dark: boolean): void;
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
};

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

export type NativeShell = "desktop" | "android" | "ios";

export function mobileShell(): GondMobile | null {
  return typeof window === "undefined" ? null : (window.gondMobile ?? null);
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
