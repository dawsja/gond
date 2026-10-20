"use client";

import { BellOff, BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, pushPermission, pushSupported } from "@/lib/push";
import { shellBridge, useNativeShell } from "@/lib/shell";

type State = "checking" | "unsupported" | "off" | "on" | "blocked";

const NOTIFICATIONS_EVENTS = ["gond:notifications", "kru:notifications"];

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
        return setState(permission === "granted" ? "on" : permission === "denied" ? "blocked" : "off");
      }
      if (!pushSupported()) return setState("unsupported");
      if (pushPermission() === "denied") return setState("blocked");
      setState((await currentSubscription()) ? "on" : "off");
    };
    void Promise.resolve().then(read);
    const onChange = () => void read();
    for (const event of NOTIFICATIONS_EVENTS) window.addEventListener(event, onChange);
    return () => {
      for (const event of NOTIFICATIONS_EVENTS) window.removeEventListener(event, onChange);
    };
  }, []);

  async function turnOn() {
    const bridge = shellBridge();
    if (bridge) return void (typeof bridge.requestNotifications === "function" && (await bridge.requestNotifications()));
    setBusy(true);
    try {
      await enablePush();
      setState("on");
      toast.add({ type: "success", title: "Notifications are on for this browser." });
    } catch (failure) {
      if (pushPermission() === "denied") setState("blocked");
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not turn notifications on." });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    const bridge = shellBridge();
    if (bridge) return void (typeof bridge.requestNotifications === "function" && (await bridge.requestNotifications()));
    setBusy(true);
    try {
      await disablePush();
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const { sent } = await post<{ sent: number }>("/api/push/test");
      if (sent) toast.add({ type: "info", title: sent === 1 ? "Sent to one browser." : `Sent to ${sent} browsers.` });
      else if (shell) toast.add({ type: "info", title: "Test sent." });
      else toast.add({ type: "info", title: "No device is subscribed yet." });
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not send the test." });
    } finally {
      setBusy(false);
    }
  }

  const where = shell === "android" ? "this phone" : shell === "desktop" ? "this computer" : "this browser";
  const how = shell === "android" ? "The phone's notifications" : shell === "desktop" ? "The desktop's notifications" : "Web Push";
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
              ? shell === "android"
                ? "This phone shows them."
                : shell === "desktop"
                  ? "This computer shows them."
                  : "This browser is subscribed."
              : state === "off"
                ? `Not on for ${where} yet.`
                : state === "blocked"
                  ? shell === "android"
                    ? "Notifications are off for Gond in the phone's settings. Turn on opens them."
                    : shell === "desktop"
                      ? "Notifications are off for Gond in the computer's settings. Allow them there, then try again."
                      : "The browser blocks notifications for this site. Allow them in its site settings, then try again."
                  : state === "unsupported"
                    ? shell
                      ? "This version of the app can't show notifications. Update it."
                      : "Push needs a secure address (https, or localhost) and a browser that supports it."
                    : ""}
          </span>
        </div>
        {state === "on" ? (
          <div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void sendTest()}>
              Send a test notification
            </Button>
          </div>
        ) : null}
        {state === "unsupported" && !shell ? (
          <Alert>
            <AlertTitle>Not available on this address</AlertTitle>
            <AlertDescription>Open Gond over https (a reverse proxy with TLS, see the README) or on localhost to use push notifications.</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
