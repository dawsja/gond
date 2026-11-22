"use client";

import type { DeviceNotices } from "@gond/shared";
import { useCallback, useEffect, useState } from "react";
import { deviceNotices, pushSupported, saveDeviceNotices, shellNotificationsOff } from "@/lib/push";
import { isPhoneShell, shellBridge, useNativeShell } from "@/lib/shell";

/** Fired when notifications are turned on or off here, so everything showing what this device hears reads it again. */
export const NOTIFICATIONS_EVENT = "gond:notifications";

export function useDeviceNotices() {
  const shell = useNativeShell();
  const [notices, setNotices] = useState<DeviceNotices | null>(null);

  useEffect(() => {
    const read = async () => {
      const bridge = shellBridge();
      if (bridge) {
        const granted = typeof bridge.notificationsState === "function" && (await bridge.notificationsState()) === "granted";
        return setNotices(granted && !shellNotificationsOff() ? await deviceNotices(true) : null);
      }
      if (!pushSupported()) return setNotices(null);
      setNotices(await deviceNotices(false).catch(() => null));
    };
    void Promise.resolve().then(read);
    const onChange = () => void read();
    window.addEventListener(NOTIFICATIONS_EVENT, onChange);
    return () => window.removeEventListener(NOTIFICATIONS_EVENT, onChange);
  }, []);

  const save = useCallback(async (next: DeviceNotices) => {
    await saveDeviceNotices(Boolean(shellBridge()), next);
    setNotices(next);
  }, []);

  const here = isPhoneShell(shell) ? "this phone" : shell === "mac" ? "this Mac" : shell === "desktop" ? "this computer" : "this browser";
  return { notices, setNotices, save, here };
}
