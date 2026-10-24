"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { changeServer, desktopShell, useNativeShell, type DesktopUpdate, type GondDesktop } from "@/lib/shell";

const never = () => () => {};

type Updater = Required<Pick<GondDesktop, "updateState" | "checkForUpdates" | "installUpdate">>;

function updater(): Updater | null {
  const desktop = desktopShell();
  if (
    typeof desktop?.updateState !== "function" ||
    typeof desktop.checkForUpdates !== "function" ||
    typeof desktop.installUpdate !== "function"
  ) {
    return null;
  }
  return desktop as Updater;
}

function UpdateField() {
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const busy = checking || Boolean(update?.checking);

  useEffect(() => {
    const app = updater();
    if (!app) return;
    const read = () => app.updateState().then(setUpdate, () => undefined);
    void read();
    const timer = window.setInterval(read, busy ? 2_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const check = () => {
    const app = updater();
    if (!app) return;
    setChecking(true);
    app
      .checkForUpdates()
      .then(setUpdate, () => undefined)
      .finally(() => setChecking(false));
  };

  const restart = () => {
    const app = updater();
    if (!app) return;
    setRestarting(true);
    app.installUpdate().catch(() => {
      setRestarting(false);
      toast.add({ type: "error", title: "Couldn't install the update.", description: "Close Gond and open it again to finish, or try Restart to update once more." });
    });
  };

  if (!update) return null;
  let line = "Up to date";
  if (update.ready && update.available) line = `Gond ${update.available} is ready`;
  else if (update.available) line = `Gond ${update.available} is downloading…`;
  else if (update.error && !busy) line = "Couldn't check for updates";

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>Version {update.current}</FieldTitle>
        <FieldDescription aria-live="polite">{line}</FieldDescription>
      </FieldContent>
      {update.ready ? (
        <Button size="sm" onClick={restart} disabled={restarting}>
          {restarting ? "Restarting…" : "Restart to update"}
        </Button>
      ) : update.available ? null : (
        <Button variant="outline" size="sm" onClick={check} disabled={busy}>
          {busy ? "Checking…" : "Check for updates"}
        </Button>
      )}
    </Field>
  );
}

export function ServerCard() {
  const shell = useNativeShell();
  const origin = useSyncExternalStore(never, () => window.location.origin, () => "");
  if (!shell) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>This app</CardTitle>
        <CardDescription>Gond {shell === "ios" ? "for iPhone" : shell === "android" ? "for Android" : "for the desktop"} is connected to {origin}.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={changeServer}>
            Change server
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-[13.5px] text-muted-foreground">
        <p>Changing the server takes you back to Connect; your sign-in here stays until you sign out.</p>
        {shell === "desktop" ? <UpdateField /> : null}
      </CardContent>
    </Card>
  );
}
