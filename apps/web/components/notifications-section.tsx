"use client";

import { Globe, Monitor, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { failed } from "@/components/failed";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { NOTIFICATIONS_EVENT, useDeviceNotices } from "@/hooks/use-device-notices";
import { currentSubscription, disablePush, enablePush, pushPermission, pushSupported, setShellNotificationsOff, shellNotificationsOff } from "@/lib/push";
import { isPhoneShell, shellBridge, useNativeShell } from "@/lib/shell";

/** Settings → Notifications: this browser or app, and the notices it gets. */
export function NotificationsSection() {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Where notices go</CardTitle>
          <CardDescription>Every browser and app you turn on here gets the notices when a bot finishes or needs you, except about the conversation you have open. The bells in each bot&apos;s profile turn its notices off everywhere or only on one device.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y">
            <DeviceRow />
          </ul>
        </CardContent>
      </Card>

      <DeviceNoticesCard />
    </>
  );
}

type DeviceState = "checking" | "unsupported" | "off" | "on" | "blocked";

/** This browser or app: on or off for it alone, since the system's permission is per device. */
function DeviceRow() {
  const shell = useNativeShell();
  const [state, setState] = useState<DeviceState>("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = async () => {
      const bridge = shellBridge();
      if (bridge) {
        if (typeof bridge.notificationsState !== "function") return setState("unsupported");
        const permission = await bridge.notificationsState();
        return setState(permission === "granted" ? (shellNotificationsOff() ? "off" : "on") : permission === "denied" ? "blocked" : "off");
      }
      if (!pushSupported()) return setState("unsupported");
      if (pushPermission() === "denied") return setState("blocked");
      setState((await currentSubscription()) ? "on" : "off");
    };
    void Promise.resolve().then(read);
    const onChange = () => void read();
    window.addEventListener(NOTIFICATIONS_EVENT, onChange);
    return () => window.removeEventListener(NOTIFICATIONS_EVENT, onChange);
  }, []);

  async function turnOn() {
    const bridge = shellBridge();
    if (bridge) {
      setShellNotificationsOff(false);
      const granted = typeof bridge.notificationsState === "function" && (await bridge.notificationsState()) === "granted";
      if (!granted && typeof bridge.requestNotifications === "function") await bridge.requestNotifications();
      return void window.dispatchEvent(new Event(NOTIFICATIONS_EVENT));
    }
    setBusy(true);
    try {
      await enablePush();
      setState("on");
      window.dispatchEvent(new Event(NOTIFICATIONS_EVENT));
    } catch (failure) {
      if (pushPermission() === "denied") setState("blocked");
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't turn notifications on." });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    const bridge = shellBridge();
    if (bridge) {
      setShellNotificationsOff(true);
      return void window.dispatchEvent(new Event(NOTIFICATIONS_EVENT));
    }
    setBusy(true);
    try {
      await disablePush();
      setState("off");
      window.dispatchEvent(new Event(NOTIFICATIONS_EVENT));
    } catch (failure) {
      failed("Couldn't turn notifications off.")(failure);
    } finally {
      setBusy(false);
    }
  }

  const phone = isPhoneShell(shell);
  const name = phone ? "This phone" : shell === "desktop" ? "This computer" : "This browser";
  const Icon = phone ? Smartphone : shell === "desktop" ? Monitor : Globe;
  const detail =
    state === "checking"
      ? "Checking…"
      : state === "on"
        ? phone
          ? "On, while the Gond app is open or just put away."
          : shell === "desktop"
            ? "On, while the Gond app is running."
            : "On for this browser."
        : state === "off"
          ? "Off here."
          : state === "blocked"
            ? phone
              ? "Notifications are off for Gond in the phone's settings. Turning this on opens them."
              : shell
                ? "Notifications are off for Gond in the computer's settings. Allow them there, then try again."
                : "The browser blocks notifications for this site. Allow them in its site settings, then try again."
            : shell
              ? "This version of the app can't show notifications. Update it."
              : "This browser can't get notifications from this address: it needs https.";
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-medium">{name}</p>
        <p className="text-[13px] text-muted-foreground">{detail}</p>
      </div>
      {busy ? <Spinner /> : null}
      <Switch
        size="sm"
        checked={state === "on"}
        disabled={busy || state === "checking" || state === "unsupported" || (state === "blocked" && !phone)}
        onCheckedChange={(on) => void (on ? turnOn() : turnOff())}
        aria-label={`Notifications for ${name.toLowerCase()}`}
      />
    </li>
  );
}

/** What else this browser or app hears about, once notifications are on here; each bot's are in its own profile. */
function DeviceNoticesCard() {
  const { notices, setNotices, save, here } = useDeviceNotices();
  if (!notices) return null;

  function change(other: boolean) {
    if (!notices) return;
    const before = notices;
    setNotices({ ...notices, other });
    save({ ...notices, other }).catch((failure: unknown) => {
      setNotices(before);
      failed(`Couldn't change other notices on ${here}.`)(failure);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>On {here}</CardTitle>
        <CardDescription>To quiet a bot here, tap the bell in its profile.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-medium">Other notices</p>
            <p className="text-[13px] text-muted-foreground">Exports, people in spaces</p>
          </div>
          <Switch size="sm" checked={notices.other} onCheckedChange={change} aria-label={`Other notices on ${here}`} />
        </div>
      </CardContent>
    </Card>
  );
}
