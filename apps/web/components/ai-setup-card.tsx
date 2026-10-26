"use client";

import type { Bot } from "@gond/shared";
import { BrainCircuit } from "lucide-react";
import Link from "next/link";
import { ActionCard } from "@/components/action-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * A turn that couldn't start because the bots have no AI to run on: where to set one up, then go again.
 * Without `onRetry` (the line wasn't the person's own) there is nothing to go again.
 */
export function AiSetupCard({ bot, reason, onRetry, retrying = false }: { bot: Bot | undefined; reason: string; onRetry?: () => void; retrying?: boolean }) {
  const said = reason.trim();
  // The reason may already say where to go.
  const points = /settings\s*→\s*ai/i.test(said);
  return (
    <ActionCard
      icon={<BrainCircuit aria-hidden="true" />}
      title="Your bots don't have an AI yet"
      by={onRetry ? `${bot?.name ?? "Your bot"} · your message is waiting` : `${bot?.name ?? "Your bot"} couldn't start`}
      actions={
        <>
          <Button size="xl" variant="tint" render={<Link href="/app/settings/ai" />} nativeButton={false}>
            Set up AI
          </Button>
          {onRetry ? (
            <Button size="xl" variant="outline" disabled={retrying} onClick={onRetry}>
              {retrying ? <Spinner data-icon="inline-start" /> : null}
              Try again
            </Button>
          ) : null}
        </>
      }
    >
      <p className="text-[13.5px] leading-5 text-muted-foreground">
        {said ? `${said}${/[.?]$/.test(said) ? "" : "."}` : ""}
        {points ? null : `${said ? " " : ""}Pick what your bots run on in Settings → AI, then try again.`}
      </p>
    </ActionCard>
  );
}
