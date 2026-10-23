"use client";

import { PROVIDER_LABELS, type PlanProviderKind, type ProviderMeta } from "@gond/shared";
import { ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ProviderCheck } from "@/components/providers-card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { del, post } from "@/lib/api";

/** A signed-in plan: who, whether it works, and how to leave. */
export function PlanSignedIn({
  kind,
  logo,
  usageUrl,
  provider,
  onChange,
}: {
  kind: PlanProviderKind;
  logo: ReactNode;
  usageUrl?: string;
  provider: ProviderMeta;
  onChange: () => void;
}) {
  const label = PROVIDER_LABELS[kind];
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);

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
            <AlertDialogDescription>Bots running on your {label.name} stop working until you sign in again or pick somewhere else for them to run.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onAction={async () => {
                await del(`/api/providers/${kind}`);
                await onChange();
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
