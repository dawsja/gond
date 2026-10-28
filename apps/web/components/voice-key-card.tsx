"use client";

import { isXaiUrl } from "@gond/shared";
import { ManageKey, ProviderCheck, ProviderForm, useProviders } from "@/components/providers-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Settings → Voice: the one key the microphone and calls run on, kept apart from the bots' keys. */
export function VoiceKeyCard() {
  const { providers, reload } = useProviders();
  const provider = providers?.voice ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice key</CardTitle>
        <CardDescription>The microphone and calls run on this key, from OpenAI or xAI. Your bots never use it, and it never reaches the computer.</CardDescription>
      </CardHeader>
      <CardContent>
        {!providers ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : provider ? (
          <div className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14px] font-medium">{isXaiUrl(provider.baseUrl) ? "xAI" : "OpenAI-compatible"}</span>
              <code className="truncate font-mono text-[12px] text-muted-foreground">{provider.baseUrl}</code>
              <ProviderCheck provider={provider} />
            </div>
            <ManageKey kind="voice" provider={provider} onChange={() => void reload()} />
          </div>
        ) : (
          <ProviderForm kind="voice" provider={null} onSaved={() => void reload()} />
        )}
      </CardContent>
    </Card>
  );
}
