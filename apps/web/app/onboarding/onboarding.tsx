"use client";

import type { BotExpression } from "@gond/shared";
import { APP_CATALOG, BOT_TEMPLATES, ENGINE_LABELS, ENGINES, type AiSettings, type BoxStatus, type Engine, type EngineSettings } from "@gond/shared";
import { Check, LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppIcon } from "@/components/app-icons";
import { ContinueWithChatGpt } from "@/components/chatgpt-plan";
import { SignInWithGrok } from "@/components/grok-plan";
import { readiness } from "@/components/engine-card";
import { EngineSignInDialog } from "@/components/engine-signin";
import { ModelPicker } from "@/components/model-picker";
import { AddProviderKey, useProviders } from "@/components/providers-card";
import { GondBot } from "@/components/hq/gond-bot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, patch, post } from "@/lib/api";
import { cn } from "@/lib/utils";

type Step = "welcome" | "apps" | "team" | "ai";
const STEPS: Step[] = ["welcome", "apps", "team", "ai"];

const FLOATERS: { color: string; expression: BotExpression; className: string }[] = [
  { color: "#11998A", expression: "happy", className: "left-[8%] top-[18%]" },
  { color: "#D03A3A", expression: "wink", className: "left-[34%] top-[8%]" },
  { color: "#2F6FD6", expression: "happy", className: "right-[10%] top-[14%]" },
  { color: "#D98A08", expression: "surprised", className: "right-[22%] bottom-[16%]" },
  { color: "#7650D8", expression: "wink", className: "left-[16%] bottom-[12%]" },
];

function Floaters() {
  return (
    <>
      {FLOATERS.map((f, i) => (
        <span key={i} className={cn("pointer-events-none absolute hidden opacity-90 sm:block", f.className)} aria-hidden="true">
          <GondBot color={f.color} size={36} expression={f.expression} greet={false} />
        </span>
      ))}
    </>
  );
}

