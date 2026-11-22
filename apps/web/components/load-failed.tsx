"use client";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
