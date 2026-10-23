"use client";

import { ENGINE_LABELS, ENGINES, PROVIDER_LABELS, isCliEngine, isPlanProvider, type AiSettings, type BoxStatus, type Engine, type EngineSettings, type ProviderKind, type ProviderMeta } from "@gond/shared";
import { Check, CircleDashed, RefreshCw, TriangleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChatGptAccount, ChatGptPlanLine } from "@/components/chatgpt-plan";
import { EngineSignInDialog } from "@/components/engine-signin";
import { GrokAccount, GrokPlanLine } from "@/components/grok-plan";
import { ModelPicker } from "@/components/model-picker";
import { KeyList, useProviders } from "@/components/providers-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { patch } from "@/lib/api";
import { cn } from "@/lib/utils";

export type Readiness = {
  state: "ready" | "waiting" | "problem";
  text: string;

  signIn?: Engine;
};

export function providerFor(engine: Engine, providers: Record<ProviderKind, ProviderMeta | null> | null, chosen?: ProviderKind | null): ProviderKind {
  const info = ENGINE_LABELS[engine];
  if (chosen && info.providers.includes(chosen)) return chosen;
  return info.providers.find((kind) => providers?.[kind]) ?? info.provider;
}

export function readiness(engine: Engine, status: BoxStatus | null, providers: Record<ProviderKind, ProviderMeta | null> | null, chosen?: ProviderKind | null): Readiness {
  if (!isCliEngine(engine)) {
    const kind = providerFor(engine, providers, chosen);
    const provider = providers?.[kind];
    if (!providers) return { state: "waiting", text: "Checking…" };
    if (isPlanProvider(kind) && !provider?.account) return { state: "problem", text: provider?.check?.detail ?? `Not signed in yet. Sign in under ${PROVIDER_LABELS[kind].name}.` };
    if (!provider) return { state: "problem", text: "No API key saved yet. Add one below." };
    if (provider.check && !provider.check.ok) return { state: "problem", text: provider.check.detail };
    if (isPlanProvider(kind)) return { state: "ready", text: `Runs on your ${PROVIDER_LABELS[kind].name}${provider.account?.email ? `, signed in as ${provider.account.email}` : ""}.` };
    return { state: "ready", text: `Runs on your ${PROVIDER_LABELS[kind].short} key at ${provider.baseUrl}.` };
  }
  if (!status) return { state: "waiting", text: "Checking the computer…" };
  if (!status.configured || !status.reachable) return { state: "problem", text: "The computer isn't reachable, so the sign-in can't be checked." };
  const notYet: Readiness = { state: "waiting", text: "Not signed in yet.", signIn: engine };
  if (status.claude.status === "ok") return { state: "ready", text: `Signed in${status.claude.email ? ` as ${status.claude.email}` : ""} on the computer.` };
  if (status.claude.status === "missing") return { state: "problem", text: "Claude Code isn't installed on the computer. Updating the computer (the admin can, under Settings → Shared computer) puts it back." };
  return notYet;
}

const PLACES: Record<Engine, { label: string; detail: string; tail: string; note: string; step: string }> = {
  claude: {
    label: "Claude Code",
    detail: "On your Claude plan. Best at long, multi-step work.",
    tail: ", on your Claude plan.",
    note: "Anthropic's agent, run on the computer. Best at long, multi-step work, and the only one that runs MCP servers that start a command.",
    step: "Sign in to your Claude plan",
  },
  chatgpt: {
    label: "ChatGPT",
    detail: "On your ChatGPT plan.",
    tail: ", on your ChatGPT plan.",
    note: "Gond runs the model itself. Your bots still have the computer and its browser.",
    step: "Sign in to your ChatGPT plan",
  },
  grok: {
    label: "Grok",
    detail: "On your Grok plan.",
    tail: ", on your Grok plan.",
    note: "Gond runs the model itself. Your bots still have the computer and its browser.",
    step: "Sign in to your Grok plan",
  },
  api: {
    label: "An API key",
    detail: "Anthropic, OpenAI or xAI. Pay per use.",
    tail: ", paid per use.",
    note: "Gond calls your key itself. Your bots still have the computer and its browser.",
    step: "Pick the key",
  },
};

type AiPatch = { engine?: Engine; enabled?: Engine[]; engines?: Partial<Record<Engine, Partial<EngineSettings>>> };

function Step({ n, state, title, children }: { n: number; state: "done" | "active" | "waiting"; title: string; children: ReactNode }) {
  return (
    <Card className={cn(state === "waiting" && "opacity-60")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
              state === "waiting" ? "border border-primary-edge text-muted-foreground" : "bg-control text-control-foreground",
            )}
          >
            {state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : n}
          </span>
          <span className="sr-only">{state === "done" ? `Step ${n}, done: ` : `Step ${n}: `}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function ClaudeAccount({ ready, onRefresh }: { ready: Readiness; onRefresh: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  async function check() {
    setChecking(true);
    await onRefresh().catch(() => undefined);
    setChecking(false);
  }

  const Icon = ready.state === "ready" ? Check : ready.state === "problem" ? TriangleAlert : CircleDashed;
  return (
    <>
      <p className="text-[14px]">Claude Code runs on the computer and signs in there, with your Claude Pro or Max plan. There is no key to keep.</p>
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border p-3 pl-4">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full bg-muted", ready.state === "ready" && !checking && "text-mint", ready.state === "problem" && !checking && "text-destructive")}>
          {checking ? <Spinner /> : <Icon className="size-4" aria-hidden="true" />}
        </span>
        <span aria-live="polite" className={cn("min-w-40 flex-1 text-[14px] font-medium", ready.state === "problem" && !checking && "text-destructive")}>
          {checking ? "Checking the computer…" : ready.text}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {ready.signIn && !checking ? (
            <Button size="lg" className="pointer-coarse:min-h-11" onClick={() => setSigningIn(true)}>
              Sign in to {ENGINE_LABELS.claude.name}
            </Button>
          ) : null}
          <Button variant="outline" size="icon-lg" className="pointer-coarse:size-11" aria-label="Check the sign-in again" title="Check again" disabled={checking} onClick={() => void check()}>
            <RefreshCw className={cn(checking && "animate-spin motion-reduce:animate-none")} />
          </Button>
        </span>
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        {ready.state === "ready" ? "What your bots do counts toward your Claude plan's usage limits." : "Signed in from a terminal on the computer instead? Tap the circle to check again."}
      </p>
      <EngineSignInDialog engine={signingIn ? "claude" : null} onOpenChange={(open) => !open && setSigningIn(false)} onDone={() => void check()} />
    </>
  );
}

