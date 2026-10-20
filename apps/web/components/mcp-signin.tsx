"use client";

import type { McpServer } from "@gond/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { post } from "@/lib/api";
import { desktopShell, mobileShell, useNativeShell } from "@/lib/shell";

export async function startMcpSignIn(server: Pick<McpServer, "id" | "oauthRedirect">, threadId?: string): Promise<boolean> {
  const loopback = server.oauthRedirect === "localhost";

  const tab = loopback && !mobileShell() ? window.open("about:blank", "_blank") : null;
  try {
    const { url } = await post<{ url: string }>(`/api/mcp-servers/${server.id}/login`, { threadId, app: desktopShell() ? "desktop" : undefined });
    if (tab) tab.location.href = url;
    else window.location.assign(url);
    return loopback;
  } catch (error) {
    tab?.close();
    throw error;
  }
}

export function McpPasteSignIn({ name, onDone }: { name: string; onDone?: (name: string) => void }) {
  const shell = useNativeShell();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !address.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const done = await post<{ name: string }>("/api/mcp-servers/oauth/complete", { url: address.trim() });
      onDone?.(done.name);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The sign-in didn't complete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="mcp-paste">Address the sign-in ended on</FieldLabel>
          <Input id="mcp-paste" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://localhost:47651/callback?code=…" className="font-mono text-[13px]" autoComplete="off" spellCheck={false} />
          <FieldDescription>
            {shell
              ? `Gond finishes the ${name} sign-in on its own when you're done. If it doesn't, copy the address of the page the sign-in ended on and paste it here.`
              : `${name} only sends sign-ins back to localhost, so the page it ends on won't load. That's expected: copy that page's whole address and paste it here.`}
          </FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || !address.trim()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Finish sign-in
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
