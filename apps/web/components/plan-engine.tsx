"use client";

import { PROVIDER_LABELS, type AiSettings, type Engine, type PlanProviderKind, type ProviderMeta } from "@gond/shared";
import { ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ProviderCheck } from "@/components/providers-card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { del, patch, post } from "@/lib/api";

/** Turns a plan's engine on and puts the bots on it, or turns it off; the settings as saved, or null. */
export async function runOnPlan(ai: AiSettings, engine: PlanProviderKind & Engine, on: boolean): Promise<AiSettings | null> {
  const rest = ai.enabled.filter((name) => name !== engine);
  const body = on ? { engine, enabled: [...rest, engine] } : { enabled: rest.length ? rest : (["claude"] as Engine[]) };
  const data = await patch<{ ai: AiSettings }>("/api/ai", body).catch(() => null);
  return data?.ai ?? null;
}

/** A signed-in plan: who, whether it works, the switch that runs the bots on it, and how to leave. */
export function PlanSignedIn({
  kind,
  logo,
  usageUrl,
  provider,
  ai,
  onAiChange,
  onChange,
}: {
  kind: PlanProviderKind & Engine;
  logo: ReactNode;
  usageUrl?: string;
  provider: ProviderMeta;
  ai?: AiSettings | null;
  onAiChange?: (next: AiSettings) => void;
  onChange: () => void;
}) {
  const label = PROVIDER_LABELS[kind];
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const on = Boolean(ai?.enabled.includes(kind));

  async function check() {
    setChecking(true);
    await post(`/api/providers/${kind}/check`).catch(() => undefined);
    setChecking(false);
    onChange();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary-edge bg-primary">{logo}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-medium">{provider.account?.email ?? provider.account?.name ?? "Signed in"}</span>
          <ProviderCheck provider={provider} />
        </span>
      </div>
      {ai ? (
        <FieldGroup className="gap-2 rounded-lg border bg-muted/40 p-3">
          <Field orientation="horizontal" className="min-h-11">
            <FieldLabel htmlFor={`${kind}-run`} className="flex-1 font-normal">
              Run your bots on your {label.name}
            </FieldLabel>
            <Switch id={`${kind}-run`} checked={on} onCheckedChange={(next) => void runOnPlan(ai, kind, next).then((saved) => saved && onAiChange?.(saved))} />
          </Field>
          <FieldDescription>{on ? `On, your bots can run on your ${label.name}. Pick its model under Engine.` : "Off, they run on the other engines you turned on."}</FieldDescription>
        </FieldGroup>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {usageUrl ? (
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" nativeButton={false} render={<a href={usageUrl} target="_blank" rel="noreferrer" />}>
            Manage usage
            <ExternalLink data-icon="inline-end" />
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" disabled={checking} onClick={() => void check()}>
          {checking ? <Spinner data-icon="inline-start" /> : null}
          Check
        </Button>
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11 text-destructive" onClick={() => setLeaving(true)}>
          Sign out
        </Button>
      </div>
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of {label.short}?</AlertDialogTitle>
            <AlertDialogDescription>Bots running on your {label.name} stop working until you sign in again or switch them to another engine.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void del(`/api/providers/${kind}`).then(onChange)}>
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
