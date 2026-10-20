"use client";

import { Button } from "@/components/ui/button";
import { changeServer, useNativeShell } from "@/lib/shell";

export function ChangeServer() {
  const shell = useNativeShell();
  if (!shell) return null;
  return (
    <Button variant="ghost" size="lg" className="mt-3 w-full" onClick={changeServer}>
      Use a different server
    </Button>
  );
}
