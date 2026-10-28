"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const HEARTBEAT_MS = 20_000;

/** Tells the API which conversation this window shows, so a notice skips what the person is reading. */
export function ViewingReport() {
  const pathname = usePathname();
  useEffect(() => {
    const client = windowId();
    const threadId = /^\/app\/t\/([^/]+)/.exec(pathname)?.[1] ?? null;
    const send = (shown: string | null) =>
      void fetch("/api/push/viewing", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client, threadId: shown, timezone: browserTimezone() }) }).catch(() => undefined);
    let last: string | null | undefined;
    // The Android app says when it goes to the background, which its WebView doesn't show the page.
    let hidden = false;
    const report = ({ force = false, leaving = false } = {}) => {
      const shown = !leaving && !hidden && document.visibilityState === "visible" && document.hasFocus() ? threadId : null;
      if (!force && shown === last) return;
      last = shown;
      send(shown);
    };
    const onChange = () => report();
    const onLeave = () => report({ leaving: true });
    const onAppHidden = () => {
      hidden = true;
      report();
    };
    const onAppShown = () => {
      hidden = false;
      report();
    };
    report({ force: true });
    const heartbeat = window.setInterval(() => {
      if (last) report({ force: true });
    }, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("gond:app-hidden", onAppHidden);
    window.addEventListener("gond:app-shown", onAppShown);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("gond:app-hidden", onAppHidden);
      window.removeEventListener("gond:app-shown", onAppShown);
    };
  }, [pathname]);
  return null;
}

let id: string | null = null;

function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function windowId() {
  id ??= crypto.randomUUID();
  return id;
}
