"use client";

import { OIDC_PROVIDER_ID, type SignIns } from "@gond/shared";
import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth/client";
import { useNativeShell } from "@/lib/shell";

const BACK = "/app/settings/account";

function linkError(code: string, name: string): string {
  if (code === "account_already_linked_to_different_user") return `That ${name} sign-in already has its own Gond account, made the first time you signed in with it. Remove that account under Settings → Authentication, then link again.`;
  if (code === "unable_to_link_account") return `${name} didn't confirm your email, so Gond couldn't link it. Ask whoever runs ${name} to mark your email as verified, then try again.`;
  return `Couldn't link ${name}. Try again.`;
}

/**
 * The local account moving to the organisation's provider without starting over: linking its sign-in
 * here means signing in with it lands in this same account, bots, chats and all.
 */
export function LinkedSignIn() {
  const [signIns, setSignIns] = useState<SignIns | null>(null);
  const [busy, setBusy] = useState(false);
  const shell = useNativeShell();

  useEffect(() => {
    void api<SignIns>("/api/me/sign-ins")
      .then((loaded) => {
        setSignIns(loaded);
        // Back from the provider: say how it went, once, and drop it from the address.
        const params = new URLSearchParams(window.location.search);
        const name = loaded.oidc?.name ?? "your provider";
        if (params.has("linked")) toast.add({ type: "success", title: `${name} is linked.`, description: "Sign in with it from now on and you land here." });
        else if (params.has("error")) toast.add({ type: "error", title: linkError(params.get("error") ?? "", name) });
        if (params.has("linked") || params.has("error")) window.history.replaceState(null, "", BACK);
      })
      .catch(() => undefined);
  }, []);

  if (!signIns?.password || !signIns.oidc) return null;
  const { name, linked } = signIns.oidc;

  async function link() {
    if (busy) return;
    setBusy(true);
    const { error } = await authClient.linkSocial({ provider: OIDC_PROVIDER_ID as "github", callbackURL: `${BACK}?linked=1`, errorCallbackURL: BACK });
    if (error) {
      setBusy(false);
      toast.add({ type: "error", title: `Couldn't reach ${name}. Try again.` });
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 border-t pt-5">
      <p className="text-sm font-medium">Sign in with {name}</p>
      <p className="text-[13.5px] text-muted-foreground">
        {linked
          ? `Linked. Signing in with ${name} or your password opens this same account.`
          : `Link it to sign in with ${name} from now on, into this same account, with your bots and chats as they are. Your password keeps working.`}
      </p>
      {linked ? null : shell ? (
        <p className="text-[13.5px] text-muted-foreground">Link it from Gond in a web browser.</p>
      ) : (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void link()}>
          {busy ? <Spinner data-icon="inline-start" /> : <Link2 data-icon="inline-start" aria-hidden="true" />}
          {busy ? "Taking you there…" : `Link ${name}`}
        </Button>
      )}
    </div>
  );
}
