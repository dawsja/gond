"use client";

import { OIDC_PROVIDER_ID, type SignIns } from "@gond/shared";
import { Link2, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, post } from "@/lib/api";
import { authClient } from "@/lib/auth/client";
import { useNativeShell } from "@/lib/shell";

const BACK = "/app/settings/account";

function linkError(code: string, name: string): string {
  if (code === "account_already_linked_to_different_user") return `That ${name} sign-in already has its own Gond account, made the first time you signed in with it. Sign in with ${name}, then move it here from Settings → Account.`;
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
        else if (params.has("moved")) toast.add({ type: "success", title: `${name} now opens this account.` });
        else if (params.has("error")) toast.add({ type: "error", title: linkError(params.get("error") ?? "", name) });
        if (params.has("linked") || params.has("moved") || params.has("error")) window.history.replaceState(null, "", BACK);
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

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/**
 * The other way round: an account the provider made moving its sign-in to the account with a
 * password, proven by that password. What the provider's account held is deleted, and it says so first.
 */
export function MoveSignIn() {
  const [signIns, setSignIns] = useState<SignIns | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void api<SignIns>("/api/me/sign-ins")
      .then(setSignIns)
      .catch(() => undefined);
  }, []);

  if (!signIns?.move || !signIns.oidc) return null;
  const { name } = signIns.oidc;

  return (
    <div className="flex flex-col items-start gap-2 border-t pt-5">
      <p className="text-sm font-medium">Already have an account here?</p>
      <p className="text-[13.5px] text-muted-foreground">If this Gond has an account with a password that&apos;s yours, move your {name} sign-in to it. Signing in with {name} opens that account from then on.</p>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Link2 data-icon="inline-start" aria-hidden="true" />
        Move to my other account
      </Button>
      {open ? <MoveDialog contents={signIns.move} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function MoveDialog({ contents, onClose }: { contents: { bots: number; chats: number }; onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loses = contents.bots > 0 || contents.chats > 0;
  const held = [contents.bots ? plural(contents.bots, "bot") : "", contents.chats ? plural(contents.chats, "chat") : ""].filter(Boolean).join(" and ");
  const one = contents.bots + contents.chats === 1;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/me/sign-ins/move", { username, password, confirm: loses });
      // A full load, so nothing of the account that's gone stays in memory.
      window.location.replace(`${BACK}?moved=1`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't move it. Try again.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to your other account</DialogTitle>
          <DialogDescription>Sign in to it once to show it&apos;s yours.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="move-username">Username</FieldLabel>
              <Input id="move-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
            </Field>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="move-password">Password</FieldLabel>
              <Input id="move-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required aria-invalid={error ? true : undefined} />
            </Field>
            {loses ? (
              <Alert>
                <TriangleAlert aria-hidden="true" className="text-tone-warn" />
                <AlertTitle>This account isn&apos;t empty</AlertTitle>
                <AlertDescription>
                  The {held} in it {one ? "is" : "are"} deleted when you move. Export your chats first, further down this page, if you want a copy.
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-[13px] text-muted-foreground">The account you&apos;re in now has nothing in it, so it goes away.</p>
            )}
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant={loses ? "destructive" : "default"} disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Moving…" : loses ? "Delete it and move" : "Move sign-in"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
