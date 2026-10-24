"use client";

import { useLiveEvents } from "@/components/hq/live-events";
import { shellNotificationsOff } from "@/lib/push";
import { shellBridge } from "@/lib/shell";

export function ShellNotifications() {
  useLiveEvents((event) => {
    if (event.topic !== "notify") return;
    const shell = shellBridge();
    if (!shell || typeof shell.notify !== "function" || shellNotificationsOff()) return;
    const target = new URL(event.url, window.location.origin);
    const inFront = document.visibilityState === "visible" && window.location.pathname === target.pathname;
    if (inFront) return;
    void shell.notify(event.title, event.body, target.pathname + target.search, event.tag);
  });
  return null;
}
