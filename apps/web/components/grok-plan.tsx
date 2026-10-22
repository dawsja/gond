"use client";

import type { AiSettings } from "@gond/shared";
import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { PlanSignedIn } from "@/components/plan-engine";
import { ProviderCheck, useProviders } from "@/components/providers-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, post } from "@/lib/api";
import { mobileShell } from "@/lib/shell";
import { cn } from "@/lib/utils";

type GrokSignIn = { state: "waiting" | "done" | "failed"; url: string | null; code: string | null; expiresAt: number; error: string | null };

const POLL_MS = 3000;

/** xAI's mark, ink in both themes. */
export function GrokLogo({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={cn("shrink-0", className)}>
      <path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z" />
    </svg>
  );
}

export function GrokPlanLine() {
  return (
    <span className="flex items-center gap-1.5 font-medium text-foreground">
      <GrokLogo size={14} />
      Using Grok plan
    </span>
  );
}

/** "Sign in with Grok": a code to approve on xAI's page, watched here until it is. */
export function SignInWithGrok({ onDone }: { onDone: () => void }) {
  const [signIn, setSignIn] = useState<GrokSignIn | null>(null);
  const [starting, setStarting] = useState(false);
  const waiting = signIn?.state === "waiting";
  const finished = useEffectEvent(() => {
    toast.add({ type: "success", title: "Signed in with Grok." });
    onDone();
  });

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void api<{ signIn: GrokSignIn | null }>("/api/providers/grok/sign-in")
        .then(({ signIn: next }) => {
          setSignIn(next);
          if (next?.state === "done") finished();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  async function begin() {
    setStarting(true);
    // Opened before the request, or a browser takes the later navigation for a pop-up and blocks it.
    const tab = mobileShell() ? null : window.open("about:blank", "_blank");
    try {
      const { signIn: started } = await post<{ signIn: GrokSignIn }>("/api/providers/grok/sign-in");
      setSignIn(started);
      if (started.url) {
        if (tab) tab.location.href = started.url;
        else window.open(started.url, "_blank");
      } else tab?.close();
    } catch (failure) {
      tab?.close();
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't start the sign-in." });
    } finally {
      setStarting(false);
    }
  }

  function copyCode() {
    if (!signIn?.code) return;
    void navigator.clipboard.writeText(signIn.code).then(
      () => toast.add({ type: "success", title: "Code copied." }),
      () => undefined,
    );
  }

  return (
    <div className="flex w-full flex-col items-start gap-3">
      {waiting ? null : (
        <Button size="lg" disabled={starting} onClick={() => void begin()}>
          {starting ? <Spinner data-icon="inline-start" /> : <GrokLogo size={18} />}
          Sign in with Grok
        </Button>
      )}
      {signIn?.state === "failed" ? (
        <Alert>
          <AlertTitle>The sign-in didn&apos;t finish</AlertTitle>
          <AlertDescription>{signIn.error ?? "Start again."}</AlertDescription>
        </Alert>
      ) : null}
      {waiting ? (
        <div className="flex w-full flex-col gap-3 rounded-xl border p-4">
          <span className="text-[13px] text-muted-foreground">On Grok&apos;s page, check it shows this code, then approve.</span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg border bg-muted px-3 py-1.5 font-mono text-[20px] font-semibold tracking-[0.15em]">{signIn.code}</span>
            <Button variant="ghost" size="icon" aria-label="Copy the code" className="pointer-coarse:size-11" onClick={copyCode}>
              <Copy />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {signIn.url ? (
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" nativeButton={false} render={<a href={signIn.url} target="_blank" rel="noreferrer" />}>
                Open Grok&apos;s page
                <ExternalLink data-icon="inline-end" />
              </Button>
            ) : null}
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner />
              Waiting for you to approve
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function GrokPlanCard({ ai, onAiChange }: { ai?: AiSettings | null; onAiChange?: (next: AiSettings) => void }) {
  const { providers, reload } = useProviders();
  const provider = providers?.grok ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Grok plan</CardTitle>
        <CardDescription>Run your bots on your SuperGrok or X Premium+ plan, with no key to keep.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!providers ? (
          <Spinner />
        ) : provider?.account ? (
          <PlanSignedIn kind="grok" logo={<GrokLogo size={18} />} provider={provider} ai={ai} onAiChange={onAiChange} onChange={() => void reload()} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            {provider?.check && !provider.check.ok ? <ProviderCheck provider={provider} /> : null}
            <SignInWithGrok onDone={() => void reload()} />
          </div>
        )}
        <p className="text-[12.5px] text-muted-foreground">What your bots do counts toward your Grok plan&apos;s usage limits. xAI decides which plans can be used outside Grok.</p>
      </CardContent>
    </Card>
  );
}
