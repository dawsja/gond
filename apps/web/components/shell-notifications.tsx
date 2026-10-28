"use client";

import { useEffect } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { noticeWanted } from "@gond/shared";
import { NOTIFICATIONS_EVENT } from "@/hooks/use-device-notices";
import { phonePushOn, shellNotices, shellNotificationsOff, syncPhonePush } from "@/lib/push";
import { shellBridge } from "@/lib/shell";

/**
 * Notices in the apps. The Android app gets them as push once it's signed up (`syncPhonePush`, as it
 * opens and whenever its token or notifications change); until then, and in the other apps, the
 * page asks the app to show each one while it runs.
 */
export function ShellNotifications() {
  useEffect(() => {
    const sync = () => void syncPhonePush().catch(() => undefined);
    sync();
    window.addEventListener("gond:push", sync);
    window.addEventListener(NOTIFICATIONS_EVENT, sync);
    return () => {
      window.removeEventListener("gond:push", sync);
      window.removeEventListener(NOTIFICATIONS_EVENT, sync);
    };
  }, []);

  useLiveEvents((event) => {
    if (event.topic !== "notify") return;
    const shell = shellBridge();
    if (!shell || typeof shell.notify !== "function" || shellNotificationsOff() || phonePushOn() || !noticeWanted(shellNotices(), event.botId)) return;
    const target = new URL(event.url, window.location.origin);
    const inFront = document.visibilityState === "visible" && window.location.pathname === target.pathname;
    if (inFront) return;
    void shell.notify(event.title, event.body, target.pathname + target.search, event.tag);
  });
  return null;
}
