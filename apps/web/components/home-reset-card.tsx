"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Confirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";

const KEPT = ["What every bot remembers, and the team's memory", "Your bots, their instructions and your conversations", "Your Claude Code sign-in", "Websites you and your bots are signed in to"];
const GONE = ["Everything installed: apps, packages, tools and caches", "Settings and changes to the desktop", "Files your bots made, and your own files"];

export function HomeResetCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      await post("/api/box/home/reset");
      toast.add({ type: "success", title: "Your computer is fresh.", description: "Your bots pick up where they left off." });
      setConfirming(false);
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't start your computer fresh." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start fresh</CardTitle>
        <CardDescription>Put your computer back the way it was built, when it&apos;s cluttered or something your bots installed is in the way. Only yours changes; nobody else&apos;s.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 wide:grid-cols-2">
        <section>
          <h3 className="text-sm font-medium">Kept</h3>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {KEPT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="text-sm font-medium">Removed</h3>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {GONE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </CardContent>
      <CardFooter>
        <Button variant="destructive" onClick={() => setConfirming(true)}>
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
          Start my computer fresh
        </Button>
      </CardFooter>

      <Confirm
        open={confirming}
        onOpenChange={(open) => !busy && setConfirming(open)}
        title="Start your computer fresh?"
        description="Your bots stop what they're doing, and everything installed and every file on your computer goes. Their memories and your sign-ins stay. This can't be undone."
        action="Start fresh"
        cancel="Not now"
        onConfirm={reset}
      />
    </Card>
  );
}
