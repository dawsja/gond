"use client";

import { BellOff, BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { failed } from "@/components/failed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { currentSubscription, disablePush, enablePush, pushPermission, pushSupported, setShellNotificationsOff, shellNotificationsOff } from "@/lib/push";
import { isPhoneShell, shellBridge, useNativeShell } from "@/lib/shell";

type State = "checking" | "unsupported" | "off" | "on" | "blocked";

const NOTIFICATIONS_EVENT = "gond:notifications";

export function NotificationsCard() {
  const shell = useNativeShell();
  const [state, setState] = useState<State>("checking");
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
    return () => {
      window.removeEventListener(NOTIFICATIONS_EVENT, onChange);
    };
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
      toast.add({ type: "success", title: "Notifications are on for this browser." });
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
    } catch (failure) {
      failed("Couldn't turn notifications off.")(failure);
    } finally {
      setBusy(false);
    }
  }

  const where = isPhoneShell(shell) ? "this phone" : shell === "desktop" ? "this computer" : "this browser";
  const how = isPhoneShell(shell) ? "The phone's notifications" : shell === "desktop" ? "The desktop's notifications" : "Browser notifications";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          {how}, when a bot finishes or needs you. Each bot has its own switch in its profile.
        </CardDescription>
        <CardAction>
          {state === "on" ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void turnOff()}>
              {busy ? <Spinner data-icon="inline-start" /> : <BellOff data-icon="inline-start" aria-hidden="true" />}
              Turn off
            </Button>
          ) : (
            <Button size="sm" disabled={busy || state === "unsupported" || (state === "blocked" && !shell) || state === "checking"} onClick={() => void turnOn()}>
              {busy ? <Spinner data-icon="inline-start" /> : <BellRing data-icon="inline-start" aria-hidden="true" />}
              Turn on
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Badge variant={state === "on" ? "default" : "outline"}>{state === "checking" ? "Checking…" : state === "on" ? "On" : state === "off" ? "Off" : state === "blocked" ? "Blocked" : "Unavailable"}</Badge>
          <span className="text-[13.5px] text-muted-foreground">
            {state === "on"
              ? isPhoneShell(shell)
                ? "This phone shows them."
                : shell === "desktop"
                  ? "This computer shows them."
                  : "This browser is subscribed."
              : state === "off"
                ? `Off for ${where}.`
                : state === "blocked"
                  ? isPhoneShell(shell)
                    ? "Notifications are off for Gond in the phone's settings. Turn on opens them."
                    : shell === "desktop"
                      ? "Notifications are off for Gond in the computer's settings. Allow them there, then try again."
                      : "The browser blocks notifications for this site. Allow them in its site settings, then try again."
                  : state === "unsupported"
                    ? shell
                      ? "This version of the app can't show notifications. Update it."
                      : "This browser can't show notifications from this address."
                    : ""}
          </span>
        </div>
        {state === "unsupported" && !shell ? (
          <Alert>
            <AlertTitle>Not available on this address</AlertTitle>
            <AlertDescription>Notifications need Gond on a secure address (one starting with https). Ask whoever runs this Gond, or use the Gond app.</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
