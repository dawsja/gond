"use client";

import type { ServerUpdate, ServerUpdatePhase } from "@gond/shared";
import { Check, Download, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "@/components/store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api, post } from "@/lib/api";
import { cn } from "@/lib/utils";

const never = () => () => {};

const STEPS: { label: string; phases: ServerUpdatePhase[] }[] = [
  { label: "Downloading the new version", phases: ["pulling"] },
  { label: "Updating the computer", phases: ["computer"] },
  { label: "Restarting the server", phases: ["web", "server"] },
  { label: "Reloading this page", phases: [] },
];

const working = (phase: ServerUpdatePhase | undefined) => phase === "pulling" || phase === "computer" || phase === "web" || phase === "server";

function Step({ state, children }: { state: "done" | "now" | "next"; children: string }) {
  return (
    <li className={cn("flex items-center gap-2.5 text-[13.5px]", state === "next" && "text-muted-foreground")}>
      <span className={cn("grid size-6 shrink-0 place-items-center rounded-full", state === "done" ? "bg-tone-ok-wash text-tone-ok" : "border border-primary-edge")}>
        {state === "done" ? <Check className="size-3.5" aria-hidden="true" /> : state === "now" ? <Spinner className="size-3.5" /> : null}
      </span>
      {children}
    </li>
  );
}

function Steps({ phase }: { phase: ServerUpdatePhase }) {
  const at = STEPS.findIndex((step) => step.phases.includes(phase));
  return (
    <ol className="flex flex-col gap-2.5" aria-live="polite">
      {STEPS.map((step, i) => (
        <Step key={step.label} state={i < at ? "done" : i === at ? "now" : "next"}>
          {step.label}
        </Step>
      ))}
    </ol>
  );
}

/** Settings → About: the server's version, and for the admin, a newer Gond with what's new and one button to update to it. */
export function ServerUpdateCard() {
  const { admin } = useStore();
  const host = useSyncExternalStore(never, () => window.location.host, () => "");
  const [update, setUpdate] = useState<ServerUpdate | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (check = false) => {
      if (!admin) {
        const data = await api<{ version: string }>("/api/version").catch(() => null);
        if (data) setVersion(data.version);
        return;
      }
      const data = await api<{ update: ServerUpdate }>(`/api/server/update${check ? "?check=1" : ""}`).catch(() => null);
      if (data) setUpdate(data.update);
    },
    [admin],
  );

  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  // While it runs the server goes away and comes back; the page reloads itself then (VersionWatch).
  const phase = update?.phase;
  useEffect(() => {
    if (!working(phase)) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [phase, load]);

  const check = async () => {
    setChecking(true);
    await load(true);
    setChecking(false);
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const data = await post<{ update: ServerUpdate }>("/api/server/update");
      setUpdate(data.update);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't start the update.");
    } finally {
      setStarting(false);
    }
  };

  const current = update?.current ?? version;
  const named = (v: string | null | undefined) => (v && v !== "dev" ? `Version ${v}` : "Built from source");

  if (update && working(update.phase)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Updating to {update.latest}</CardTitle>
          <CardDescription>Your bots wait until it&apos;s back. This page reloads by itself.</CardDescription>
        </CardHeader>
        <CardContent>
          <Steps phase={update.phase} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your server</CardTitle>
        <CardDescription>{[host, named(current)].filter(Boolean).join(" · ")}</CardDescription>
      </CardHeader>
      {admin && update ? (
        <CardContent className="flex flex-col gap-3">
          {update.phase === "failed" || error ? (
            <Alert variant="destructive">
              <AlertTitle>The update didn&apos;t finish</AlertTitle>
              <AlertDescription>{error ?? update.error}</AlertDescription>
            </Alert>
          ) : null}
          {update.available ? (
            <>
              <div className="flex flex-col gap-2 rounded-2xl border border-tint-edge bg-tint-wash p-3">
                <span className="text-[14px] font-semibold">Gond {update.latest} is out</span>
                {update.notes.length ? (
                  <ul className="flex flex-col gap-1.5 text-[13px] leading-5">
                    {update.notes.map((line) => (
                      <li key={line} className="flex gap-2">
                        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-tint-ink" aria-hidden="true" />
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {update.blocked ? (
                <p className="text-[12.5px] leading-4 text-muted-foreground">{update.blocked}</p>
              ) : (
                <>
                  <Button size="lg" variant="tint" className="w-full" disabled={starting} onClick={() => void start()}>
                    {starting ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" aria-hidden="true" />}
                    Update Gond
                  </Button>
                  <p className="text-[12px] leading-4 text-muted-foreground">Takes a few minutes. Anything a bot is doing stops; ask again once it&apos;s back. Every open page and app moves to the new version by itself.</p>
                </>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3">
              <span className="flex-1 text-[13.5px] text-muted-foreground">{update.latest ? "You're on the newest version." : "Couldn't reach GitHub to check for a newer version."}</span>
              <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
                {checking ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" aria-hidden="true" />}
                Check now
              </Button>
            </div>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
