"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { deviceId, tagSubscription } from "@/lib/push";

const HEARTBEAT_MS = 20_000;
const USE_THROTTLE_MS = 15_000;

/**
 * Tells the API which conversation this window shows and whether the person is using it, so a
 * notice skips what they are reading and goes only to the device they used last.
 */
export function ViewingReport() {
  const pathname = usePathname();
  useEffect(() => {
    if (!tagged) {
      tagged = true;
      void tagSubscription();
    }
  }, []);
  useEffect(() => {
    const client = windowId();
    const device = deviceId();
    const threadId = /^\/app\/t\/([^/]+)/.exec(pathname)?.[1] ?? null;
    const send = (shown: string | null, active: boolean) =>
      void fetch("/api/push/viewing", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client, threadId: shown, timezone: browserTimezone(), device, active }) }).catch(() => undefined);
    let last: string | null | undefined;
    let usedAt = 0;
    // Only the person's own doing (opening, focusing, touching, typing) marks the device active;
    // the heartbeat keeps "viewing" alive but never claims activity, or an idle focused desktop
    // window would win the notices back from the phone in their hand.
    const report = ({ force = false, leaving = false, used = false } = {}) => {
      const shown = !leaving && document.visibilityState === "visible" && document.hasFocus() ? threadId : null;
      const active = used && !leaving && document.visibilityState === "visible";
      if (!force && !active && shown === last) return;
      last = shown;
      if (active) usedAt = Date.now();
      send(shown, active);
    };
    const onChange = () => report({ used: document.visibilityState === "visible" && document.hasFocus() });
    const onLeave = () => report({ leaving: true });
    const onUse = () => {
      if (Date.now() - usedAt > USE_THROTTLE_MS) report({ used: true });
    };
    report({ force: true, used: document.visibilityState === "visible" && document.hasFocus() });
    const heartbeat = window.setInterval(() => {
      if (last) report({ force: true });
    }, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("pointerdown", onUse, { passive: true });
    window.addEventListener("keydown", onUse);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("pointerdown", onUse);
      window.removeEventListener("keydown", onUse);
    };
  }, [pathname]);
  return null;
}

let id: string | null = null;
let tagged = false;

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