/** Settings → AI: where the bots run, the account behind it, and the model, in that order. */
export function AiSteps({ ai, status, onChange, onRefresh }: { ai: AiSettings; status: BoxStatus | null; onChange: (next: AiSettings) => void; onRefresh: () => Promise<void> }) {
  const { providers, reload } = useProviders();
  const params = useSearchParams();
  const [choice, setChoice] = useState<Engine | null>(() => (params.get("chatgpt") === "1" ? "chatgpt" : null));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const engine = choice ?? ai.engine;
  const pending = engine !== ai.engine;
  const ready = readiness(engine, status, providers, ai.engines[engine].provider);
  const keyKind = providerFor("api", providers, ai.engines.api.provider);

  const save = useCallback(
    async (next: AiPatch) => {
      setSaving(true);
      setError(null);
      try {
        const data = await patch<{ ai: AiSettings }>("/api/ai", next);
        onChange(data.ai);
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Couldn't save.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [onChange],
  );

  // The bots move only once the account behind the new place works, so they never sit on one that can't answer.
  const switching = useRef(false);
  useEffect(() => {
    if (!pending || ready.state !== "ready" || switching.current) return;
    switching.current = true;
    void Promise.resolve().then(async () => {
      const ok = await save({ engine, enabled: [engine], ...(engine === "api" ? { engines: { api: { provider: keyKind, access: "api" } } } : {}) });
      switching.current = false;
      if (ok) setChoice(null);
    });
  }, [pending, ready.state, engine, keyKind, save]);

  const stepTwoDone = ready.state === "ready";
  const modelReady = !pending && stepTwoDone;
  const stayingOn = ai.engine === "api" ? "your API key" : ENGINE_LABELS[ai.engine].name;
  const waitText =
    ready.state === "waiting" && !ready.signIn ? "Checking…" : engine === "api" ? "Add a key first, then pick from its models" : "Sign in first, then pick from your plan's models";

  return (
    <div className="flex flex-col gap-4">
      <Step n={1} state="active" title="Where should your bots run?">
        <div className="text-xl leading-loose font-medium">
          On{" "}
          <Select
            items={ENGINES.map((value) => ({ value, label: PLACES[value].label }))}
            value={engine}
            disabled={saving}
            onValueChange={(value) => {
              if (!value) return;
              setError(null);
              setChoice(value === ai.engine ? null : (value as Engine));
            }}
          >
            <SelectTrigger size="lg" aria-label="Where your bots run" className="mx-0.5 inline-flex align-middle">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {ENGINES.map((value) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex flex-col gap-0.5 whitespace-normal">
                      <span className="font-medium">{PLACES[value].label}</span>
                      <span className="text-[12px] text-muted-foreground">{PLACES[value].detail}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {PLACES[engine].tail}
        </div>
        <p className="text-[13px] text-muted-foreground">{PLACES[engine].note}</p>
        {pending ? <p className="text-[13px] font-medium">Your bots stay on {stayingOn} until this is set up.</p> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </Step>

      <Step n={2} state={stepTwoDone ? "done" : "active"} title={PLACES[engine].step}>
        {engine === "claude" ? <ClaudeAccount ready={ready} onRefresh={onRefresh} /> : null}
        {engine === "chatgpt" ? <ChatGptAccount providers={providers} reload={() => void reload()} /> : null}
        {engine === "grok" ? <GrokAccount providers={providers} reload={() => void reload()} /> : null}
        {engine === "api" ? (
          providers ? (
            <KeyList providers={providers} chosen={keyKind} onPick={(kind) => void save({ engines: { api: { provider: kind, access: "api" } } })} onChange={() => void reload()} />
          ) : (
            <Spinner />
          )
        ) : null}
      </Step>

      <Step n={3} state={modelReady ? "active" : "waiting"} title="Pick a model">
        {modelReady ? (
          <Field data-disabled={saving || undefined}>
            <ModelPicker engine={ai.engine} model={ai.engines[ai.engine].model} only disabled={saving} onChange={(next) => void save({ engine: next.engine, engines: { [next.engine]: { model: next.model } } })} />
            {ai.engine === "chatgpt" ? (
              <FieldDescription>
                <ChatGptPlanLine />
              </FieldDescription>
            ) : ai.engine === "grok" ? (
              <FieldDescription>
                <GrokPlanLine />
              </FieldDescription>
            ) : null}
          </Field>
        ) : (
          <p className="flex min-h-10 max-w-sm items-center rounded-full border border-dashed border-primary-edge px-4 text-[13px] text-muted-foreground">{pending && ready.state === "ready" ? "Moving your bots…" : waitText}</p>
        )}
      </Step>
    </div>
  );
}
