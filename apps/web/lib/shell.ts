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
  menuBar?: () => Promise<boolean>;
  setMenuBar?: (shown: boolean) => Promise<void>;

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

    kruDesktop?: GondDesktop;

    gondMobile?: GondMobile;

    kruMobile?: GondMobile;
  }
}

export type NativeShell = "desktop" | "android";

export function mobileShell(): GondMobile | null {
  return typeof window === "undefined" ? null : (window.gondMobile ?? window.kruMobile ?? null);
}

export function desktopShell(): GondDesktop | null {
  if (typeof window === "undefined") return null;
  const bridge = window.gondDesktop ?? window.kruDesktop ?? null;
  return typeof bridge?.changeServer === "function" ? bridge : null;
}

export function shellBridge(): GondMobile | GondDesktop | null {
  return mobileShell() ?? desktopShell();
}

export function nativeShell(): NativeShell | null {
  if (mobileShell()) return "android";
  if (desktopShell()) return "desktop";
  return null;
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
