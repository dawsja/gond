"use client";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** In place of what didn't load: says so, with Try again, so a card never waits on a spinner forever. */
export function LoadFailed({ what, onRetry, className }: { what: string; onRetry: () => void; className?: string }) {
  return (
    <Alert className={className}>
      <AlertTitle>Couldn&apos;t load {what}.</AlertTitle>
      <AlertDescription>Check your connection, then try again.</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}