export function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [apps, setApps] = useState<string[]>([]);
  const [templates, setTemplates] = useState<string[]>(["assistant"]);
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ai, setAi] = useState<AiSettings | null>(null);
  const { providers, reload: reloadProviders } = useProviders();
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() =>
      api<{ ai: AiSettings }>("/api/ai")
        .then((d) => alive && setAi(d.ai))
        .catch(() => undefined),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function saveAi(next: { engine?: Engine; enabled?: Engine[]; engines?: Partial<Record<Engine, Partial<EngineSettings>>> }) {
    try {
      const data = await patch<{ ai: AiSettings }>("/api/ai", next);
      setAi(data.ai);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    }
  }

  useEffect(() => {
    if (step !== "ai") return;
    let alive = true;
    const check = () =>
      api<{ status: BoxStatus }>("/api/status?fresh=1")
        .then((d) => alive && setStatus(d.status))
        .catch(() => undefined);
    void Promise.resolve().then(check);
    const timer = window.setInterval(check, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [step]);

  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/onboarding/complete", { apps, templates, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      router.replace("/app");
      router.refresh();
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not finish setup.");
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10 text-foreground">
      <Floaters />
      <div className="flex w-full max-w-xl flex-col items-center">
        {step === "welcome" ? (
          <>
            <GondBot color="#189C47" size={120} expression="happy" />
            <h1 className="mt-6 text-center text-[28px] font-semibold tracking-[-0.56px]">Meet your team of bots</h1>
            <p className="mt-3 max-w-md text-center text-[15px] leading-6 text-muted-foreground">
              Each one has its own computer, job and memory. Give it real work; it comes back when it needs you.
            </p>
          </>
        ) : null}

        {step === "apps" ? (
          <>
            <h1 className="text-center text-[26px] font-semibold tracking-[-0.5px]">What do you use every day?</h1>
            <p className="mt-2 text-center text-[14px] text-muted-foreground">Your teammates get these apps once you connect them under Settings.</p>
            <ToggleGroup multiple variant="outline" aria-label="Apps" value={apps} onValueChange={setApps} className="mt-6 grid max-h-[46vh] w-full grid-cols-2 overflow-y-auto p-1 sm:grid-cols-3">
              {APP_CATALOG.map((app) => {
                const on = apps.includes(app.toolkit);
                return (
                  <ToggleGroupItem key={app.toolkit} value={app.toolkit} className="h-12 justify-start gap-2.5 rounded-xl bg-card px-3 text-[14px] font-medium hover:border-ash hover:bg-card data-pressed:border-control data-pressed:bg-card data-pressed:ring-1 data-pressed:ring-control aria-pressed:border-control aria-pressed:bg-card aria-pressed:ring-1 aria-pressed:ring-control">
                    <AppIcon toolkit={app.toolkit} logo={app.logo} size={22} />
                    <span className="flex-1 truncate text-left">{app.name}</span>
                    {on ? (
                      <span className="flex size-5 items-center justify-center rounded-full bg-control text-control-foreground">
                        <Check className="size-3" aria-hidden="true" />
                      </span>
                    ) : null}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </>
        ) : null}

        {step === "team" ? (
          <>
            <h1 className="text-center text-[26px] font-semibold tracking-[-0.5px]">Meet your first teammates</h1>
            <p className="mt-2 text-center text-[14px] text-muted-foreground">Pick a few to start with. You can create your own, and change any of them, later.</p>
            <FieldGroup className="mt-6 grid max-h-[50vh] grid-cols-1 gap-2 overflow-y-auto p-1 sm:grid-cols-2">
              {BOT_TEMPLATES.map((t) => (
                <FieldLabel key={t.id} htmlFor={`template-${t.id}`} className="bg-card">
                  <Field orientation="horizontal" className="items-start">
                    <GondBot color={t.color} size={40} expression={t.expression} greet={false} />
                    <FieldContent>
                      <FieldTitle>{t.name}</FieldTitle>
                      <FieldDescription className="text-[12.5px] leading-5">{t.tagline}</FieldDescription>
                    </FieldContent>
                    <Checkbox id={`template-${t.id}`} checked={templates.includes(t.id)} onCheckedChange={(on) => setTemplates(on ? [...templates, t.id] : templates.filter((v) => v !== t.id))} className="mt-0.5" />
                  </Field>
                </FieldLabel>
              ))}
            </FieldGroup>
          </>
        ) : null}

        {step === "ai" ? (
          <>
            <h1 className="text-center text-[26px] font-semibold tracking-[-0.5px]">Choose what your bots run on</h1>
            <p className="mt-2 max-w-md text-center text-[14px] leading-6 text-muted-foreground">Sign in to a plan, or add an API key. You can change this later under Settings → AI.</p>
            {!ai ? (
              <Spinner className="mt-6" />
            ) : (
              <AiStep ai={ai} status={status} providers={providers} onSave={saveAi} onProviderSaved={() => void reloadProviders()} />
            )}
          </>
        ) : null}

        {error ? <FieldError className="mt-4">{error}</FieldError> : null}

        <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
          {step === "ai" ? (
            <Button size="xl" onClick={() => void finish()} disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? "Setting up…" : "Finish"}
            </Button>
          ) : (
            <Button size="xl" onClick={next}>
              {step === "welcome" ? "Get started" : "Next"}
            </Button>
          )}
          {index > 0 ? (
            <Button variant="secondary" size="xl" onClick={back}>
              Back
            </Button>
          ) : null}
        </div>
        <Progress value={((index + 1) / STEPS.length) * 100} aria-label={`Step ${index + 1} of ${STEPS.length}`} className="mt-6 w-full max-w-xs">
          <span className="w-full text-center text-[12px] text-ash">
            Step {index + 1} of {STEPS.length}
          </span>
        </Progress>
      </div>
    </div>
  );
}

function AiStep({
  ai,
  status,
  providers,
  onSave,
  onProviderSaved,
}: {
  ai: AiSettings;
  status: BoxStatus | null;
  providers: ReturnType<typeof useProviders>["providers"];
  onSave: (next: { engine?: Engine; enabled?: Engine[]; engines?: Partial<Record<Engine, Partial<EngineSettings>>> }) => Promise<void>;
  onProviderSaved: () => void;
}) {
  const [signingIn, setSigningIn] = useState<Engine | null>(null);

  return (
    <FieldGroup className="mt-6 w-full gap-5">
      <Field>
        <FieldTitle>Engines</FieldTitle>
        <ToggleGroup aria-label="Engines" variant="pill" multiple value={ai.enabled} onValueChange={(next) => next.length && void onSave({ enabled: next as Engine[] })} className="flex-wrap">
          {ENGINES.map((engine) => (
            <ToggleGroupItem key={engine} value={engine} className="pointer-coarse:min-h-11">
              {ENGINE_LABELS[engine].name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>Turn on the ones you have. You can add more later.</FieldDescription>
      </Field>
      {ai.enabled.map((engine) => {
        const info = ENGINE_LABELS[engine];
        const ready = readiness(engine, status, providers, ai.engines[engine].provider);
        return (
          <Alert key={engine}>
            {ready.state === "ready" ? <Check className="text-mint" /> : ready.state === "waiting" ? <Spinner /> : null}
            <AlertTitle>{ready.state === "ready" ? `${info.name} is ready.` : ready.signIn ? `Sign in to ${info.name}` : `${info.name} isn't ready yet`}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              {ready.text}
              {engine === "chatgpt" && ready.state !== "ready" ? <ContinueWithChatGpt onDone={onProviderSaved} /> : null}
              {engine === "grok" && ready.state !== "ready" ? <SignInWithGrok onDone={onProviderSaved} /> : null}
              {ready.signIn ? (
                <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => setSigningIn(engine)}>
                  <LogIn data-icon="inline-start" />
                  Sign in to {info.name}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        );
      })}
      {providers ? (
        <AddProviderKey
          providers={providers}
          onSaved={(kind) => {
            onProviderSaved();

            void onSave({ engine: "api", enabled: [...new Set([...ai.enabled, "api" as Engine])], engines: { api: { provider: kind, access: "api" } } });
          }}
        />
      ) : (
        <Spinner />
      )}
      <Field>
        <FieldLabel htmlFor="model">Model</FieldLabel>
        <ModelPicker engine={ai.engine} model={ai.engines[ai.engine].model} onChange={(next) => void onSave({ engine: next.engine, engines: { [next.engine]: { model: next.model } } })} />
      </Field>
      <EngineSignInDialog engine={signingIn} onOpenChange={(open) => !open && setSigningIn(null)} />
    </FieldGroup>
  );
}
