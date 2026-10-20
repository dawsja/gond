"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { pushPermission } from "@/lib/push";
import { shellBridge } from "@/lib/shell";

const HEARTBEAT_MS = 20_000;

export function ViewingReport() {
  const pathname = usePathname();
  useEffect(() => {
    const client = windowId();
    const send = (threadId: string | null) =>

      void fetch("/api/push/viewing", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client, threadId, timezone: browserTimezone() }) }).catch(() => undefined);
    if (shellBridge() || pushPermission() !== "granted") {
      if (!zoneSent) {
        zoneSent = true;
        send(null);
      }
      return;
    }
    const threadId = /^\/app\/t\/([^/]+)/.exec(pathname)?.[1] ?? null;
    let last: string | null = null;
    const report = (force = false, leaving = false) => {
      const shown = threadId && !leaving && document.visibilityState === "visible" && document.hasFocus() ? threadId : null;
      if (!force && shown === last) return;
      last = shown;
      zoneSent = true;
      send(shown);
    };
    const onChange = () => report();
    const onLeave = () => report(false, true);
    report(true);
    const heartbeat = window.setInterval(() => {
      if (last) report(true);
    }, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [pathname]);
  return null;
}

let id: string | null = null;
let zoneSent = false;

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
